# Bud Protocol

## Scope

This document specifies the active on-wire contracts used by Bud:

- Bud daemon ⇄ service over WebSocket JSON frames at `/ws`
- Service → browser over SSE for thread-scoped agent and terminal streams
- Browser → service thread message writes that participate in the live agent-stream contract

The legacy standalone run transport (`run`, `stdout`, `stderr`, `cancel`, `run_finished`) and browser `/api/runs/*` stream are no longer part of the supported contract.

---

## 1. Conventions

- **Bud**: the Rust daemon running on a device
- **Service**: the Node/Fastify backend
- **Browser client**: the web or native product surface consuming REST/SSE
- **Thread**: the user-owned conversation that also owns the active terminal session
- **Terminal session**: the thread-scoped persistent shell/REPL/TUI runtime on Bud
- **Frame**: one JSON message on `/ws`
- **Event**: one SSE frame

Identifiers:
- `bud_id`: stable device identifier
- `thread_id`: stable conversation identifier
- `session_id`: stable thread-terminal identifier
- `message_id`: persisted transcript-row identifier
- `client_id`: stable client-visible message identity used across optimistic UI, live runtime, and later persistence
- `request_id`: per-request id for terminal request/response flows

Timestamps:
- `ts` is milliseconds since UNIX epoch on WebSocket frames
- HTTP/SSE payloads use ISO-8601 strings unless noted otherwise

Wire-format rules:
- Bud-owned request/response bodies, SSE payloads, and WebSocket payloads use `snake_case`
- Unknown fields must be ignored
- Every WebSocket frame includes a reserved `ext` object for forward compatibility

---

## 2. Versioning

- Base WebSocket protocol version: `proto: "0.1"`
- Terminal protocol extension version: `proto: "0.2"`
- Unknown fields must be ignored by receivers
- Breaking wire changes must bump the relevant `proto`

---

## 3. Transports

### 3.1 Bud ⇄ Service WebSocket

- URL: `wss://<host>/ws`
- Encoding: UTF-8 JSON
- Bud should send `heartbeat` every 30 seconds
- Service marks a Bud offline after `offlineGraceSec` with no accepted heartbeat
- Bud output chunks should stay at or below 16 KiB

### 3.2 Agent Runtime Snapshot

- URL: `GET /api/threads/:thread_id/agent/state`
- Returns the current best-effort in-flight runtime snapshot for the authorized viewer
- Snapshot includes `active`, `turn_id`, `phase`, `can_cancel`, `stream_cursor`, `pending_tool`, `draft_assistant`, and `updated_at`

### 3.3 Agent SSE Stream

- URL: `GET /api/threads/:thread_id/agent/stream`
- Authorized, thread-scoped SSE stream
- Fresh attach with no cursor is live-only
- Resume uses `after=<cursor>` primarily; `Last-Event-ID` and `last_event_id` are compatibility inputs
- SSE frame `id:` is the opaque bounded-resume cursor shared with `/agent/state.stream_cursor`

### 3.4 Terminal SSE Stream

- URL: `GET /api/threads/:thread_id/terminal/stream`
- Authorized, thread-scoped SSE stream
- Carries live terminal output/status/readiness plus Bud online/offline notices for the owning thread
- Historical backfill comes from `GET /api/threads/:thread_id/terminal/history`, not SSE replay

### 3.5 Thread Message Write

- URL: `POST /api/threads/:thread_id/messages`
- Request body:

```json
{
  "text": "string",
  "client_id": "uuidv7 optional",
  "cwd": "string optional",
  "model": "string optional",
  "reasoning_effort": "none|low|medium|high optional"
}
```

- New writes return `201 { "message_id": "...", "client_id": "..." }`
- Duplicate same-thread retries using the same authenticated `client_id` return `200` with the existing identifiers

---

## 4. WebSocket Envelope

Every `/ws` frame must include:

```json
{
  "proto": "0.1",
  "type": "string",
  "id": "01HZX...ULID",
  "ts": 1731300000000,
  "ext": {}
}
```

Terminal-specific frames use the terminal protocol version:

```json
{
  "proto": "0.2",
  "type": "terminal_*",
  "id": "01HZX...ULID",
  "ts": 1731300000000,
  "ext": {}
}
```

---

## 5. Bud Identity and Authentication

Bud connects in one of two modes:

1. **Enrollment**: Bud sends `hello` with a one-time enrollment token
2. **Reconnect**: Bud sends `hello` with `bud_id`, then proves possession of `device_secret`

### 5.1 `hello` (Bud → Service)

Enrollment example:

```json
{
  "proto": "0.1",
  "type": "hello",
  "id": "01...",
  "ts": 1731,
  "name": "raspi-4",
  "os": "linux",
  "arch": "arm64",
  "version": "0.1.0",
  "installation_id": "inst_123",
  "token": "<opaque-enrollment-token>",
  "capabilities": {
    "max_concurrency": 1,
    "shell_default": "/bin/sh",
    "sessions": true,
    "terminal": true,
    "terminal_proto": "0.2"
  },
  "ext": {}
}
```

Reconnect example:

```json
{
  "proto": "0.1",
  "type": "hello",
  "id": "01...",
  "ts": 1731,
  "name": "workstation",
  "os": "linux",
  "arch": "x86_64",
  "version": "0.1.0",
  "installation_id": "inst_123",
  "bud_id": "b_01H...",
  "capabilities": {
    "max_concurrency": 1,
    "shell_default": "/bin/zsh",
    "sessions": true,
    "terminal": true,
    "terminal_proto": "0.2"
  },
  "ext": {}
}
```

Rules:
- `token` is only present on first-time enrollment
- `bud_id` is only present on reconnect
- `installation_id` is optional but, when present, must remain consistent for an already-known Bud
- enrollment tokens are validated by the service against the shared HMAC hash contract

### 5.2 `hello_challenge` (Service → Bud)

```json
{
  "proto": "0.1",
  "type": "hello_challenge",
  "id": "01...",
  "ts": 1731,
  "nonce": "base64url-32bytes",
  "ext": {}
}
```

### 5.3 `hello_proof` (Bud → Service)

```json
{
  "proto": "0.1",
  "type": "hello_proof",
  "id": "01...",
  "ts": 1731,
  "bud_id": "b_01H...",
  "hmac": "base64url",
  "ext": {}
}
```

The HMAC is computed from the nonce using the persisted `device_secret`.

### 5.4 `hello_ack` (Service → Bud)

```json
{
  "proto": "0.1",
  "type": "hello_ack",
  "id": "01...",
  "ts": 1731,
  "session_id": "s_01H...",
  "bud_id": "b_01H...",
  "device_secret": "base64url-32bytes",
  "heartbeat_sec": 30,
  "ext": {}
}
```

Notes:
- `device_secret` is only sent on first-time enrollment
- service emits Bud-online notifications only after the Bud is registered in the active in-memory session map

### 5.5 `heartbeat` (Bud → Service)

```json
{
  "proto": "0.1",
  "type": "heartbeat",
  "id": "01...",
  "ts": 1731,
  "ext": {}
}
```

The service only accepts heartbeats from the currently authoritative socket for that Bud.

---

## 6. Terminal Protocol (Bud ⇄ Service)

The active execution contract is thread-scoped terminals. The service sends structured terminal requests; Bud responds with status/output/readiness and request-scoped results.

### 6.1 Service → Bud Terminal Requests

Supported request families:

- `terminal_ensure`: create or verify the thread terminal session
- `terminal_resize`: resize the active terminal session
- `terminal_send`: send one structured gesture
- `terminal_observe`: explicitly inspect the terminal
- `terminal_close`: close the session

`terminal_send` uses a single gesture model:

```json
{
  "proto": "0.2",
  "type": "terminal_send",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "text": "git status",
  "submit": true,
  "wait_for": "settled",
  "timeout_ms": 30000,
  "ext": {}
}
```

Rules:
- the request is either `text` with optional `submit`, or one semantic `key`
- canonical keys are backend-neutral names such as `ctrl+c`, `enter`, and `escape`
- `wait_for: "settled"` is the default agent path
- `terminal.observe` is the explicit inspection hatch for `delta`, `screen`, or `history`

### 6.2 `terminal_status` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_status",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "state": "creating",
  "info": {
    "pid": 12345,
    "cwd": "/Users/adam/bud",
    "cols": 120,
    "rows": 40,
    "output_log_bytes": 4096
  },
  "ext": {}
}
```

### 6.3 `terminal_output` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_output",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "seq": 42,
  "data": "base64 payload",
  "byte_offset": 16384,
  "ext": {}
}
```

Rules:
- `seq` is monotonic per session output stream
- `byte_offset` is monotonic and is the durable ordering/backfill coordinate stored by the service
- Bud output chunks should remain at or below 16 KiB

### 6.4 `terminal_ready` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_ready",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "assessment": {
    "ready": true,
    "confidence": 0.93,
    "trigger": "settled",
    "prompt_type": "shell",
    "hints": {
      "looks_like_prompt": true,
      "looks_like_confirmation": false,
      "looks_like_password": false,
      "looks_like_pager": false,
      "may_still_be_processing": false
    }
  },
  "ext": {}
}
```

### 6.5 `terminal_send_result` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_send_result",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "submitted": true,
  "delta": {
    "changed": true,
    "text": "On branch main",
    "truncated": false
  },
  "readiness": {
    "ready": true,
    "confidence": 0.84,
    "trigger": "settled"
  },
  "error": null,
  "ext": {}
}
```

### 6.6 `terminal_observe_result` (Bud → Service)

```json
{
  "proto": "0.2",
  "type": "terminal_observe_result",
  "id": "01...",
  "ts": 1731,
  "session_id": "bud-b_123-thread-456",
  "request_id": "req_01H...",
  "view": "delta",
  "output": "base64 payload",
  "output_bytes": 1024,
  "lines_captured": 18,
  "changed": true,
  "truncated": false,
  "readiness": {
    "ready": true,
    "confidence": 0.91,
    "trigger": "changed"
  },
  "error": null,
  "ext": {}
}
```

---

## 7. Browser SSE Contracts

All browser-facing streams must authorize the viewer before attaching listeners or replaying buffered data.

### 7.1 Agent Stream Events

`GET /api/threads/:thread_id/agent/stream` may emit:

- `agent.message_start`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7" }`
- `agent.message_delta`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "delta": "Cloning " }`
- `agent.message_done`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "text": "Cloning repository..." }`
- `agent.tool_call`
  - `{ "turn_id": "01TURN...", "client_id": "uuidv7", "call_id": "call_123", "name": "terminal.send", "args": { ... } }`
- `agent.tool_result`
  - includes `turn_id`, `client_id`, `call_id`, compact tool `summary`, optional truncation metadata, and the persisted canonical `message`
- `agent.message`
  - includes `turn_id`, `client_id`, and the persisted canonical assistant `message`
- `thread.title`
  - `{ "thread_id": "uuid", "title": "Short Title", "source": "generated_first_user_message", "updated_at": "..." }`
- `agent.resync_required`
  - `{ "error": "resync_required", "provided_cursor": "01CUR..." }`
- `final`
  - `{ "turn_id": "01TURN...", "status": "succeeded|failed|canceled", "message_id"?: "uuid", "text"?: "...", "error"?: "..." }`
- `heartbeat`

Resume rules:
- no-cursor attach is live-only
- bounded replay only replays events after a known cursor
- if the cursor is too old or unknown, the route emits `agent.resync_required`
- clients recover from replay misses by refetching `/messages` and `/agent/state`

### 7.2 Terminal Stream Events

`GET /api/threads/:thread_id/terminal/stream` may emit:

- `terminal.output`
  - `{ "session_id": "bud-b_123-thread-456", "seq": 42, "data": "base64 payload", "byte_offset": 16384 }`
- `terminal.status`
  - `{ "session_id": "bud-b_123-thread-456", "state": "ready|active|idle|closed", "info"?: { ... } }`
- `terminal.ready`
  - `{ "session_id": "bud-b_123-thread-456", "assessment": { ... } }`
- `terminal.bud_offline`
  - `{ "bud_id": "b_01H...", "reason": "disconnected" }`
- `terminal.bud_online`
  - `{ "bud_id": "b_01H..." }`
- `heartbeat`

The old Bud-scoped `/api/terminals/:bud_id/stream` route is not part of the supported contract.

### 7.3 SSE Framing

Example:

```text
id: 01CUR...
event: agent.message
data: {"turn_id":"01TURN...","client_id":"uuidv7","message":{"message_id":"uuid","client_id":"uuidv7","role":"assistant","content":"...","created_at":"2026-03-22T22:10:00.000Z"}}

```

Rules:
- `id:` on the agent stream is the opaque resume cursor
- keep-alive heartbeats are valid SSE events even when no replayable data exists
- first-party clients should key optimistic user rows, draft assistant rows, and pending tool rows by `client_id`

---

## 8. Ordering and Delivery

- Bud must preserve terminal-output order within a session
- `terminal_output.seq` and `terminal_output.byte_offset` are monotonic per session
- terminal history correctness comes from durable storage keyed by `(session_id, byte_offset)`
- agent-stream replay is intentionally bounded and process-local; transcript correctness comes from `/messages` plus `/agent/state`
- service may ignore heartbeats, closes, or timeouts from superseded Bud sockets after a reconnect replaces the active tracker

---

## 9. Error Codes

Common service/Bud codes:

- `AUTH_FAILED` — invalid enrollment token, bad device proof, or installation mismatch
- `PROTO_VERSION_MISMATCH` — invalid envelope or incompatible `proto`
- `BUD_BUSY` — Bud cannot accept the requested work right now
- `EXEC_FAILED` — terminal/session operation failed before completion
- `TIMEOUT` — terminal wait/observe/send operation timed out
- `CANCELED` — user or system canceled the active work
- `BUD_DISCONNECTED` — Bud disconnected during active work
- `SERVER_RESTARTED` — service restarted and lost ephemeral runtime state

HTTP auth rules:
- `401` is for unauthenticated browser requests
- `404` is for authenticated users requesting someone else’s owned resource

---

## 10. Illustrative Flows

### 10.1 Enrollment

```text
Bud                  Service
---                  -------
hello(token)   ─────▶ validate token; create bud + device_secret
hello_ack      ◀──── session_id + bud_id + device_secret
```

### 10.2 Reconnect

```text
Bud                  Service
---                  -------
hello(bud_id)  ─────▶ issue nonce
hello_challenge ◀────
hello_proof    ─────▶ verify HMAC(device_secret, nonce)
hello_ack      ◀──── session_id
```

### 10.3 Terminal Send

```text
Service → Bud: terminal_send{text|key, submit?, wait_for, timeout_ms}
Bud → Service: terminal_output(seq, byte_offset, data)*
Bud → Service: terminal_send_result{submitted, delta, readiness, error}
Service → Browser SSE: terminal.output* and terminal.ready/status as applicable
```

### 10.4 Agent Resume

```text
Browser: GET /api/threads/:thread_id/agent/state
Browser: GET /api/threads/:thread_id/agent/stream?after=<stream_cursor>
Service: replay newer buffered events if cursor is known
Service: otherwise emit agent.resync_required
```

---

## 11. Security

- enrollment tokens must be time-limited, single-use, and hashed at rest
- service and bootstrap tooling must share the same enrollment-token hash contract
- device secrets must never be logged and should be stored with restrictive local permissions
- reconnect auth should always use challenge-response, not reusable bearer secrets on the wire
- TLS is required for deployed WebSocket traffic
- browser SSE/REST reads must authorize ownership before any replay, attach, or data fetch

---

## 12. Changelog

- **Current**
  - thread-scoped terminal protocol is the active execution surface
  - bounded `/agent/state` + `/agent/stream` resume is the active browser runtime contract
  - legacy standalone run transport and browser `/api/runs/*` streaming are removed from the supported protocol
