"use strict";
/*
 * TCP proxy used to simulate network failures between the node and the SMB server.
 *   freezeExisting()  open connections stop forwarding (server "hangs"); new ones work
 *   dropAll()         abruptly closes every open connection
 *   delayMs           latency added to every server -> client chunk
 *   silent: true      accepts TCP connections but never answers (no upstream at all)
 *   asyncPending      like a busy Windows server: every file-level response is preceded by
 *                     an interim STATUS_PENDING response and sent as an async response
 */
const net = require("net");

class TestProxy {
    constructor(opts) {
        opts = opts || {};
        this.targetHost = opts.host || "127.0.0.1";
        this.targetPort = opts.port || 445;
        this.silent = !!opts.silent;
        this.delayMs = 0;
        this.asyncPending = false;
        this.interimSent = 0;
        this.connections = 0;
        this.pairs = new Set();
    }

    start() {
        this.server = net.createServer((client) => {
            this.connections++;
            const pair = { client, upstream: null, frozen: false };
            this.pairs.add(pair);
            const cleanup = () => {
                this.pairs.delete(pair);
                client.destroy();
                if (pair.upstream) pair.upstream.destroy();
            };
            client.on("error", cleanup);
            client.on("close", cleanup);
            if (this.silent) return;

            const upstream = net.connect(this.targetPort, this.targetHost);
            pair.upstream = upstream;
            upstream.on("error", cleanup);
            upstream.on("close", cleanup);
            client.on("data", (d) => { if (!pair.frozen) upstream.write(d); });
            let pending = Buffer.alloc(0);
            const forward = (d) => {
                if (pair.frozen) return;
                if (this.delayMs > 0) setTimeout(() => { if (!pair.frozen && !client.destroyed) client.write(d); }, this.delayMs);
                else client.write(d);
            };
            upstream.on("data", (d) => {
                if (!this.asyncPending) return forward(d);
                pending = Buffer.concat([pending, d]);
                while (pending.length >= 4) {
                    const len = (pending[1] << 16) + pending.readUInt16BE(2);
                    if (pending.length < len + 4) break;
                    const packet = pending.slice(0, len + 4);
                    pending = pending.slice(len + 4);
                    forward(this._asyncify(packet));
                }
            });
        });
        return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => {
            this.port = this.server.address().port;
            resolve(this);
        }));
    }

    /* Returns interim STATUS_PENDING + the response converted to an async response. */
    _asyncify(packet) {
        const smb = packet.slice(4);
        const command = smb.readUInt16LE(12);
        // CREATE, CLOSE, READ, WRITE, QUERY_DIRECTORY, QUERY_INFO, SET_INFO
        if (![0x05, 0x06, 0x08, 0x09, 0x0e, 0x10, 0x11].includes(command)) return packet;
        const asyncId = Buffer.alloc(8);
        asyncId.writeUInt32LE(++this.interimSent, 0);

        const header = Buffer.from(smb.slice(0, 64));
        header.writeUInt32LE(0x00000103, 8);                       // STATUS_PENDING
        header.writeUInt32LE(header.readUInt32LE(16) | 0x2, 16);   // SMB2_FLAGS_ASYNC_COMMAND
        header.writeUInt32LE(0, 20);                               // NextCommand
        asyncId.copy(header, 32);                                  // AsyncId replaces Reserved/TreeId
        const body = Buffer.from([0x09, 0, 0, 0, 0, 0, 0, 0, 0]);  // ERROR response, empty
        const interim = Buffer.concat([header, body]);

        const final = Buffer.from(smb);
        final.writeUInt32LE(final.readUInt32LE(16) | 0x2, 16);
        asyncId.copy(final, 32);

        const frame = (b) => {
            const nb = Buffer.alloc(4);
            nb.writeUInt8(0, 0);
            nb.writeUInt8((b.length >> 16) & 0xff, 1);
            nb.writeUInt16BE(b.length & 0xffff, 2);
            return Buffer.concat([nb, b]);
        };
        return Buffer.concat([frame(interim), frame(final)]);
    }

    get active() { return this.pairs.size; }

    freezeExisting() { for (const p of this.pairs) p.frozen = true; }

    dropAll() {
        for (const p of [...this.pairs]) {
            p.client.destroy();
            if (p.upstream) p.upstream.destroy();
        }
        this.pairs.clear();
    }

    stop() {
        this.dropAll();
        return new Promise((resolve) => this.server.close(() => resolve()));
    }
}

module.exports = TestProxy;
