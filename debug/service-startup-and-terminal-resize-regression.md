# Debug: Service Startup And Terminal Resize Regression

## Environment

- Date: 2026-03-18 / 2026-03-19 local dev session
- Branch: `mobile-auth`
- Comparison baseline: `origin/main`
- Frontend: Vite dev server at `http://localhost:5173`
- Service: expected local dev port `3000`
- Bud daemon invocation shown by user:
  - `cargo run -- --terminal-enabled`
- Bud daemon observed target:
  - `wss://localhost:8443/ws`

## Repro Steps

1. Start the current frontend/service local stack on this branch.
2. Open a thread view in the web app.
3. Observe a resize request failure from the thread terminal UI:
   - `POST /api/threads/:threadId/terminal/resize` returns `404`
4. Start the Bud daemon with:
   - `cargo run -- --terminal-enabled`
5. Observe repeated connection failures to:
   - `wss://localhost:8443/ws`

## Observed

### Browser symptom

Console output:

```text
api.ts:103  POST http://localhost:5173/api/threads/0fee7583-88bd-4177-a7d1-62bad4093efb/terminal/resize 404 (Not Found)
[terminal] resize request failed {status: 404}
```

### Bud daemon symptom

Daemon output:

```text
2026-03-19T01:28:03.919563Z  INFO Connecting to backend server=wss://localhost:8443/ws
2026-03-19T01:28:03.922028Z  WARN Session failed; retrying error=failed to connect to wss://localhost:8443/ws

Caused by:
    0: IO error: Connection refused (os error 61)
    1: Connection refused (os error 61)
```

## Branch Review Findings

### 1. Committed branch delta vs `origin/main`

The committed branch delta is doc-only:

- `bud.spec.md`
- `TODO.md`
- `design/backend-web-better-auth-oauth-provider-spec.md`
- `plan/mobile-auth/*`
- `reference/better-auth/jwt.md`

There are no committed code changes on this branch relative to `origin/main`.

### 2. Current workspace delta vs `origin/main`

The current working tree does contain uncommitted code changes, concentrated in:

- `service/src/auth/*`
- `service/src/config.ts`
- `service/src/db/*`
- `service/src/scripts/db-push.ts`
- `web/src/lib/auth-client.ts`
- `web/src/routes/login.tsx`
- new web mobile-auth files under:
  - `web/src/routes/auth.mobile.tsx`
  - `web/src/routes/auth.mobile.consent.tsx`
  - `web/src/components/auth-page-shell.tsx`
  - `web/src/lib/oauth-provider.ts`
- `web/vite.config.ts`

### 3. Files directly involved in the observed symptoms were not changed

Compared to `origin/main`, there are no code changes in:

- `service/src/routes/threads.ts`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/lib/api.ts`
- `bud/src/main.rs`

That matters because:

- the web terminal resize call path is unchanged
- the service resize route is unchanged
- the Bud daemon default WebSocket target is unchanged

## Code-Level Findings

### Terminal resize route still exists

The service still registers:

- `POST /api/threads/:threadId/terminal/resize`

and that route returns `404` in two relevant cases:

1. `thread_not_found`
2. `no_terminal_session`

The route code itself was not modified in this branch.

### Bud daemon still defaults to the old local endpoint

`bud/src/main.rs` still defaults `BUD_SERVER_URL` / `--server` to:

```text
wss://localhost:8443/ws
```

But the current local-service docs in `bud/README.md` say local dev should use:

```text
ws://localhost:3000/ws
```

So there is a local-dev docs/runtime mismatch:

- docs now point to `ws://localhost:3000/ws`
- binary default still points to `wss://localhost:8443/ws`

### Service local defaults still point at port 3000

`service/src/config.ts` still defaults the service port to:

```text
3000
```

and the WebSocket gateway is still mounted at:

```text
/ws
```

No branch-local code change moved the service to `8443`.

### Web proxy change is unlikely to explain the resize 404

The only `web/vite.config.ts` proxy change vs `origin/main` is:

- adding `/.well-known/*`

The existing `/api` proxy block is unchanged, so this branch did not remove or redirect the terminal API proxy path.

## Hypotheses

### 1. The resize `404` is a downstream symptom of the Bud daemon never connecting

Most likely.

Reasoning:

- the resize route itself is unchanged
- that route explicitly returns `404 { error: "no_terminal_session" }` when the thread has no active terminal session
- if the Bud daemon never connects to `/ws`, the service will not have a live terminal session to resize
- the daemon log already shows connection refusal before any terminal session could be created

### 2. The Bud daemon is simply targeting the wrong local endpoint for current service dev

Very likely.

Reasoning:

- the daemon is trying `wss://localhost:8443/ws`
- service local defaults remain `http://localhost:3000`
- branch code did not change the Bud default, so this is likely an environment/runtime mismatch rather than a code regression
- current docs already say local dev should use `ws://localhost:3000/ws`

### 3. The service startup/auth changes may have prevented the service from starting cleanly or fully binding routes

Plausible.

Reasoning:

- the current uncommitted workspace does include substantial changes in:
  - `service/src/auth/auth.ts`
  - `service/src/auth/session.ts`
  - `service/src/config.ts`
  - auth-related migrations/bootstrap
- if the service failed during startup or did not reach the point where `/ws` and terminal routes are live, the daemon would see connection refusal and the web app could end up talking to a half-working local stack
- we do not yet have the service startup logs in this debug pass

### 4. The resize `404` could be an auth/ownership-side `thread_not_found`, not a terminal-session-side `no_terminal_session`

Possible, but less likely.

Reasoning:

- auth/session code changed in the current workspace
- thread access checks intentionally return `404` on unauthorized access
- however, if the user can already load and interact with the thread view, a resize-only `thread_not_found` is a weaker fit than `no_terminal_session`

### 5. The frontend may be running against stale local processes or stale env assumptions

Possible.

Reasoning:

- the branch now expects coordinated local behavior across:
  - service on `3000`
  - web proxying `/api/*` to that service
  - Bud using `ws://localhost:3000/ws` for local dev
- if one of those processes was started with older assumptions, the stack can look “partially alive” while the terminal path fails

## Unknowns

- We do not yet know the exact response body for the resize `404`.
  - It matters whether it is `thread_not_found` or `no_terminal_session`.
- We do not yet have the current service startup logs.
  - It matters whether the service is actually booting cleanly and listening on `3000`.
- We do not yet know whether Bud was intentionally started without `BUD_SERVER_URL=ws://localhost:3000/ws`.
- We do not yet know whether the web dev server was restarted after the latest proxy/config changes.

## Suggested Path Forward

Before changing code:

1. Capture the current service startup logs from this branch.
   - Confirm whether the service binds successfully on `http://localhost:3000`.
   - Confirm whether `/ws` is actually listening.
2. Capture the response body for the resize `404`.
   - If it is `no_terminal_session`, that strongly supports the daemon-connectivity hypothesis.
   - If it is `thread_not_found`, pivot toward auth/ownership debugging.
3. Confirm the Bud daemon launch target for local dev.
   - Expected local value: `ws://localhost:3000/ws`
   - Current observed value: `wss://localhost:8443/ws`
4. Confirm the frontend proxy target.
   - Expected local value: `VITE_API_PROXY_TARGET=http://localhost:3000`
5. Only after those checks, decide whether the next fix is:
   - environment/startup configuration
   - service auth bootstrap
   - or an actual code regression in the new auth work

## Expected

For the current local dev setup:

- Bud should connect to `ws://localhost:3000/ws` unless an explicit TLS proxy is running on `8443`
- the web app should proxy `/api/*` to the service on `3000`
- a thread with an active Bud-backed terminal session should accept `/terminal/resize`
- if there is no terminal session yet, the resize path should fail only as a secondary symptom, not as the primary root cause
