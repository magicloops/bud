# Debug: File Viewer Stale Content Identity 409

## Environment

- OS / arch / versions: macOS development host, Bud daemon + service + web local stack
- DB connection style: local service database
- LLM mode: normal web validation flow

## Repro Steps

1. Open an absolute-path file link in the web file viewer before the latest absolute-link web changes.
2. Update the branch and open the same file/session again.
3. Observe the file-edge `HEAD` or `GET` request returning `409`.

## Observed

- The backend returns `409 Conflict` for a file that previously opened or was previously attempted.
- Service maps this to the file-viewer `content_changed` state.
- The session may have a stored `content_identity` from absolute-path daemon preflight or an earlier `HEAD`/`GET`.
- Before the follow-up fix, the file edge sent that stored identity on normal preview `HEAD` and full `GET`, so Bud verified the current file against an older session identity.

## Expected

- A stale session should not leave the user stuck.
- Normal preview opens should show the current file contents when a user clicks or refreshes, even if the file changed after an older session or message.
- `409` should remain available for stale byte-range reads and files that mutate while a full read is in progress.

## Hypotheses

- The file changed between an earlier session identity capture and a later file-edge read, making Bud reject a normal preview request that should have been allowed to read the current file.
- A previously created session had stale preflight metadata after the branch changed how absolute paths are opened and normalized.
- Browser-side viewer reuse could select a still-valid but stale session whose content identity no longer matches the current file.

## Proposed Fix

- Do not send `expected_content_identity` for normal preview `stat` / full `read` requests.
- Keep `expected_content_identity` for byte-range reads, where stale offsets could return incorrect bytes.
- Keep the web viewer's one-retry recovery for any remaining `content_changed` response, such as a file mutating during read.
- Spec files affected:
  - [../service/src/files/files.spec.md](../service/src/files/files.spec.md)
  - [../web/src/features/threads/threads.spec.md](../web/src/features/threads/threads.spec.md)
