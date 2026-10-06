"use strict";
/*
 * TCP proxy used to simulate network failures between the node and the SMB server.
 *   freezeExisting()  open connections stop forwarding (server "hangs"); new ones work
 *   dropAll()         abruptly closes every open connection
 *   delayMs           latency added to every server -> client chunk
 *   silent: true      accepts TCP connections but never answers (no upstream at all)
 */
const net = require("net");

class TestProxy {
    constructor(opts) {
        opts = opts || {};
        this.targetHost = opts.host || "127.0.0.1";
        this.targetPort = opts.port || 445;
        this.silent = !!opts.silent;
        this.delayMs = 0;
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
            upstream.on("data", (d) => {
                if (pair.frozen) return;
                if (this.delayMs > 0) setTimeout(() => { if (!pair.frozen && !client.destroyed) client.write(d); }, this.delayMs);
                else client.write(d);
            });
        });
        return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => {
            this.port = this.server.address().port;
            resolve(this);
        }));
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
