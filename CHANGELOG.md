# Changelog

## 2.0.0 — first release of node-red-contrib-smb2-plus

Fork of node-red-contrib-smb2.5 1.16.0. Node type names are unchanged, existing flows keep working.

### Reliability
- Operations sharing a connection go through a FIFO queue. The SMB library is not safe for concurrent use: with
  the original package, 25 simultaneous reads produced 1 `EALREADY` error and 24 messages that never got an answer.
- Timeout for every operation (default 60 s). Operations can no longer hang forever.
- Detects when the server closes the connection and opens a fresh session.
- Automatic retries (default 1) after connection errors, with backoff, only when safe: idempotent operations are
  always retried; append, create, rename, delete, mkdir and rmdir only when the request never reached the server.
  Login and "share not found" errors are never retried.
- Ordinary file errors (e.g. "not found") no longer tear down the connection and abort other operations.
- Idle sessions are closed (default 30 s) instead of being kept open forever.
- SMB2 interim responses (`STATUS_PENDING`) are handled as the protocol requires: they are ignored and the final
  response is awaited. The library delivered them as errors, so busy or slow servers produced random
  `STATUS_PENDING` failures on reads, writes and listings.
- Exceptions while parsing server responses are contained instead of crashing Node-RED.
- Queue limit (1000 operations) to protect memory when the server is unreachable.
- Maximum read size (default 100 MB) to protect memory.

### Security
- Writes, deletes, renames and folder operations request the rights of the Windows **Modify** permission instead
  of also asking for `WRITE_DAC` (change permissions) and `FILE_DELETE_CHILD`, which belong to *Full control*.
  With the original package a service account with the recommended *Modify* permission got
  `STATUS_ACCESS_DENIED` on those operations.
- Username and password are stored in the encrypted Node-RED credentials store instead of clear text in
  `flows.json`, with automatic migration when the config node is edited.
- Removed the silent override of the configuration from `global.SYSCONFIG.samba`.
- Destructive operations require a non-empty path.
- The SMB library is pinned to an exact version and bundled in the package.

### Features
- Write file: *fail* / *overwrite* / *append* when the file exists (overwriting was not possible before).
- Rename with optional overwrite of the destination.
- Detailed directory listing (size, dates, type); *Info* now includes size, name and path.
- Read encodings (auto-detect, Windows-1252, UTF-16 LE, ISO-8859-1) and write encodings (UTF-8 with BOM,
  Windows-1252, UTF-16 LE, ISO-8859-1); `msg.encoding` override; objects are written as JSON.
- Operation selectable through `msg.operation`.
- Sub-folder in the Share field (it was silently ignored), configurable port (`Port` field or `\\host:port\share`),
  `/` in paths, full UNC path accepted in the Path field, `DOMAIN\user` and `user@domain`.
- Clear errors for invalid share, reading a folder, file too large, unknown operation.
- `msg.smbError = {code, message}` on every Node-RED version (Node-RED < 4 does not include `code` in `msg.error`).
- Node status shows the error code and the number of pending operations.
- Editor UI and help in English and Spanish; bundled example flow.
- Test suite: unit tests plus integration tests against a real Samba server, including network-failure
  simulation (hung server, dropped connections, latency, interim `STATUS_PENDING` responses). Tested on Node-RED 2.2, 3.1, 4.1 and 5.0.

### Removed
- Japanese and Chinese locales (outdated after the new options; English is used as fallback).
