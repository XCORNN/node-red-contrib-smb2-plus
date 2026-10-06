# node-red-contrib-smb2-plus

Node-RED nodes to read and write files on Windows / Samba shared folders (SMB2), built for unattended production use.

*Leer en español: [README.es.md](README.es.md)*

This is a hardened fork of [node-red-contrib-smb2.5](https://github.com/Delevin888/node-red-contrib-smb2.5)
(itself derived from `node-red-contrib-smb` by ST-One). Node type names are unchanged (`SMB` and `smb config`),
so existing flows keep working.

## Why this fork

The underlying SMB library has limitations that, in the original package, cause messages to hang forever or
the whole Node-RED process to crash. Measured against the same Samba server:

| Scenario | Original package | This package |
|---|---|---|
| 25 simultaneous reads | 0 OK, 1 error, **24 messages never answered** | 25 OK |
| Server drops the session | 1 `EPIPE` error, **1 message never answered** | Reconnects transparently |
| Server unreachable / hung | Waits forever | `SMB_TIMEOUT` after the configured time |
| Malformed server response | Uncaught exception (can crash Node-RED) | Connection reset, error reported |

What it does:

- **Queue**: operations sharing a connection run one at a time (the library is not safe for concurrent use).
- **Timeout** for every operation.
- **Automatic reconnection** when the server closes the connection or the session expires.
- **Safe retries**: idempotent operations (read, list, overwrite, info, ensure directory) are retried after a
  connection error; non-idempotent ones (append, create, rename, delete, mkdir, rmdir) are retried only if the
  request never reached the server, so a timeout can never duplicate a line or rename twice.
  **Login errors are never retried** (no Active Directory account lockouts).
- **Idle sessions are closed** and reopened on demand instead of being kept open forever.
- **Least privilege**: works with a service account that has the Windows *Modify* permission; *Full control* is not
  needed (the original package required it for writing, deleting and renaming).
- **Encrypted credentials** (Node-RED credentials store) instead of clear text in `flows.json`.
- Write modes **fail / overwrite / append**, rename with overwrite, detailed directory listings.
- **Text encodings**: auto-detect, Windows-1252, UTF-16, and UTF-8 with BOM for CSV files that Excel opens correctly.
- Sub-folder in the share field, custom port, `/` or `\` in paths, `DOMAIN\user` and `user@domain`.
- Clear error codes, editor UI and help in English and Spanish, bundled example flow.

## Install

**Uninstall `node-red-contrib-smb2.5` first**: both packages register the same node types and cannot coexist.

**From a `.tgz` file** (e.g. downloaded from the GitHub releases): *Menu → Manage palette → Install*, click
the upload button and select the file. Or from the command line, in your Node-RED user directory
(`~/.node-red`, or `/data` in Docker):

```
npm uninstall node-red-contrib-smb2.5
npm install /path/to/node-red-contrib-smb2-plus-2.0.0.tgz
```

**From npm** (if the package is published there): search for `node-red-contrib-smb2-plus` in *Manage palette*,
or run `npm install node-red-contrib-smb2-plus`.

The SMB library is bundled inside the package: installing it downloads nothing else.

Requirements: Node-RED 2.0 or later (tested on 2.2, 3.1, 4.1 and 5.0).

### Migrating from node-red-contrib-smb2.5

1. Install as above. Flows load unchanged and work with the old credentials.
2. Open the **smb config** node once, click *Update* and *Deploy*. Username and password move to the encrypted
   credentials store and disappear from `flows.json`.

Behaviour changes: the hidden override from `global.SYSCONFIG.samba` has been removed, and errors now also set
`msg.smbError`.

## Configuration (smb config)

| Field | Example | Notes |
|---|---|---|
| Share | `\\fileserver.example.local\Shared` | May include a sub-folder (`\\server\Shared\Reports`); all paths become relative to it. `//server/Shared` also works. In Docker or Linux prefer the full DNS name or the IP: short Windows names often do not resolve. |
| Domain | `EXAMPLE` or `example.local` | Leave empty for local accounts. |
| Username | `node-red` | `EXAMPLE\node-red` and `node-red@example.local` also work. |
| Password | | Stored encrypted. |

Permissions: the account needs *Modify* on the folders it writes to (*Read* is enough for read-only flows).

Advanced settings:

| Setting | Default | Purpose |
|---|---|---|
| Port | 445 | Also accepted as `\\server:port\share`. |
| Operation timeout | 60 s | Maximum time per attempt. Decimals allowed. 0 = no limit (not recommended). |
| Close idle session after | 30 s | Keep it below the server's idle timeout. 0 = never close. |
| Retries | 1 | Extra attempts after a connection error, only when safe (see above). Backoff 0.5 s, 1 s, 1.5 s… |
| Max. read size | 100 MB | Files are read fully into memory; bigger files are rejected. 0 = no limit. |

## Operations (smb node)

| Operation | Input | Output |
|---|---|---|
| Read directory | path | `msg.payload`: array of names, or of `{name, path, isDirectory, size, birthtime, mtime, atime, ctime}` with *Include details* |
| Read file | path | `msg.payload`: string or Buffer |
| Write file | path, `msg.payload` | If the file exists: *fail* / *overwrite* / *append* |
| Rename / Move | path, new path | Optional overwrite of the destination |
| Remove file, Create / Remove directory | path | |
| Ensure directory | path | Creates the folder and any missing parents |
| Exists | path | `msg.exists` (boolean) |
| Info | path | `msg.payload`: `{name, path, isDirectory, size, birthtime, mtime, atime, ctime}` |
| Set by msg.operation | `msg.operation` | One node for several operations: `read-dir`, `read-file`, `create`, `rename`, `unlink`, `mkdir`, `ensure-dir`, `rmdir`, `exists`, `info` |

**Paths** are relative to the share, e.g. `Reports\2026\data.csv`. When the node's *Path* is empty,
`msg.filename` is used (and `msg.new_filename` for rename). Both `/` and `\` are accepted, and if you paste the
full UNC path of the configured share it is trimmed automatically. In a function node remember to write `\\`.

**Encodings.** Read: UTF-8, *auto* (UTF-8/UTF-16 BOM, otherwise UTF-8 if valid, otherwise Windows-1252),
Windows-1252, UTF-16 LE, ISO-8859-1 or binary Buffer. Write: UTF-8, UTF-8 with BOM, Windows-1252, UTF-16 LE
(with BOM), ISO-8859-1. `msg.encoding` overrides the node setting. Objects are written as JSON.

**Errors.** On failure no message is sent: use a **catch** node. The code is in `msg.smbError.code` on every
Node-RED version (and in `msg.error.code` on Node-RED 4+).

| Code | Meaning |
|---|---|
| `STATUS_LOGON_FAILURE` | Wrong username, password or domain |
| `STATUS_BAD_NETWORK_NAME` | The share does not exist |
| `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_OBJECT_PATH_NOT_FOUND` | Path not found |
| `STATUS_OBJECT_NAME_COLLISION` | Already exists (write in *fail* mode, rename without overwrite, mkdir) |
| `STATUS_ACCESS_DENIED` | No permission |
| `STATUS_DIRECTORY_NOT_EMPTY` | Removing a folder that has content |
| `SMB_TIMEOUT` | The server did not answer in time |
| `SMB_SOCKET_CLOSED` | Connection lost during a non-retryable operation |
| `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` | Network / DNS problems |
| `SMB_FILE_TOO_LARGE`, `SMB_IS_DIRECTORY` | Read limits |
| `SMB_PATH_REQUIRED` | Destructive operation without a path (safety guard) |
| `SMB_QUEUE_FULL` | More than 1000 operations waiting (server unreachable?) |

If a non-idempotent operation fails with `SMB_TIMEOUT` or `SMB_SOCKET_CLOSED`, the server may or may not have
executed it: check before repeating it.

A ready-to-use example is available in *Menu → Import → Examples → node-red-contrib-smb2-plus*.

## Known limitations

- SMB 2.0.2 only, without signing or encryption: it cannot connect to servers that require SMB3 encryption or
  mandatory signing (common on domain controllers). Alternative: mount the share in the OS (`mount -t cifs`) and
  use the standard *file* nodes.
- Files are read and written in memory (no streaming). *Append* rewrites the whole file.
- Operations on one connection are sequential. For real parallelism use several config nodes.

## Development

```
npm install
sudo bash test/setup-samba.sh   # local Samba for the integration tests (Debian/Ubuntu)
npm test
npm pack
```

Integration tests are skipped automatically when no Samba server is available. The test server can be changed
with `SMB_TEST_HOST`, `SMB_TEST_PORT`, `SMB_TEST_SHARE`, `SMB_TEST_ROOT`, `SMB_TEST_USER` and `SMB_TEST_PASS`,
and another Node-RED version can be tested with `NODE_RED_PATH=/path/to/node-red/lib/red.js`.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
