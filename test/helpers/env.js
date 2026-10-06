"use strict";
/*
 * Shared settings for the integration tests. Override with environment variables.
 * The default values match test/setup-samba.sh.
 */
const net = require("net");

const env = {
    host: process.env.SMB_TEST_HOST || "127.0.0.1",
    port: Number(process.env.SMB_TEST_PORT || 445),
    share: process.env.SMB_TEST_SHARE || "TestShare",
    root: process.env.SMB_TEST_ROOT || "/srv/smb-test",   // local path of the share (used to verify results)
    user: process.env.SMB_TEST_USER || "testuser",
    pass: process.env.SMB_TEST_PASS || "Test-Passw0rd",
};

/** Resolves true if an SMB server is listening and the share folder is visible locally. */
env.available = function () {
    if (!require("fs").existsSync(env.root)) return Promise.resolve(false);
    return new Promise((resolve) => {
        const s = net.connect(env.port, env.host);
        s.setTimeout(1000);
        s.once("connect", () => { s.destroy(); resolve(true); });
        s.once("error", () => resolve(false));
        s.once("timeout", () => { s.destroy(); resolve(false); });
    });
};

module.exports = env;
