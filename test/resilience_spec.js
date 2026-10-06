"use strict";
/*
 * Timeouts, retries, reconnection and queue behaviour, using a TCP proxy that
 * simulates network failures between Node-RED and a real Samba server.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const TestProxy = require("./helpers/proxy");
const { helper, env, share, load, call, callMany, unhandled } = require("./helpers/harness");

const TMP = path.join(env.root, "tmp-res");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = async (fn) => { const t = Date.now(); const r = await fn(); return [r, Date.now() - t]; };

describe("SMB node: timeouts, retries and reconnection", function () {
    this.timeout(60000);
    let proxy;

    before(async function () {
        if (!(await env.available())) return this.skip();
        fs.rmSync(TMP, { recursive: true, force: true });
        fs.mkdirSync(TMP);
        fs.chmodSync(TMP, 0o777);
        for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(TMP, `f${i}.txt`), "v" + i);
    });
    afterEach(async function () {
        await helper.unload();
        if (proxy) { await proxy.stop(); proxy = null; }
    });
    after(function () { assert.deepStrictEqual(unhandled, [], "unhandled promise rejections"); });

    const viaProxy = (extra) => Object.assign({ share: share(proxy.port) }, extra);

    /* ---------------- operation timeout ---------------- */

    describe("operation timeout", function () {
        it("server that never answers: SMB_TIMEOUT after the configured time, 1 attempt with retries=0", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 1, retries: 0 }));
            const [r, ms] = await elapsed(() => call({}));
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            assert.ok(ms >= 950 && ms < 2000, `took ${ms}ms`);
            assert.strictEqual(proxy.connections, 1);
        });

        it("timeout is measured per attempt and each retry uses a new connection", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 1, retries: 2 }));
            const [r, ms] = await elapsed(() => call({}));
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            // 3 attempts x 1s + backoff 0.5s + 1s
            assert.ok(ms >= 4300 && ms < 6500, `took ${ms}ms`);
            assert.strictEqual(proxy.connections, 3);
        });

        it("decimal timeout values work (0.5 s)", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 0.5, retries: 0 }));
            const [r, ms] = await elapsed(() => call({}));
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            assert.ok(ms >= 450 && ms < 1500, `took ${ms}ms`);
        });

        it("timeout 0 disables the limit; closing the flow releases the pending operation", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 0, retries: 0 }));
            let settled = false;
            const p = call({}).then((r) => { settled = true; return r; });
            await sleep(2500);
            assert.strictEqual(settled, false, "must still be waiting without a timeout");
            await helper.unload();
            await sleep(200);
            p.catch(() => {}); // the flow is gone, the result may never be delivered: just no crash / leak
        });

        it("a slow but alive server is not cut by the timeout", async function () {
            proxy = await new TestProxy().start();
            proxy.delayMs = 150; // every response chunk delayed
            await load(viaProxy({ timeout: 5, retries: 0 }), { operation: "read-file" });
            const r = await call({ filename: "tmp-res\\f1.txt" });
            assert.strictEqual(r.msg.payload, "v1", JSON.stringify(r.error));
        });

        it("idle timer never closes the session in the middle of a slow operation", async function () {
            proxy = await new TestProxy().start();
            proxy.delayMs = 400;
            await load(viaProxy({ timeout: 10, retries: 0, idleTimeout: 0.3 }), { operation: "read-file" });
            const r = await call({ filename: "tmp-res\\f2.txt" });
            assert.strictEqual(r.msg.payload, "v2", JSON.stringify(r.error));
            assert.strictEqual(proxy.connections, 1);
        });
    });

    /* ---------------- retries ---------------- */

    describe("retries", function () {
        it("server hangs mid-session: idempotent read is retried on a new connection and succeeds", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 1 }), { operation: "read-file" });
            assert.strictEqual((await call({ filename: "tmp-res\\f0.txt" })).msg.payload, "v0");
            proxy.freezeExisting();
            const [r, ms] = await elapsed(() => call({ filename: "tmp-res\\f3.txt" }));
            assert.strictEqual(r.msg && r.msg.payload, "v3", JSON.stringify(r.error));
            assert.ok(ms >= 1000, `took ${ms}ms`);
            assert.strictEqual(proxy.connections, 2);
        });

        it("retries=0 disables retrying", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 0 }));
            await call({});
            proxy.freezeExisting();
            const r = await call({});
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            assert.strictEqual(proxy.connections, 1);
            // and the next message opens a fresh session
            const r2 = await call({});
            assert.ok(Array.isArray(r2.msg.payload));
            assert.strictEqual(proxy.connections, 2);
        });

        it("append is NOT retried after the request was sent (no duplicated lines)", async function () {
            const file = path.join(TMP, "append.log");
            fs.writeFileSync(file, "first\n");
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 3 }), { operation: "create", mode: "append", path: "tmp-res\\append.log" });
            await call({ payload: "second\n" });
            proxy.freezeExisting();
            const r = await call({ payload: "third\n" });
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            assert.strictEqual(proxy.connections, 1, "must not retry a non-idempotent operation");
            const r2 = await call({ payload: "fourth\n" });
            assert.ok(!r2.error, JSON.stringify(r2.error));
            assert.strictEqual(fs.readFileSync(file, "utf8"), "first\nsecond\nfourth\n");
        });

        it("rename, unlink and create are not retried after the request was sent", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 3 }), { operation: "msg" });
            for (const m of [
                { operation: "rename", filename: "tmp-res\\f8.txt", new_filename: "tmp-res\\f8b.txt" },
                { operation: "unlink", filename: "tmp-res\\f9.txt" },
                { operation: "create", filename: "tmp-res\\new.txt", payload: "x" },
            ]) {
                await call({ operation: "read-dir", filename: "" }); // open a session
                const before = proxy.connections;
                proxy.freezeExisting();
                const r = await call(m);
                assert.strictEqual(r.error.code, "SMB_TIMEOUT", m.operation);
                assert.strictEqual(proxy.connections, before, `${m.operation} must not be retried`);
            }
        });

        it("overwrite (idempotent write) IS retried and succeeds", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 1 }), { operation: "create", mode: "overwrite", path: "tmp-res\\ow.txt" });
            await call({ payload: "a" });
            proxy.freezeExisting();
            const r = await call({ payload: "b" });
            assert.ok(!r.error, JSON.stringify(r.error));
            assert.strictEqual(fs.readFileSync(path.join(TMP, "ow.txt"), "utf8"), "b");
            assert.strictEqual(proxy.connections, 2);
        });

        it("non-idempotent operations ARE retried when the failure happened before sending (connection phase)", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 0.5, retries: 2 }), { operation: "create", mode: "append", path: "tmp-res\\x.log" });
            const r = await call({ payload: "x" });
            assert.strictEqual(r.error.code, "SMB_TIMEOUT");
            assert.strictEqual(proxy.connections, 3);
        });

        it("bad password is never retried (protects the account from lockout)", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ retries: 5 }), {}, { cfg: { user: env.user, pass: "wrong" } });
            const r = await call({});
            assert.strictEqual(r.error.code, "STATUS_LOGON_FAILURE");
            assert.strictEqual(proxy.connections, 1);
            // a second message tries again exactly once (no hidden loops)
            await call({});
            assert.strictEqual(proxy.connections, 2);
        });

        it("bad share name is not retried", async function () {
            proxy = await new TestProxy().start();
            await load({ share: `\\\\${env.host}:${proxy.port}\\DoesNotExist`, retries: 5 });
            const r = await call({});
            assert.strictEqual(r.error.code, "STATUS_BAD_NETWORK_NAME");
            assert.strictEqual(proxy.connections, 1);
        });

        it("file-level errors are not retried and do not reset the session", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ retries: 5 }), { operation: "read-file" });
            for (let i = 0; i < 5; i++) {
                const r = await call({ filename: "tmp-res\\missing.txt" });
                assert.strictEqual(r.error.code, "STATUS_OBJECT_NAME_NOT_FOUND");
            }
            assert.strictEqual((await call({ filename: "tmp-res\\f1.txt" })).msg.payload, "v1");
            assert.strictEqual(proxy.connections, 1);
        });

        it("connection refused: retried with backoff (0.5 s, 1 s), then ECONNREFUSED", async function () {
            proxy = await new TestProxy().start();
            const port = proxy.port;
            await proxy.stop(); proxy = null;
            await load({ share: share(port), retries: 2, timeout: 5 });
            const [r, ms] = await elapsed(() => call({}));
            assert.strictEqual(r.error.code, "ECONNREFUSED");
            assert.ok(ms >= 1400 && ms < 3000, `took ${ms}ms`);
        });

        it("unknown host: fails fast, no retry", async function () {
            await load({ share: "\\\\host.invalid\\x", retries: 3, timeout: 5 });
            const [r, ms] = await elapsed(() => call({}));
            assert.ok(["ENOTFOUND", "EAI_AGAIN"].includes(r.error.code), r.error.code);
            if (r.error.code === "ENOTFOUND") assert.ok(ms < 1500, `took ${ms}ms`);
        });
    });

    /* ---------------- reconnection ---------------- */

    describe("reconnection", function () {
        it("server closes the idle connection: next operation (even non-idempotent) works without error", async function () {
            fs.writeFileSync(path.join(TMP, "del.txt"), "x");
            proxy = await new TestProxy().start();
            await load(viaProxy({ retries: 0 }), { operation: "msg" });
            await call({ operation: "read-dir", filename: "" });
            proxy.dropAll();
            await sleep(200);
            const r = await call({ operation: "unlink", filename: "tmp-res\\del.txt" });
            assert.ok(!r.error, JSON.stringify(r.error));
            assert.ok(!fs.existsSync(path.join(TMP, "del.txt")));
            assert.strictEqual(proxy.connections, 2);
        });

        it("connection dropped during a burst of 20 queued reads: all 20 succeed", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 2, retries: 2 }), { operation: "read-file" });
            const p = callMany(20, (i) => ({ filename: `tmp-res\\f${i % 8}.txt`, i }));
            await sleep(30);
            proxy.dropAll();
            const res = await p;
            assert.deepStrictEqual(res.filter((r) => r.error).map((r) => r.error.code), []);
            res.forEach((r) => assert.strictEqual(r.msg.payload, "v" + (r.msg.i % 8)));
        });

        it("server hangs during a burst: one timeout, every message still answered", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ timeout: 1, retries: 1 }), { operation: "read-file" });
            await call({ filename: "tmp-res\\f0.txt" });
            proxy.freezeExisting();
            const res = await callMany(10, (i) => ({ filename: `tmp-res\\f${i % 8}.txt`, i }));
            assert.strictEqual(res.length, 10);
            assert.deepStrictEqual(res.filter((r) => r.error).map((r) => r.error.code), []);
        });

        it("idle session is closed after idleTimeout and reopened on demand", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ idleTimeout: 1 }));
            await call({});
            assert.strictEqual(proxy.active, 1);
            await sleep(600);
            assert.strictEqual(proxy.active, 1, "still open before the idle timeout");
            await sleep(1000);
            assert.strictEqual(proxy.active, 0, "closed after the idle timeout");
            const r = await call({});
            assert.ok(Array.isArray(r.msg.payload));
            assert.strictEqual(proxy.connections, 2);
        });

        it("idleTimeout 0 keeps the session open", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ idleTimeout: 0 }));
            await call({});
            await sleep(1500);
            assert.strictEqual(proxy.active, 1);
            await call({});
            assert.strictEqual(proxy.connections, 1);
        });

        it("re-deploy (flow restart) closes the connection", async function () {
            proxy = await new TestProxy().start();
            await load(viaProxy({ idleTimeout: 0 }));
            await call({});
            assert.strictEqual(proxy.active, 1);
            await helper.unload();
            await sleep(200);
            assert.strictEqual(proxy.active, 0);
        });
    });

    /* ---------------- queue ---------------- */

    describe("queue", function () {
        it("rejects new work with SMB_QUEUE_FULL above 1000 pending operations", async function () {
            proxy = await new TestProxy({ silent: true }).start();
            await load(viaProxy({ timeout: 0, retries: 0 }));
            const n1 = helper.getNode("n1");
            const errs = [];
            helper.getNode("err").on("input", (m) => errs.push(m.smbError.code));
            for (let i = 0; i < 1005; i++) n1.receive({});
            await sleep(300);
            assert.strictEqual(errs.filter((c) => c === "SMB_QUEUE_FULL").length, 5);
        });

        it("status shows the queue length while busy", async function () {
            proxy = await new TestProxy().start();
            proxy.delayMs = 50;
            await load(viaProxy());
            const n1 = helper.getNode("n1");
            const texts = [];
            n1.on("call:status", (c) => c.args[0] && c.args[0].text && texts.push(c.args[0].text));
            await callMany(5, () => ({}));
            assert.ok(texts.some((t) => /busy \(\d+ pending\)/.test(t)), texts.join(", "));
            assert.strictEqual(texts[texts.length - 1], "done");
        });
    });
});
