"use strict";
/*
 * Functional tests against a real Samba server (see test/setup-samba.sh).
 * Skipped automatically when no server is available.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { helper, env, share, load, call, callMany, unhandled } = require("./helpers/harness");

const DIR = "Projects\\Team A\\04 - General\\16 - Reports";   // spaces and dashes on purpose
const LDIR = path.join(env.root, "Projects", "Team A", "04 - General", "16 - Reports");
const TMP = path.join(env.root, "tmp");
const read = (p) => fs.readFileSync(path.join(env.root, ...p.split("\\")));

describe("SMB node: operations (real Samba)", function () {
    this.timeout(60000);

    before(async function () {
        if (!(await env.available())) return this.skip();
        fs.mkdirSync(LDIR, { recursive: true });
        fs.writeFileSync(path.join(LDIR, "hello.txt"), "hello from samba\n");
        fs.writeFileSync(path.join(LDIR, "ansi.csv"), Buffer.from([0x41, 0xF1, 0x6F, 0x3B, 0x80, 0x0A])); // "Año;€\n" cp1252
        fs.rmSync(TMP, { recursive: true, force: true });
        fs.mkdirSync(TMP);
        fs.chmodSync(TMP, 0o777);
    });
    afterEach(function () { return helper.unload(); });
    after(function () { assert.deepStrictEqual(unhandled, [], "unhandled promise rejections"); });

    it("lists the root and a path with spaces", async function () {
        await load();
        let r = await call({});
        assert.ok(r.msg.payload.includes("Projects"), JSON.stringify(r.error));
        await helper.unload();
        await load({}, { path: DIR });
        r = await call({});
        assert.ok(r.msg.payload.includes("hello.txt"));
    });

    it("accepts the full UNC path in Path and forward slashes in msg.filename", async function () {
        await load({}, { path: `${share()}\\${DIR}` });
        let r = await call({});
        assert.ok(r.msg.payload.includes("hello.txt"), JSON.stringify(r.error));
        await helper.unload();
        await load();
        r = await call({ filename: DIR.replace(/\\/g, "/") });
        assert.ok(r.msg.payload.includes("hello.txt"));
    });

    it("uses a sub-folder written in the Share field as base folder", async function () {
        await load({ share: share(null, DIR) });
        let r = await call({});
        assert.ok(r.msg.payload.includes("hello.txt"), JSON.stringify(r.error));
        await helper.unload();
        await load({ share: share(null, DIR) }, { operation: "read-file" });
        r = await call({ filename: "hello.txt" });
        assert.strictEqual(r.msg.payload, "hello from samba\n");
    });

    it("accepts host:port in the Share field and the Port field", async function () {
        await load({ share: share(env.port) });
        let r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
        await helper.unload();
        await load({ port: String(env.port) });
        r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
    });

    it("detailed directory listing", async function () {
        await load({}, { path: DIR, detailed: true });
        const r = await call({});
        const f = r.msg.payload.find((x) => x.name === "hello.txt");
        assert.strictEqual(f.isDirectory, false);
        assert.strictEqual(f.size, 17);
        assert.ok(f.mtime instanceof Date);
        assert.strictEqual(f.path, DIR + "\\hello.txt");
    });

    it("reads text as UTF-8, auto-detected ANSI and binary", async function () {
        await load({}, { operation: "read-file", format: "string" });
        let r = await call({ filename: DIR + "\\hello.txt" });
        assert.strictEqual(r.msg.payload, "hello from samba\n");
        r = await call({ filename: DIR + "\\ansi.csv", encoding: "auto" });
        assert.strictEqual(r.msg.payload, "Año;€\n");
        r = await call({ filename: DIR + "\\ansi.csv", encoding: "windows-1252" });
        assert.strictEqual(r.msg.payload, "Año;€\n");
        r = await call({ filename: DIR + "\\ansi.csv", encoding: "binary" });
        assert.ok(Buffer.isBuffer(r.msg.payload) && r.msg.payload.length === 6);
    });

    it("reads an empty file", async function () {
        fs.writeFileSync(path.join(TMP, "empty.txt"), "");
        await load({}, { operation: "read-file" });
        const r = await call({ filename: "tmp\\empty.txt" });
        assert.strictEqual(r.msg.payload, "");
    });

    it("reads and writes a file bigger than one SMB packet (1 MB)", async function () {
        const big = Buffer.alloc(1024 * 1024 + 123);
        for (let i = 0; i < big.length; i++) big[i] = (i * 7) & 0xff;
        await load({}, { operation: "msg" });
        let r = await call({ operation: "create", filename: "tmp\\big1.bin", payload: big });
        assert.ok(!r.error, JSON.stringify(r.error));
        assert.ok(read("tmp\\big1.bin").equals(big));
        r = await call({ operation: "read-file", filename: "tmp\\big1.bin", encoding: "binary" });
        assert.ok(r.msg.payload.equals(big));
    });

    it("write modes: fail if exists, overwrite, append (single BOM), encodings, objects", async function () {
        const p = "tmp\\out.csv";
        await load({}, { operation: "create", path: p, mode: "create", encoding: "utf8bom" });
        let r = await call({ payload: "Año;Importe\n" });
        assert.ok(!r.error, JSON.stringify(r.error));
        r = await call({ payload: "x" });
        assert.strictEqual(r.error.code, "STATUS_OBJECT_NAME_COLLISION");
        await helper.unload();

        await load({}, { operation: "create", path: p, mode: "append", encoding: "utf8bom" });
        r = await call({ payload: "2026;12€\n" });
        assert.ok(!r.error, JSON.stringify(r.error));
        const buf = read(p);
        assert.deepStrictEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
        assert.strictEqual(buf.slice(3).toString(), "Año;Importe\n2026;12€\n");
        await helper.unload();

        await load({}, { operation: "create", path: p, mode: "overwrite", encoding: "windows-1252" });
        r = await call({ payload: "ñ€" });
        assert.ok(!r.error);
        assert.deepStrictEqual([...read(p)], [0xF1, 0x80]);
        r = await call({ payload: { a: 1 } });
        assert.strictEqual(read(p).toString(), '{"a":1}');
        r = await call({ payload: 42 });
        assert.strictEqual(read(p).toString(), "42");
    });

    it("append creates the file when missing and keeps message order", async function () {
        await load({}, { operation: "create", path: "tmp\\log.txt", mode: "append" });
        const res = await callMany(20, (i) => ({ payload: `line ${i}\n` }));
        assert.ok(res.every((r) => !r.error), JSON.stringify(res.find((r) => r.error)));
        const expected = Array.from({ length: 20 }, (_, i) => `line ${i}\n`).join("");
        assert.strictEqual(read("tmp\\log.txt").toString(), expected);
    });

    it("ensure-dir, exists, info, rename (with and without overwrite), unlink, rmdir", async function () {
        await load({}, { operation: "msg" });
        let r = await call({ operation: "ensure-dir", filename: "tmp\\a\\b\\c" });
        assert.ok(!r.error, JSON.stringify(r.error));
        assert.ok(fs.statSync(path.join(TMP, "a", "b", "c")).isDirectory());
        r = await call({ operation: "ensure-dir", filename: "tmp\\a\\b\\c" });
        assert.ok(!r.error, "ensure-dir must be idempotent");
        r = await call({ operation: "exists", filename: "tmp\\a\\b" });
        assert.strictEqual(r.msg.exists, true);
        r = await call({ operation: "exists", filename: "tmp\\nope" });
        assert.strictEqual(r.msg.exists, false);

        fs.writeFileSync(path.join(TMP, "a", "one.txt"), "1");
        fs.writeFileSync(path.join(TMP, "a", "two.txt"), "2");
        r = await call({ operation: "info", filename: "tmp\\a\\one.txt" });
        assert.strictEqual(r.msg.payload.size, 1);
        assert.strictEqual(r.msg.payload.name, "one.txt");
        assert.strictEqual(r.msg.payload.isDirectory, false);
        r = await call({ operation: "info", filename: "tmp\\a" });
        assert.strictEqual(r.msg.payload.isDirectory, true);

        r = await call({ operation: "rename", filename: "tmp\\a\\one.txt", new_filename: "tmp\\a\\two.txt" });
        assert.strictEqual(r.error.code, "STATUS_OBJECT_NAME_COLLISION");
        await helper.unload();
        await load({}, { operation: "rename", overwrite: true });
        r = await call({ filename: "tmp\\a\\one.txt", new_filename: "tmp\\a\\b\\two.txt" });
        assert.ok(!r.error, JSON.stringify(r.error));
        assert.strictEqual(read("tmp\\a\\b\\two.txt").toString(), "1");
        await helper.unload();

        await load({}, { operation: "msg" });
        r = await call({ operation: "unlink", filename: "tmp\\a\\b\\two.txt" });
        assert.ok(!r.error);
        r = await call({ operation: "rmdir", filename: "tmp\\a\\b" });
        assert.strictEqual(r.error.code, "STATUS_DIRECTORY_NOT_EMPTY");
        r = await call({ operation: "rmdir", filename: "tmp\\a\\b\\c" });
        assert.ok(!r.error, JSON.stringify(r.error));
        assert.ok(!fs.existsSync(path.join(TMP, "a", "b", "c")));
        r = await call({ operation: "mkdir", filename: "tmp\\a\\new" });
        assert.ok(!r.error && fs.existsSync(path.join(TMP, "a", "new")));
    });

    it("guards: empty path, unknown operation, reading a folder, size limit", async function () {
        await load({ maxReadMB: 0.001 }, { operation: "msg" });
        for (const op of ["rmdir", "unlink", "create", "rename", "mkdir", "read-file"]) {
            const r = await call({ operation: op });
            assert.strictEqual(r.error.code, "SMB_PATH_REQUIRED", op);
        }
        let r = await call({ operation: "rename", filename: "tmp\\x" });
        assert.strictEqual(r.error.code, "SMB_PATH_REQUIRED");
        r = await call({ operation: "format-c" });
        assert.strictEqual(r.error.code, "SMB_UNKNOWN_OPERATION");
        r = await call({});
        assert.strictEqual(r.error.code, "SMB_UNKNOWN_OPERATION");
        r = await call({ operation: "read-file", filename: DIR });
        assert.strictEqual(r.error.code, "SMB_IS_DIRECTORY");
        fs.writeFileSync(path.join(TMP, "big.bin"), Buffer.alloc(5000));
        r = await call({ operation: "read-file", filename: "tmp\\big.bin" });
        assert.strictEqual(r.error.code, "SMB_FILE_TOO_LARGE");
        r = await call({ operation: "read-file", filename: "tmp\\missing.txt" });
        assert.strictEqual(r.error.code, "STATUS_OBJECT_NAME_NOT_FOUND");
        r = await call({ operation: "read-dir", filename: "tmp\\missing\\deeper" });
        assert.ok(/STATUS_OBJECT_(PATH|NAME)_NOT_FOUND/.test(r.error.code), r.error.code);
        // the session survives file-level errors
        r = await call({ operation: "read-dir", filename: "" });
        assert.ok(Array.isArray(r.msg.payload));
    });

    it("50 concurrent mixed operations all succeed (queue)", async function () {
        for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(TMP, `c${i}.txt`), "v" + i);
        await load({}, { operation: "msg" });
        const res = await callMany(50, (i) => i % 2
            ? { operation: "read-dir", filename: "tmp" }
            : { operation: "read-file", filename: `tmp\\c${i / 2}.txt`, i: i / 2 });
        assert.deepStrictEqual(res.filter((r) => r.error).map((r) => r.error.code), []);
        res.filter((r) => r.msg.i !== undefined).forEach((r) => assert.strictEqual(r.msg.payload, "v" + r.msg.i));
    });

    it("two config nodes for the same server work in parallel", async function () {
        await helper.load(require("../red/smb.js"), [
            { id: "cfgA", type: "smb config", share: share() },
            { id: "cfgB", type: "smb config", share: share(), idleTimeout: 1 },
            { id: "a", type: "SMB", config: "cfgA", operation: "read-dir", wires: [["out"]] },
            { id: "b", type: "SMB", config: "cfgB", operation: "read-dir", wires: [["out"]] },
            { id: "out", type: "helper" },
        ], { cfgA: { user: env.user, pass: env.pass }, cfgB: { user: env.user, pass: env.pass } });
        let n = 0;
        await new Promise((resolve) => {
            helper.getNode("out").on("input", () => { if (++n === 20) resolve(); });
            for (let i = 0; i < 10; i++) { helper.getNode("a").receive({}); helper.getNode("b").receive({}); }
        });
    });

    it("authentication: bad password, DOMAIN\\user and user@domain syntax", async function () {
        await load({ retries: 3 }, {}, { cfg: { user: env.user, pass: "wrong" } });
        let r = await call({});
        assert.strictEqual(r.error.code, "STATUS_LOGON_FAILURE");
        await helper.unload();
        await load({}, {}, { cfg: { user: `WORKGROUP\\${env.user}`, pass: env.pass } });
        r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
        await helper.unload();
        await load({}, {}, { cfg: { user: `${env.user}@WORKGROUP`, pass: env.pass } });
        r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
    });

    it("legacy clear-text credentials of the original package still work", async function () {
        await load({ username: env.user, password: env.pass }, {}, {});
        const r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
    });

    it("encrypted credentials take precedence over legacy ones", async function () {
        await load({ username: "old", password: "old" });
        const r = await call({});
        assert.ok(Array.isArray(r.msg.payload), JSON.stringify(r.error));
    });

    it("bad share name and invalid share string give clear errors", async function () {
        await load({ share: `\\\\${env.host}\\DoesNotExist` });
        let r = await call({});
        assert.strictEqual(r.error.code, "STATUS_BAD_NETWORK_NAME");
        await helper.unload();
        await load({ share: "\\\\onlyserver" });
        r = await call({});
        assert.strictEqual(r.error.code, "SMB_INVALID_SHARE");
    });

    it("node without config reports status and does not crash", async function () {
        await helper.load(require("../red/smb.js"),
            [{ id: "n1", type: "SMB", config: "missing", operation: "read-dir", wires: [] }], {});
        const n1 = helper.getNode("n1");
        n1.receive({}); // must not throw
    });
});
