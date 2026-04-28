# Debug: grpc-file-smoke-durable-close-race

## Environment
- macOS local workspace
- Service smoke command: `pnpm --dir /Users/adam/bud/service smoke:grpc-file`
- Real Rust Bud debug binary launched by the smoke
- In-process grpc-js control and data gateways on reserved localhost ports

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service smoke:grpc-file`.
2. Let the smoke create a temporary workspace file and drive `HEAD`, full `GET`, range `GET`, and stale range `GET` through `/api/files/:fileSessionId`.

## Observed
- The sandboxed run failed before the smoke on `tsx` IPC bind:
  `Error: listen EPERM: operation not permitted /var/folders/_n/tdtkt70j47qgsv8_3yq9vmj80000gn/T/tsx-501/68674.pipe`
- The approved run reached the file flow but timed out waiting for durable file operation and stream outcomes:
  `Error: Timed out waiting for durable file operation and stream outcomes.`

## Expected
- Successful `HEAD`, full `GET`, and range `GET` should leave three succeeded `file_read` operations and three closed `file_read` streams.
- The stale range request should leave one rejected `file_read` operation and return `409 content_changed`.

## Hypotheses
- Tiny file/stat responses can receive daemon `stream_close` on `BudData.Attach` before the service has finished transitioning rows from `offered/opening` to `running/open` after `file_open_result`.
- The data gateway previously only closed streams already in `open` or half-closed states, and file/proxy edge close callbacks only succeeded operations already in `accepted` or `running`.
- A fast close could therefore be ignored durably, leaving rows stuck in non-terminal states even though the HTTP request completed.

## Proposed Fix
- Make generic data `stream_close` durable handling tolerate close-before-open by first promoting `opening` streams to `open`, then closing them.
- Make file/proxy runtime close callbacks promote `offered` operations through `accepted` and `running` before marking them `succeeded`.
- Re-run typecheck, lint, and the real-daemon file smoke.

## Spec Files Affected
- No contract/spec change expected; this is a race fix in existing Phase 4 stream-close semantics.
