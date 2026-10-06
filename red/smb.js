/*
Copyright 2018 Smart-Tech Controle e Automação
Copyright 2023 Y., Ryota <tryjsky@gmail.com>
Copyright 2024 Delevin888
Copyright 2026 node-red-contrib-smb2-plus contributors
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/* jshint node: true, esversion: 8 */
"use strict";

const SMB2 = require("@tryjsky/v9u-smb2");
const util = require("./lib/util");
require("./lib/access").apply(); // request "Modify" rights instead of "Full control"

const MAX_QUEUE = 1000;
const RETRY_BASE_DELAY_MS = 500;

function toNumber(v, def) {
    const n = Number(v);
    return v === "" || v === undefined || v === null || !isFinite(n) || n < 0 ? def : n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = function (RED) {

    /* ================================================================ */
    /* CONFIG NODE                                                       */
    /* ================================================================ */

    function SmbConfig(values) {
        RED.nodes.createNode(this, values);
        const node = this;
        const creds = node.credentials || {};

        // Credentials are stored encrypted (credentials.user / credentials.pass).
        // values.username / values.password are read only to keep flows made
        // with the original package working until the config node is re-saved.
        const auth = util.splitUser(creds.user || values.username || "", values.domain || "");
        const password = creds.pass || values.password || "";
        const domain = auth.domain || ".";

        node.opTimeout = toNumber(values.timeout, 60) * 1000;      // per operation
        node.idleTimeout = toNumber(values.idleTimeout, 30) * 1000; // close idle sessions
        node.retries = Math.floor(toNumber(values.retries, 1));
        node.maxReadBytes = toNumber(values.maxReadMB, 100) * 1024 * 1024;

        try {
            node.target = util.parseShare(values.share);
            const port = toNumber(values.port, 0);
            if (port > 0) node.target.port = port;
            if (!node.target.port) node.target.port = 445;
        } catch (e) {
            node.configError = e;
            node.error(e.message);
        }

        let client = null;
        let queue = Promise.resolve();
        let pending = 0;
        let running = false;
        let closing = false;
        let idleTimer = null;

        function dispose(c, reason) {
            if (!c) return;
            c.__dead = true;
            c.__deadReason = c.__deadReason || reason;
            try { c.disconnect(); } catch (e) { /* ignore */ }
            try { c.socket.destroy(); } catch (e) { /* ignore */ }
        }

        function resetClient(reason) {
            const c = client;
            client = null;
            if (c) {
                node.debug(`SMB session reset (${reason})`);
                dispose(c, reason);
            }
        }

        function createClient() {
            const t = node.target;
            const c = new SMB2({
                share: t.unc,
                port: t.port,
                domain: domain,
                username: auth.username,
                password: password,
                autoCloseTimeout: 0, // idle handling is done here, with a fresh client every time
            });
            const sock = c.socket;
            try { sock.setKeepAlive(true, 30000); } catch (e) { /* ignore */ }
            try { sock.setNoDelay(true); } catch (e) { /* ignore */ }

            // The library never notices when the server closes the socket and
            // keeps thinking it is connected. Mark the client dead instead.
            const markDead = (why) => () => {
                if (c.__dead) return;
                dispose(c, why);
                if (client === c) client = null;
            };
            sock.on("end", markDead("server closed the connection"));
            sock.on("close", markDead("socket closed"));

            // A malformed response would throw inside the socket "data" event and
            // crash the whole Node-RED process. Contain it.
            const dataListeners = sock.listeners("data");
            sock.removeAllListeners("data");
            sock.on("data", (chunk) => {
                try {
                    for (const l of dataListeners) l.call(sock, chunk);
                } catch (e) {
                    c.__protocolError = e;
                    node.warn(`SMB protocol error, resetting connection: ${e.message}`);
                    markDead("protocol error")();
                }
            });
            return c;
        }

        function getClient() {
            if (!client || client.__dead) client = createClient();
            return client;
        }

        function clearIdle() {
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }

        function scheduleIdle() {
            clearIdle();
            if (node.idleTimeout > 0 && !closing) {
                idleTimer = setTimeout(() => {
                    idleTimer = null;
                    if (!running && pending === 0) resetClient("idle");
                }, node.idleTimeout);
            }
        }

        // One attempt of a task with a hard timeout. Rejects as soon as the
        // socket dies instead of waiting forever for a response that never comes.
        function execOnce(task) {
            clearIdle();
            if (closing) return Promise.reject(util.smbError("SMB_CLOSING", "SMB config node is closing"));
            let c;
            try {
                c = getClient();
            } catch (e) {
                return Promise.reject(e);
            }
            running = true;
            // Remember where the request counter was, to know afterwards whether a
            // request of this operation reached the wire: a non-idempotent operation
            // that failed after that point may already have been executed.
            const startConnected = !!c.connected;
            const startMessageId = c.messageId;
            return new Promise((resolve, reject) => {
                let finished = false;
                let timer = null;
                const onDead = () => {
                    const pe = c.__protocolError;
                    finish(pe
                        ? util.smbError("SMB_PROTOCOL_ERROR", `SMB protocol error: ${pe.message}`)
                        : util.smbError("SMB_SOCKET_CLOSED", `SMB connection lost (${c.__deadReason || "socket closed"})`));
                };
                const finish = (err, val) => {
                    if (finished) return;
                    finished = true;
                    if (timer) clearTimeout(timer);
                    c.socket.removeListener("close", onDead);
                    c.socket.removeListener("end", onDead);
                    running = false;
                    if (err) {
                        if (!(err instanceof Error)) err = new Error(String(err));
                        err.smbConnected = !!c.connected && !c.__dead;
                        err.smbRequestSent = startConnected
                            ? c.messageId !== startMessageId
                            : !!c.connected; // handshake done: the request is sent right after it
                        reject(err);
                    } else {
                        resolve(val);
                    }
                    scheduleIdle();
                };
                c.socket.once("close", onDead);
                c.socket.once("end", onDead);
                if (node.opTimeout > 0) {
                    timer = setTimeout(() => finish(util.smbError("SMB_TIMEOUT",
                        `SMB operation timed out after ${node.opTimeout / 1000}s`)), node.opTimeout);
                }
                Promise.resolve()
                    .then(() => task(c))
                    .then((v) => finish(null, v), (e) => finish(e || new Error("Unknown SMB error")));
            });
        }

        async function execWithRetry(task, idempotent) {
            let attempt = 0;
            for (;;) {
                try {
                    return await execOnce(task);
                } catch (err) {
                    const decision = util.classifyError(err);
                    if (decision.reset) resetClient(err.code || err.message);
                    // Non-idempotent operations (append, create, rename, delete...) are
                    // only retried when the server certainly did not execute them.
                    const safe = idempotent || !err.smbRequestSent || util.isSessionError(err);
                    if (decision.retry && safe && attempt < node.retries && !closing) {
                        attempt++;
                        node.debug(`Retrying SMB operation after ${err.code || err.message} (attempt ${attempt})`);
                        await sleep(RETRY_BASE_DELAY_MS * attempt);
                        continue;
                    }
                    throw err;
                }
            }
        }

        /**
         * Runs task(client) through a FIFO queue: the library is not safe for
         * concurrent use (parallel handshakes, errors delivered to the wrong
         * caller), so operations sharing this config run one at a time.
         * idempotent=false limits automatic retries (see execWithRetry).
         */
        node.run = function run(task, idempotent) {
            if (node.configError) return Promise.reject(node.configError);
            if (closing) return Promise.reject(util.smbError("SMB_CLOSING", "SMB config node is closing"));
            if (pending >= MAX_QUEUE) {
                return Promise.reject(util.smbError("SMB_QUEUE_FULL",
                    `Too many pending SMB operations (${MAX_QUEUE}). Is the server reachable?`));
            }
            pending++;
            const job = queue.then(() => execWithRetry(task, idempotent !== false));
            const dec = () => { pending--; };
            queue = job.then(dec, dec);
            return job;
        };

        node.pendingCount = () => pending;
        node.resolvePath = (p) => {
            if (node.configError) throw node.configError;
            return util.resolvePath(node.target, p);
        };

        /* ---------------- operations ---------------- */

        node.ops = {
            readDir(path, opts) {
                return node.run(async (c) => {
                    if (opts && opts.detailed) {
                        const list = await c.readdir(path, { stats: true });
                        return list.map((st) => util.plainStat(st, st.name,
                            path ? `${path}\\${st.name}` : st.name));
                    }
                    return c.readdir(path);
                });
            },

            readFile(path) {
                return node.run(async (c) => {
                    const st = await c.stat(path);
                    if (st.isDirectory()) {
                        throw util.smbError("SMB_IS_DIRECTORY", `"${path}" is a directory, not a file`);
                    }
                    if (node.maxReadBytes > 0 && st.size > node.maxReadBytes) {
                        throw util.smbError("SMB_FILE_TOO_LARGE",
                            `"${path}" is ${(st.size / 1048576).toFixed(1)} MB, above the configured limit of ` +
                            `${node.maxReadBytes / 1048576} MB`);
                    }
                    return c.readFile(path);
                });
            },

            writeFile(path, payload, mode, encoding) {
                return node.run(async (c) => {
                    if (mode === "append") {
                        let existing = null;
                        if (await c.exists(path)) existing = await c.readFile(path);
                        const hasContent = !!(existing && existing.length);
                        const data = util.payloadToBuffer(payload, encoding, !hasContent);
                        const out = hasContent ? Buffer.concat([existing, data]) : data;
                        return c.writeFile(path, out, { flag: "w" });
                    }
                    const data = util.payloadToBuffer(payload, encoding, true);
                    return c.writeFile(path, data, { flag: mode === "overwrite" ? "w" : "wx" });
                }, mode === "overwrite");
            },

            unlink(path) { return node.run((c) => c.unlink(path), false); },
            mkdir(path) { return node.run((c) => c.mkdir(path), false); },
            rmdir(path) { return node.run((c) => c.rmdir(path), false); },
            exists(path) { return node.run((c) => c.exists(path)); },

            rename(oldPath, newPath, overwrite) {
                return node.run((c) => c.rename(oldPath, newPath, { replace: !!overwrite }), false);
            },

            ensureDir(path) {
                return node.run(async (c) => {
                    if (!path) return null;
                    if (await c.exists(path)) return null;
                    const parts = path.split("\\");
                    let current = "";
                    for (const part of parts) {
                        current = current ? `${current}\\${part}` : part;
                        try {
                            await c.mkdir(current);
                        } catch (e) {
                            if (e && e.code === "STATUS_OBJECT_NAME_COLLISION") continue;
                            throw e;
                        }
                    }
                    return null;
                });
            },

            info(path) {
                return node.run(async (c) => {
                    const st = await c.stat(path);
                    const name = path ? path.split("\\").pop() : "";
                    return util.plainStat(st, name, path);
                });
            },
        };

        node.on("close", function (removed, done) {
            closing = true;
            clearIdle();
            resetClient("node closed");
            done();
        });
    }

    RED.nodes.registerType("smb config", SmbConfig, {
        credentials: {
            user: { type: "text" },
            pass: { type: "password" },
        },
    });

    /* ================================================================ */
    /* OPERATION NODE                                                    */
    /* ================================================================ */

    const OPERATIONS = ["read-dir", "read-file", "unlink", "rename", "create",
        "mkdir", "rmdir", "exists", "ensure-dir", "info"];
    const NEEDS_PATH = new Set(["read-file", "unlink", "rename", "create", "mkdir", "rmdir"]);

    function SmbFunction(values) {
        RED.nodes.createNode(this, values);
        const node = this;

        node.config = RED.nodes.getNode(values.config);
        node.operation = values.operation || "read-dir";
        node.path = values.path || "";
        node.newPath = values.path_new || "";
        node.format = values.format || "string";
        node.encoding = values.encoding || "utf8";
        node.mode = values.mode || "create";
        node.overwrite = values.overwrite === true || values.overwrite === "true";
        node.detailed = values.detailed === true || values.detailed === "true";

        if (!node.config) {
            node.status({ fill: "red", shape: "ring", text: "no config" });
            node.error("Missing or invalid SMB endpoint configuration");
            return;
        }

        let active = 0;
        node.status({});

        function busy() {
            const q = Math.max(active, node.config.pendingCount ? node.config.pendingCount() : 0);
            node.status({ fill: "blue", shape: "dot", text: q > 1 ? `busy (${q} pending)` : "busy" });
        }

        async function execute(operation, msg) {
            const cfg = node.config;

            if (!OPERATIONS.includes(operation)) {
                throw util.smbError("SMB_UNKNOWN_OPERATION", `Unknown SMB operation "${operation}"`);
            }

            const raw = node.path || (msg.filename !== undefined && msg.filename !== null ? msg.filename : "");
            const path = cfg.resolvePath(raw);

            if (NEEDS_PATH.has(operation) && !path) {
                throw util.smbError("SMB_PATH_REQUIRED",
                    `Operation "${operation}" needs a path (node Path or msg.filename)`);
            }

            switch (operation) {
                case "read-dir":
                    msg.payload = await cfg.ops.readDir(path, { detailed: node.detailed });
                    break;

                case "read-file": {
                    const data = await cfg.ops.readFile(path);
                    const format = msg.encoding || node.format;
                    msg.payload = format === "binary" ? data : util.decodeText(data, format);
                    break;
                }

                case "unlink":
                    await cfg.ops.unlink(path);
                    break;

                case "rename": {
                    const rawNew = node.newPath ||
                        (msg.new_filename !== undefined && msg.new_filename !== null ? msg.new_filename : "");
                    const newPath = cfg.resolvePath(rawNew);
                    if (!newPath) {
                        throw util.smbError("SMB_PATH_REQUIRED",
                            "Rename needs a new path (node New path or msg.new_filename)");
                    }
                    await cfg.ops.rename(path, newPath, node.overwrite);
                    break;
                }

                case "create": {
                    const payload = Object.prototype.hasOwnProperty.call(msg, "payload") ? msg.payload : "";
                    await cfg.ops.writeFile(path, payload, node.mode, msg.encoding || node.encoding);
                    break;
                }

                case "mkdir":
                    await cfg.ops.mkdir(path);
                    break;

                case "rmdir":
                    await cfg.ops.rmdir(path);
                    break;

                case "exists":
                    msg.exists = await cfg.ops.exists(path);
                    break;

                case "ensure-dir":
                    await cfg.ops.ensureDir(path);
                    break;

                case "info":
                    msg.payload = await cfg.ops.info(path);
                    break;
            }
            return msg;
        }

        node.on("input", function (msg, send, done) {
            // Node-RED < 1.0 compatibility
            send = send || function () { node.send.apply(node, arguments); };
            done = done || function (err) { if (err) node.error(err, msg); };

            const operation = node.operation === "msg" ? msg.operation : node.operation;
            active++;
            busy();

            Promise.resolve()
                .then(() => execute(operation, msg))
                .then((out) => {
                    if (out && out.smbError) delete out.smbError; // left over from a previous failure
                    active--;
                    if (active === 0) node.status({ fill: "green", shape: "dot", text: "done" });
                    else busy();
                    send(out);
                    done();
                })
                .catch((err) => {
                    // Node-RED < 4 does not copy err.code into msg.error: expose it in every version
                    msg.smbError = { code: (err && err.code) || "SMB_ERROR", message: (err && err.message) || String(err) };
                    active--;
                    const text = String((err && (err.code || err.message)) || "error").slice(0, 40);
                    node.status({ fill: "red", shape: "dot", text: text });
                    done(err);
                });
        });

        node.on("close", function () {
            node.status({});
        });
    }

    RED.nodes.registerType("SMB", SmbFunction);
};
