/*
Copyright 2018 Smart-Tech Controle e Automação
Copyright 2023 Y., Ryota
Copyright 2024 Delevin888
Copyright 2026 node-red-contrib-smb2-plus contributors
Licensed under the Apache License, Version 2.0
*/
"use strict";

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

function smbError(code, message, extra) {
    const err = new Error(message);
    err.code = code;
    if (extra) Object.assign(err, extra);
    return err;
}

/* ------------------------------------------------------------------ */
/* Share / path handling                                               */
/* ------------------------------------------------------------------ */

/**
 * Parses the "Share" field. Accepts:
 *   \\host\share            \\host\share\sub\folder
 *   //host/share            smb://host/share/sub
 *   host\share              \\host:1445\share
 * Returns { host, port, share, basePath, unc }.
 * Unlike the underlying library, a sub-folder after the share name is NOT
 * silently ignored: it becomes basePath and is prefixed to every operation.
 */
function parseShare(input) {
    let s = String(input == null ? "" : input).trim();
    s = s.replace(/^smb:/i, "");
    s = s.replace(/\//g, "\\").replace(/^\\+/, "");
    const parts = s.split("\\").filter((p) => p.length > 0);
    if (parts.length < 2) {
        throw smbError("SMB_INVALID_SHARE",
            `Invalid share "${input}". Expected something like \\\\server\\share`);
    }
    let host = parts[0];
    let port;
    const m = host.match(/^(.+):(\d{1,5})$/);
    if (m && !host.startsWith("[")) {
        host = m[1];
        port = parseInt(m[2], 10);
    }
    const share = parts[1];
    const basePath = parts.slice(2).join("\\");
    return { host, port, share, basePath, unc: `\\\\${host}\\${share}` };
}

/** Normalises a path relative to the share: backslashes, no leading/trailing/duplicate separators. */
function normPath(p) {
    if (p === undefined || p === null) return "";
    return String(p)
        .trim()
        .replace(/\//g, "\\")
        .replace(/\\{2,}/g, "\\")
        .replace(/^\\+/, "")
        .replace(/\\+$/, "");
}

/**
 * Resolves the path an operation should use.
 * - If the user pasted the full UNC path of the configured share, strip it.
 * - Prefix the base sub-folder configured in the Share field.
 */
function resolvePath(target, p) {
    let rel = normPath(p);
    const prefix = normPath(`${target.host}\\${target.share}`).toLowerCase();
    const lower = rel.toLowerCase();
    if (lower === prefix) rel = "";
    else if (lower.startsWith(prefix + "\\")) rel = rel.slice(prefix.length + 1);
    if (target.basePath) {
        const base = normPath(target.basePath);
        const lb = base.toLowerCase();
        const lr = rel.toLowerCase();
        // do not double-prefix if the user already included the base folder
        if (lr === lb || lr.startsWith(lb + "\\")) return rel;
        return rel ? `${base}\\${rel}` : base;
    }
    return rel;
}

/** Accepts "DOMAIN\user" or "user@domain" in the username field. */
function splitUser(username, domain) {
    let user = String(username || "").trim();
    let dom = String(domain || "").trim();
    const bs = user.indexOf("\\");
    if (bs > 0) {
        if (!dom) dom = user.slice(0, bs);
        user = user.slice(bs + 1);
    } else if (!dom && user.includes("@")) {
        const at = user.lastIndexOf("@");
        dom = user.slice(at + 1);
        user = user.slice(0, at);
    }
    return { username: user, domain: dom };
}

/* ------------------------------------------------------------------ */
/* Text encodings (no ICU dependency)                                  */
/* ------------------------------------------------------------------ */

// Windows-1252 bytes 0x80-0x9F (the only range that differs from latin1)
const CP1252_HIGH = [
    0x20AC, -1, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, -1, 0x017D, -1,
    -1, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, -1, 0x017E, 0x0178,
];
const CP1252_REVERSE = new Map();
CP1252_HIGH.forEach((cp, i) => { if (cp > 0) CP1252_REVERSE.set(cp, 0x80 + i); });

function decodeCp1252(buf) {
    let out = "";
    const CHUNK = 8192;
    for (let i = 0; i < buf.length; i += CHUNK) {
        const codes = [];
        const end = Math.min(buf.length, i + CHUNK);
        for (let j = i; j < end; j++) {
            const b = buf[j];
            if (b >= 0x80 && b <= 0x9F && CP1252_HIGH[b - 0x80] > 0) codes.push(CP1252_HIGH[b - 0x80]);
            else codes.push(b);
        }
        out += String.fromCharCode.apply(null, codes);
    }
    return out;
}

function encodeCp1252(str) {
    const out = Buffer.alloc(str.length);
    let n = 0;
    for (const ch of str) {
        const cp = ch.codePointAt(0);
        if (cp < 0x80 || (cp >= 0xA0 && cp <= 0xFF)) out[n++] = cp;
        else if (CP1252_REVERSE.has(cp)) out[n++] = CP1252_REVERSE.get(cp);
        else out[n++] = 0x3F; // '?'
    }
    return out.slice(0, n);
}

function isValidUtf8(buf) {
    try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
        return true;
    } catch (e) {
        return false;
    }
}

function swap16(buf) {
    const copy = Buffer.from(buf.slice(0, buf.length - (buf.length % 2)));
    return copy.swap16();
}

/**
 * Decodes a Buffer.
 * enc: "string"|"utf8" (UTF-8, BOM stripped), "auto", "windows-1252", "latin1", "utf16le", "utf16be"
 */
function decodeText(buf, enc) {
    if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || "");
    switch (enc) {
        case "auto": {
            if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.slice(3).toString("utf8");
            if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString("utf16le");
            if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return swap16(buf.slice(2)).toString("utf16le");
            return isValidUtf8(buf) ? buf.toString("utf8") : decodeCp1252(buf);
        }
        case "windows-1252":
            return decodeCp1252(buf);
        case "latin1":
            return buf.toString("latin1");
        case "utf16le":
            if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) buf = buf.slice(2);
            return buf.toString("utf16le");
        case "utf16be":
            if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) buf = buf.slice(2);
            return swap16(buf).toString("utf16le");
        case "string":
        case "utf8":
        default:
            if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.slice(3);
            return buf.toString("utf8");
    }
}

/**
 * Encodes a string. withBom=false is used when appending to an existing file.
 * enc: "utf8", "utf8bom", "windows-1252", "latin1", "utf16le" (with BOM)
 */
function encodeText(str, enc, withBom) {
    const bom = withBom !== false;
    switch (enc) {
        case "utf8bom":
            return bom ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(str, "utf8")]) : Buffer.from(str, "utf8");
        case "windows-1252":
            return encodeCp1252(str);
        case "latin1":
            return Buffer.from(str, "latin1");
        case "utf16le":
            return bom ? Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(str, "utf16le")]) : Buffer.from(str, "utf16le");
        case "utf8":
        default:
            return Buffer.from(str, "utf8");
    }
}

/** Converts any msg.payload into something writable. */
function payloadToBuffer(payload, enc, withBom) {
    if (Buffer.isBuffer(payload)) return payload;
    if (payload === undefined || payload === null) return Buffer.alloc(0);
    if (payload instanceof Uint8Array) return Buffer.from(payload);
    let str;
    if (typeof payload === "string") str = payload;
    else if (typeof payload === "object") str = JSON.stringify(payload);
    else str = String(payload);
    return encodeText(str, enc, withBom);
}

/* ------------------------------------------------------------------ */
/* Error classification                                                */
/* ------------------------------------------------------------------ */

// The SMB session/connection is gone: reconnect and the operation can be retried.
const SESSION_STATUS = new Set([
    "STATUS_NETWORK_NAME_DELETED",
    "STATUS_USER_SESSION_DELETED",
    "STATUS_NETWORK_SESSION_EXPIRED",
    "STATUS_CONNECTION_DISCONNECTED",
    "STATUS_CONNECTION_RESET",
    "STATUS_CONNECTION_ABORTED",
    "STATUS_INVALID_NETWORK_RESPONSE",
    "STATUS_UNEXPECTED_NETWORK_ERROR",
    "STATUS_IO_TIMEOUT",
    "STATUS_REQUEST_NOT_ACCEPTED",
    "STATUS_INSUFFICIENT_RESOURCES",
]);

// Transient socket-level problems: reconnect and retry.
const TRANSIENT_SOCKET = new Set([
    "SMB_TIMEOUT",
    "SMB_SOCKET_CLOSED",
    "ECONNRESET",
    "ECONNABORTED",
    "EPIPE",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENETDOWN",
    "EAI_AGAIN",
    "ERR_STREAM_DESTROYED",
    "ERR_STREAM_WRITE_AFTER_END",
    "ERR_SOCKET_CLOSED",
]);

// Errors produced by this package that are not connection problems.
const LOCAL_ERRORS = new Set([
    "SMB_INVALID_SHARE",
    "SMB_PATH_REQUIRED",
    "SMB_FILE_TOO_LARGE",
    "SMB_IS_DIRECTORY",
    "SMB_QUEUE_FULL",
    "SMB_CLOSING",
    "SMB_UNKNOWN_OPERATION",
]);

/**
 * Decides what to do with an error.
 *  reset: throw away the current client (fresh TCP+SMB session next time)
 *  retry: the operation may be safely attempted again
 * Authentication failures are never retried (avoids locking the AD account).
 */
function classifyError(err) {
    const code = err && err.code ? String(err.code) : "";
    if (LOCAL_ERRORS.has(code)) return { reset: false, retry: false };
    if (code.startsWith("STATUS_")) {
        if (SESSION_STATUS.has(code)) return { reset: true, retry: true };
        // Failed while establishing the session (bad login, bad share name...)
        if (err.smbConnected === false) return { reset: true, retry: false };
        // Ordinary file-level error, the session is fine.
        return { reset: false, retry: false };
    }
    if (TRANSIENT_SOCKET.has(code)) return { reset: true, retry: true };
    // Unknown / protocol error: be safe, start over but do not retry.
    return { reset: true, retry: false };
}

/** Converts library stat objects into plain JSON-friendly objects. */
function plainStat(st, name, path) {
    if (!st) return st;
    const out = {};
    if (name !== undefined) out.name = name;
    if (path !== undefined) out.path = path;
    out.isDirectory = typeof st.isDirectory === "function" ? !!st.isDirectory() : !!st.isDirectory;
    out.size = st.size;
    out.birthtime = st.birthtime;
    out.mtime = st.mtime;
    out.atime = st.atime;
    out.ctime = st.ctime;
    return out;
}

/** True when the server rejected the request because the session was gone: nothing was executed. */
function isSessionError(err) {
    return !!(err && err.code && SESSION_STATUS.has(String(err.code)));
}

module.exports = {
    smbError,
    isSessionError,
    parseShare,
    normPath,
    resolvePath,
    splitUser,
    decodeText,
    encodeText,
    payloadToBuffer,
    classifyError,
    plainStat,
};
