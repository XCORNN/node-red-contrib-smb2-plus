"use strict";
const helper = require("node-red-node-test-helper");
const smbNode = require("../../red/smb.js");
const env = require("./env");
const assert = require("assert");
const path = require("path");

const redPath = process.env.NODE_RED_PATH || require.resolve("node-red");
const nodeRedMajor = parseInt(require(path.join(path.dirname(redPath), "..", "package.json")).version, 10);

helper.init(redPath);

const unhandled = [];
process.on("unhandledRejection", (r) => unhandled.push(r));

function share(port, sub) {
    if (!port && env.port !== 445) port = env.port;
    const host = port ? `${env.host}:${port}` : env.host;
    return `\\\\${host}\\${env.share}${sub ? "\\" + sub : ""}`;
}

function flow(cfgExtra, nodeExtra) {
    return [
        Object.assign({ id: "cfg", type: "smb config", share: share(), domain: "",
            timeout: 10, idleTimeout: 30, retries: 1, maxReadMB: 100 }, cfgExtra || {}),
        Object.assign({ id: "n1", type: "SMB", config: "cfg", operation: "read-dir", path: "", wires: [["out"]] }, nodeExtra || {}),
        { id: "out", type: "helper" },
        { id: "c1", type: "catch", scope: ["n1"], uncaught: false, wires: [["err"]] },
        { id: "err", type: "helper" },
    ];
}

// Node-RED overrides on("input"): use persistent listeners and a FIFO of waiters.
let waiters = [];
function attach() {
    waiters = [];
    const next = (r) => { const w = waiters.shift(); if (w) w(r); };
    helper.getNode("out").on("input", (m) => next({ msg: m }));
    helper.getNode("err").on("input", (m) => {
        // msg.error.code exists only on Node-RED >= 4; msg.smbError.code on every version
        assert.ok(m.smbError && m.smbError.code, "msg.smbError.code must always be set");
        if (nodeRedMajor >= 4) assert.strictEqual(m.error.code, m.smbError.code);
        next({ error: Object.assign({}, m.error, { code: m.smbError.code }), msg: m });
    });
}

async function load(cfgExtra, nodeExtra, creds) {
    await helper.load(smbNode, flow(cfgExtra, nodeExtra),
        creds === undefined ? { cfg: { user: env.user, pass: env.pass } } : creds);
    attach();
}

/** Sends a message, resolves with {msg} or {error, msg}. */
function call(msg) {
    return new Promise((resolve) => {
        waiters.push(resolve);
        helper.getNode("n1").receive(msg || {});
    });
}

/** Sends n messages built by make(i), resolves with all results. */
function callMany(n, make) {
    const all = [];
    for (let i = 0; i < n; i++) all.push(call(make(i)));
    return Promise.all(all);
}

module.exports = { nodeRedMajor, helper, env, share, load, call, callMany, unhandled };
