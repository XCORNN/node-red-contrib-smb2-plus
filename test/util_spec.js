"use strict";
const assert = require("assert");
const u = require("../red/lib/util");

describe("util", function () {
    it("parseShare: formats and sub-folders", function () {
        assert.deepStrictEqual(u.parseShare("\\\\fs.example.local\\Shared"),
            { host: "fs.example.local", port: undefined, share: "Shared", basePath: "", unc: "\\\\fs.example.local\\Shared" });
        const s = u.parseShare("//fs/Shared/Dept/04 - General/");
        assert.strictEqual(s.basePath, "Dept\\04 - General");
        assert.strictEqual(u.parseShare("smb://srv:1445/x").port, 1445);
        assert.strictEqual(u.parseShare("srv\\x").unc, "\\\\srv\\x");
        assert.throws(() => u.parseShare("\\\\srv"), /Invalid share/);
        assert.throws(() => u.parseShare(""), /Invalid share/);
    });

    it("normPath / resolvePath", function () {
        assert.strictEqual(u.normPath("/a//b/c/"), "a\\b\\c");
        assert.strictEqual(u.normPath(undefined), "");
        const t = u.parseShare("\\\\FILESERVER\\Shared");
        assert.strictEqual(u.resolvePath(t, "\\\\fileserver\\shared\\Dept\\x.txt"), "Dept\\x.txt");
        assert.strictEqual(u.resolvePath(t, "\\\\FILESERVER\\Shared"), "");
        const tb = u.parseShare("\\\\FILESERVER\\Shared\\Dept");
        assert.strictEqual(u.resolvePath(tb, "x.txt"), "Dept\\x.txt");
        assert.strictEqual(u.resolvePath(tb, ""), "Dept");
        assert.strictEqual(u.resolvePath(tb, "Dept\\x.txt"), "Dept\\x.txt");
    });

    it("splitUser", function () {
        assert.deepStrictEqual(u.splitUser("EXAMPLE\\node-red", ""), { username: "node-red", domain: "EXAMPLE" });
        assert.deepStrictEqual(u.splitUser("node-red@example.local", ""), { username: "node-red", domain: "example.local" });
        assert.deepStrictEqual(u.splitUser("node-red", "X"), { username: "node-red", domain: "X" });
    });

    it("decode / encode windows-1252, utf8 BOM, utf16, auto", function () {
        const ansi = Buffer.from([0x41, 0xF1, 0x6F, 0x20, 0x80, 0x20, 0x93, 0x78, 0x94]); // Año € “x”
        assert.strictEqual(u.decodeText(ansi, "windows-1252"), "Año € \u201Cx\u201D");
        assert.strictEqual(u.decodeText(ansi, "auto"), "Año € \u201Cx\u201D");
        assert.ok(u.encodeText("Año € \u201Cx\u201D", "windows-1252").equals(ansi));
        assert.strictEqual(u.encodeText("日", "windows-1252").toString("latin1"), "?");
        const bom = u.encodeText("ñ", "utf8bom");
        assert.deepStrictEqual([...bom.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
        assert.strictEqual(u.decodeText(bom, "auto"), "ñ");
        assert.strictEqual(u.decodeText(bom, "string"), "ñ");
        assert.strictEqual(u.encodeText("ñ", "utf8bom", false).length, 2);
        const u16 = u.encodeText("Año", "utf16le");
        assert.strictEqual(u.decodeText(u16, "auto"), "Año");
        assert.strictEqual(u.decodeText(u16, "utf16le"), "Año");
        const be = Buffer.from([0xFE, 0xFF, 0x00, 0x41, 0x00, 0xF1]);
        assert.strictEqual(u.decodeText(be, "auto"), "Añ");
        assert.strictEqual(u.decodeText(Buffer.from("plain"), "auto"), "plain");
    });

    it("payloadToBuffer", function () {
        assert.strictEqual(u.payloadToBuffer({ a: 1 }, "utf8").toString(), '{"a":1}');
        assert.strictEqual(u.payloadToBuffer(42, "utf8").toString(), "42");
        assert.strictEqual(u.payloadToBuffer(null, "utf8").length, 0);
        const b = Buffer.from([1, 2]);
        assert.strictEqual(u.payloadToBuffer(b, "utf8"), b);
    });

    it("classifyError", function () {
        const e = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
        assert.deepStrictEqual(u.classifyError(e("STATUS_OBJECT_NAME_NOT_FOUND", { smbConnected: true })), { reset: false, retry: false });
        assert.deepStrictEqual(u.classifyError(e("STATUS_LOGON_FAILURE", { smbConnected: false })), { reset: true, retry: false });
        assert.deepStrictEqual(u.classifyError(e("STATUS_NETWORK_SESSION_EXPIRED")), { reset: true, retry: true });
        assert.deepStrictEqual(u.classifyError(e("ECONNRESET")), { reset: true, retry: true });
        assert.deepStrictEqual(u.classifyError(e("SMB_TIMEOUT")), { reset: true, retry: true });
        assert.deepStrictEqual(u.classifyError(e("SMB_PATH_REQUIRED")), { reset: false, retry: false });
        assert.deepStrictEqual(u.classifyError(new Error("weird")), { reset: true, retry: false });
    });
});

describe("access rights", function () {
    it("never asks for WRITE_DAC or FILE_DELETE_CHILD (works with 'Modify' permission)", function () {
        const access = require("../red/lib/access");
        access.apply();
        const c = require("@tryjsky/v9u-smb2/lib/structures/constants");
        const conn = { SessionId: 1, TreeId: 1, ProcessId: Buffer.alloc(4), messageId: 0 };
        for (const name of ["create", "open_folder", "create_folder"]) {
            const m = require(`@tryjsky/v9u-smb2/lib/messages/${name}`).generate(conn, { path: "x" });
            const mask = m.request.DesiredAccess;
            assert.strictEqual(mask & c.WRITE_DAC, 0, name + " WRITE_DAC");
            assert.strictEqual(mask & c.FILE_DELETE_CHILD, 0, name + " FILE_DELETE_CHILD");
            assert.ok(mask & c.DELETE && mask & c.FILE_WRITE_DATA, name + " keeps modify rights");
        }
    });
});
