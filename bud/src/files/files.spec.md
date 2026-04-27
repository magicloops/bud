# files

Daemon-side read-only workspace file adapter for Phase 4.4 of the network upgrade.

## Purpose

This folder owns the daemon's local adapter for service-requested file stat/read/range streams. It revalidates service `file_open` requests against daemon-side policy before touching the filesystem, reads only regular files under the configured workspace root, and streams accepted bytes over the HTTP/2 data channel with runtime credits.

## Files

### `mod.rs`

Phase 4.4 file implementation.

- accepts `file_open` frames from the app dispatcher
- only permits `stream_type = "file_read"`
- only permits `root_key = "workspace"`
- validates relative POSIX paths and rejects absolute, parent-directory, backslash, empty, and root/prefix paths
- rejects symlinks, non-regular files, and canonical paths that escape the workspace root
- supports `stat`, `read`, and single `range` modes
- enforces daemon-side `max_bytes`
- computes a content identity from file size and modified time
- rejects reads when the expected content identity is stale
- rejects a read if the file content identity changes while bytes are being read
- returns `file_open_result` accept/reject metadata on control
- sends read/range body chunks as generic `stream_data` frames over `BudData.Attach`
- waits for service `stream_credit` before sending more response bytes
- stops active streams when service sends `stream_reset`

## Dependencies

- [../app.rs](../app.rs) - dispatches `file_open`, owns the workspace root, and routes data-stream credit/reset frames into the manager
- [../transport.rs](../transport.rs) - fails generic stream frames closed unless `BudData.Attach` is available
- [../protocol.rs](../protocol.rs) - `FileOpenFrame`, `StreamCreditFrame`, and `StreamResetFrame` definitions
- [../../src.spec.md](../src.spec.md) - daemon source overview
- [../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md](../../../plan/network-upgrade/phase-4-localhost-proxy-and-file-reads.md) - Phase 4 sequencing

## TODOs / Technical Debt

<!-- SPEC:TODO -->
- Later file work needs configurable local policy roots, richer MIME/content-disposition handling, true large-file streaming without prebuffering, and stream outcome audit coverage beyond the service's current durable operation/stream rows.

---

*Referenced by: [../src.spec.md](../src.spec.md)*
