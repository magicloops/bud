# Debug: Terminal Session Create And Agent SSE Regression

## Environment

- Date: 2026-03-18 local dev session
- Branch: `mobile-auth`
- Frontend: Vite dev server at `http://localhost:5173`
- Service: local API proxying `/api/*`
- Bud daemon: now connects after sourcing env (`set -a; source .env; set +a`)
- Thread under test:
  - `0fee7583-88bd-4177-a7d1-62bad4093efb`

## Repro Steps

1. Start the current local web + service stack on this branch.
2. Start the Bud daemon with the correct local env loaded.
3. Open an existing thread in the web UI.
4. Observe terminal bootstrap and agent SSE behavior in the browser console.

## Observed

### Terminal bootstrap failure

The thread view immediately attempts:

```text
POST /api/threads/:threadId/terminal
```

and receives:

```text
500 Internal Server Error
[terminal] Failed to create session record {status: 500}
```

### Follow-on terminal resize failure

After the failed create call, the xterm fit path still sends:

```text
POST /api/threads/:threadId/terminal/resize
```

and receives:

```text
404 Not Found
[terminal] resize request failed {status: 404}
```

### Separate SSE failure

At the same time, the browser reports:

```text
EventSource's response has a MIME type ("text/plain") that is not "text/event-stream".
```

and the thread view logs:

```text
[agent-sse] error {readyState: 2, evt: Event}
[agent-sse] reconnecting ...
```

## Expected

- `POST /api/threads/:threadId/terminal` should return an existing or newly created session record.
- Terminal resize should succeed once a session exists.
- Agent SSE should attach successfully and receive heartbeats as `text/event-stream`.

## Branch Review Findings

### Relevant route/manager code is unchanged vs `origin/main`

There are no workspace changes in:

- `service/src/routes/threads.ts`
- `service/src/runtime/terminal-session-manager.ts`
- `web/src/routes/$budId/$threadId.tsx`

That points away from a fresh regression in the terminal route wiring itself.

### Current schema changes are auth-focused

The current `schema.ts` diff vs `origin/main` adds Better Auth / OAuth tables. The `terminal_session` shape and its `thread_id` uniqueness behavior are unchanged.

## Code-Level Findings

### 1. The terminal create route has only one application-level `500` path

`POST /api/threads/:threadId/terminal` does:

1. `getSessionForThread(threadId)`
2. if missing, `createSessionForThread(threadId, budId, createdByUserId)`
3. `getSessionForThread(threadId)` again
4. returns `500 { error: "session_create_failed" }` if still missing

An uncaught insert/update error inside `createSessionForThread()` would also surface as a `500`.

### 2. Session creation is not compatible with closed-session rows

`TerminalSessionManager.createSessionForThread()`:

- only treats rows with `closed_at IS NULL` as existing
- then inserts a fresh `terminal_session` row with the same `thread_id`

`terminal_session.thread_id` is still globally unique in the schema, not partially unique for active rows only.

That means a thread with an older closed session can still block a new insert for the same `thread_id`.

This matches the previously documented mobile-support blocker around terminal session recreation.

### 3. The resize `404` is very likely secondary

The thread view initializes xterm independently of session creation. Even if `POST /terminal` fails, `fitTerminal()` can still call `POST /terminal/resize`.

The service resize route returns `404` when there is no active terminal session, so this error is consistent with the failed session-create path, not a separate root cause.

### 4. The MIME error is probably from agent SSE, not terminal SSE

The thread view only opens terminal SSE after `POST /terminal` succeeds. In the current failure case it returns early before opening `/terminal/stream`.

However, agent SSE is attached independently on mount via:

```text
GET /api/threads/:threadId/agent/stream
```

So the observed `text/plain` / not `text/event-stream` response is more likely coming from the agent stream path.

### 5. Agent SSE failure is not yet explained by the terminal-session bug alone

`GET /api/threads/:threadId/agent/stream` should:

1. authorize the thread
2. attach the event bus listener
3. start heartbeats

Because the route itself is unchanged, the current SSE failure is more likely one of:

- a non-SSE auth/ownership response
- a service-side error before SSE attachment
- a dev proxy / transport issue returning a plain-text fallback response

## Hypotheses

### 1. Most likely: `POST /terminal` is failing on a unique-constraint collision for `terminal_session.thread_id`

Why it fits:

- the schema still enforces a global unique `thread_id`
- the manager only checks for non-closed rows before inserting
- revisiting a thread with a prior closed session would hit exactly this path
- the downstream resize `404` follows naturally once session creation fails

### 2. The agent SSE MIME error is a separate auth/transport failure on `/api/threads/:threadId/agent/stream`

Why it fits:

- agent SSE mounts independently of terminal creation
- the terminal code never reaches `/terminal/stream` after the `500`
- the browser is explicitly complaining about a non-SSE response body

### 3. React dev double-invocation is amplifying, but probably not causing, the issue

The thread view effects run in a React dev environment and may issue duplicate mount-time requests. That can make the bug noisier and easier to reproduce, but the backend should still tolerate repeated `POST /terminal` calls.

### 4. Less likely: `POST /terminal` is succeeding in DB but the immediate re-read is failing due to unexpected row state / transaction visibility

This would also produce `session_create_failed`, but it is a weaker fit than a direct insert error because the create path inserts a `pending` row that should satisfy the second lookup immediately.

### 5. Lower confidence: the agent SSE error is coming from local proxy behavior rather than service logic

This remains possible until the actual response status/body for `/api/threads/:threadId/agent/stream` is inspected.

## Unknowns

- The exact service log/error for `POST /api/threads/:threadId/terminal`
  - Expected most likely value: Postgres unique violation on `terminal_session.thread_id`
- The actual response status/body for `/api/threads/:threadId/agent/stream`
  - We only have the browser’s MIME complaint, not the server-side reason yet
- Whether the thread already has one or more closed `terminal_session` rows in the local DB

## Suggested Path Forward

1. Inspect the service log for the failing `POST /api/threads/:threadId/terminal` request.
2. Inspect local DB rows for this thread in `terminal_session`, especially `state` and `closed_at`.
3. Inspect the actual network response for `/api/threads/:threadId/agent/stream` to determine whether it is `401`, `404`, `500`, or proxy-generated text.
4. If the terminal `500` is confirmed as the thread-id uniqueness collision, fix the session recreation contract rather than patching the frontend:
   - either reuse/reopen the closed row
   - or change the uniqueness model so only active sessions must be unique per thread

## Related Notes

- Prior local-stack note: `/Users/adam/code/bud/debug/service-startup-and-terminal-resize-regression.md`
- Existing known blocker: terminal session recreation for closed sessions
