"use strict";
/* Runs the bundled example flow against the test Samba server. */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { helper, env, share, unhandled } = require("./helpers/harness");

// use the core nodes of the Node-RED version under test
const redRoot = path.join(path.dirname(process.env.NODE_RED_PATH || require.resolve("node-red")), "..");
const core = path.dirname(require.resolve("@node-red/nodes/package.json", { paths: [redRoot] }));
const fnNode = require(path.join(core, "core", "function", "10-function.js"));
const catchNode = require(path.join(core, "core", "common", "25-catch.js"));
const smbNode = require("../red/smb.js");

describe("bundled example flow", function () {
    this.timeout(20000);
    before(async function () { if (!(await env.available())) this.skip(); });
    after(function () { return helper.unload(); });

    it("ensure-dir + append + detailed listing work end to end", async function () {
        const logDir = path.join(env.root, "Reports", "logs");
        fs.rmSync(path.join(env.root, "Reports"), { recursive: true, force: true });
        fs.mkdirSync(path.join(env.root, "Reports", "2026"), { recursive: true });
        let flow = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "examples", "Basic file operations.json")));
        const debugIds = flow.filter((n) => n.type === "debug").map((n) => n.id);
        flow = flow.filter((n) => !["inject", "debug", "comment"].includes(n.type)).map((n) => {
            if (n.type === "smb config") n.share = share();
            return n;
        });
        debugIds.forEach((id) => flow.push({ id, z: flow[0].id, type: "helper" }));
        const cfgId = flow.find((n) => n.type === "smb config").id;
        await helper.load([fnNode, catchNode, smbNode], flow, { [cfgId]: { user: env.user, pass: env.pass } });

        const results = [];
        const errors = [];
        helper.getNode(debugIds[0]).on("input", (m) => results.push(m));
        helper.getNode(debugIds[1]).on("input", (m) => errors.push(m.error));
        const fn = flow.find((n) => n.type === "function" && n.name === "build line").id;
        for (let i = 0; i < 3; i++) helper.getNode(fn).receive({ payload: Date.now() });
        await new Promise((r) => setTimeout(r, 1500));
        assert.deepStrictEqual(errors, []);

        const files = fs.readdirSync(logDir);
        assert.strictEqual(files.length, 1);
        const buf = fs.readFileSync(path.join(logDir, files[0]));
        assert.deepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF], "single BOM at start");
        assert.strictEqual(buf.slice(3).toString().trim().split("\n").length, 3);
        assert.strictEqual(buf.indexOf(Buffer.from([0xEF, 0xBB, 0xBF]), 1), -1, "no BOM in the middle");

        const list = flow.find((n) => n.type === "SMB" && n.operation === "read-dir").id;
        helper.getNode(list).receive({});
        await new Promise((r) => setTimeout(r, 500));
        assert.ok(Array.isArray(results[results.length - 1].payload));
        assert.deepStrictEqual(unhandled, []);
    });
});
