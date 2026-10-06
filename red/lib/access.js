/*
Copyright 2026 node-red-contrib-smb2-plus contributors
Licensed under the Apache License, Version 2.0
*/
"use strict";

/*
 * The SMB library asks for WRITE_DAC (permission to change the ACL) and
 * FILE_DELETE_CHILD on every write, delete, rename and mkdir. Those rights are
 * only part of "Full control", so a service account with the recommended
 * "Modify" permission gets STATUS_ACCESS_DENIED.
 *
 * This replaces the requested access with exactly what "Modify" grants:
 * read, write, append, attributes, extended attributes, delete and
 * synchronize. Applied once, without modifying the bundled library.
 */

const constants = require("@tryjsky/v9u-smb2/lib/structures/constants");

const MODIFY_ACCESS =
    constants.DELETE |
    constants.FILE_READ_DATA |
    constants.FILE_WRITE_DATA |
    constants.FILE_APPEND_DATA |
    constants.FILE_READ_ATTRIBUTES |
    constants.FILE_WRITE_ATTRIBUTES |
    constants.FILE_READ_EA |
    constants.FILE_WRITE_EA |
    constants.READ_CONTROL |
    constants.SYNCHRONIZE;

const MESSAGES = ["create", "open_folder", "create_folder"];

let applied = false;

function apply() {
    if (applied) return;
    for (const name of MESSAGES) {
        const msg = require(`@tryjsky/v9u-smb2/lib/messages/${name}`);
        const original = msg.generate;
        msg.generate = function () {
            const message = original.apply(this, arguments);
            if (message && message.request && typeof message.request.DesiredAccess === "number") {
                message.request.DesiredAccess = MODIFY_ACCESS;
            }
            return message;
        };
    }
    applied = true;
}

module.exports = { apply, MODIFY_ACCESS };
