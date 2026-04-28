# Debug: gRPC File Open Timeout

## Environment

- Local macOS development workspace
- Service smoke script: `pnpm --dir /Users/adam/bud/service smoke:grpc-file`
- Bud daemon: local debug binary built by the smoke script
- Transport mode: HTTP/2 gRPC control plus HTTP/2 gRPC data

## Repro Steps

1. Run `pnpm --dir /Users/adam/bud/service smoke:grpc-file`.
2. Wait for the smoke to enroll a daemon and create a file session.
3. The first file `HEAD` edge request opens a daemon file stream.

## Observed

The file `HEAD` request returns:

```text
504 {"error":"file_open_timeout","message":"Bud did not accept the file stream before the timeout"}
```

The daemon output includes:

```text
WARN gRPC data runtime stream reset stream_id=... reason=timeout
```

## Expected

The daemon should receive `file_open`, return `file_open_result`, then close the stream with `final_offset = 0` for `HEAD/stat`.

## Hypotheses

- The service is selecting the gRPC data tracker but the control directive is not reaching the daemon after the carrier-neutral refactor.
- The daemon receives the control directive but the gRPC control path no longer dispatches `file_open`.
- A typed protobuf/JSON compatibility mismatch exists on the gRPC control carrier for `file_open`.
- The daemon sends `file_open_result` but the service no longer routes gRPC control results into the file runtime.
- The daemon sends `stream_close` on the gRPC data stream before `file_open_result` arrives on the separate gRPC control stream.

## Root Cause

The last hypothesis was the issue. `HEAD/stat` file reads have a zero-byte body, so the daemon sends `file_open_result` on gRPC control and `stream_close` on gRPC data back-to-back. Because those are separate HTTP/2 streams, the service can observe `stream_close` first. `FileRuntimeStream.handleClose()` treated that as final cleanup and removed the runtime registration before the later `file_open_result` could resolve the pending open wait. The edge request then timed out and returned `file_open_timeout`.

## Proposed Fix

Keep the file runtime registration alive when `stream_close` arrives before `file_open_result`. End the body stream immediately, but defer cleanup until the open result arrives or the edge timeout path performs cleanup.

## Validation

- `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/files/file-runtime.test.ts src/files/file-session.test.ts src/transport/data-plane-router.test.ts src/grpc/envelope-codec.test.ts`
- `pnpm --dir /Users/adam/bud/service smoke:grpc-file`

## Spec Files Affected

- `service/src/files/files.spec.md`
- `service/src/grpc/grpc.spec.md`
- `service/src/transport/transport.spec.md`
- `bud/src/src.spec.md`
