# Bud Protocol (v0.1)

**Scope**  
This document specifies the on‑wire protocols used by Bud:

- **Device Control Channel (Bud ⇄ Backend)** over **WSS** with JSON frames.
- **Browser Event Stream (Backend → Web UI)** over **SSE**.
- Minimal data types, sequencing, state, and error codes for the PoC.

> **Non‑goals (for v0.1):** PTY/interactive sessions, file transfer, artifacts, multi‑concurrency per Bud, gRPC fallback.

---

## 0. Conventions & Terms

- **Bud**: the Rust daemon running on a host.
- **Backend**: the Node/TS service.
- **Run**: one execution of a shell command requested by the backend.
- **Frame**: a single JSON message over WSS.
- **Event**: a single SSE event to the browser.

Normative wording: **MUST/SHOULD/MAY** as defined by RFC‑2119.

Identifiers:
- `ulid`: canonical string ULID.
- `bud_id`, `session_id`, `run_id`, `event_id`: stable string IDs. `run_id` SHOULD be ULID‑like.

Timestamps:
- `ts`: **milliseconds since UNIX epoch** (number).

Strings:
- `data_b64` is **base64url** without padding.

---

## 1. Versioning & Compatibility

- All frames MUST include `proto`.
- Current protocol version: **`"0.1"`**.
- Unknown fields MUST be ignored.
- A reserved `ext` object is present on all frames for forward extension.

Breaking changes will bump `proto` (e.g., `0.2`).

---

## 2. Transport

### 2.1 Bud ⇄ Backend (WSS)

- URL: `wss://<host>/ws`
- Encoding: **UTF‑8 JSON**.
- Max frame size: **64 KiB** (server MAY close on larger).
- Heartbeats:
  - Bud SHOULD send `heartbeat` every **30 s**.
  - Backend marks Bud **offline** after **90 s** inactivity.
- Backpressure:
  - Bud SHOULD limit in‑flight stream chunks (see §5.3).
  - Server MAY send `log_ack` (optional) to advance Bud’s send window.

### 2.2 Backend → Browser (SSE)

- URL: `GET /api/runs/:run_id/stream`
- Headers:  
  `Content-Type: text/event-stream`,  
  `Cache-Control: no-cache, no-transform`,  
  `Connection: keep-alive`
- Keep‑alive comment every **15 s**.
- Client MAY use `Last-Event-ID` to resume.

---

## 3. Frame Envelope (Bud ⇄ Backend)

Every frame MUST include:

```json
{
  "proto": "0.1",
  "type": "string",
  "id": "01HZX...ULID",
  "ts": 1731300000000,
  "ext": {}
}
````

* `proto`: protocol version string.
* `type`: message type (see §4).
* `id`: unique message ULID (producer generated).
* `ts`: send timestamp (ms).
* `ext`: reserved object for extensions (MUST be an object).

---

## 4. Message Types (Bud ⇄ Backend)

### 4.1 Enrollment & Identity

Bud connects in **one** of two modes:

* **First‑time enrollment** (copy/paste token).
* **Reconnection** (challenge‑response using `device_secret`).

#### 4.1.1 `hello` (Bud → Backend)

*First‑time enrollment:*

```json
{
  "proto":"0.1","type":"hello","id":"01...","ts":1731,
  "name":"raspi-4","os":"linux","arch":"arm64","version":"0.1.0",
  "token":"<opaque-enrollment-token>",
  "capabilities":{"max_concurrency":1,"supports_pty":false,"shell_default":"/bin/sh"},
  "ext":{}
}
```

*Reconnection (no token):*

```json
{
  "proto":"0.1","type":"hello","id":"01...","ts":1731,
  "name":"workstation","os":"linux","arch":"x86_64","version":"0.1.0",
  "bud_id":"b_01H...",
  "capabilities":{"max_concurrency":1,"supports_pty":false,"shell_default":"/bin/sh"},
  "ext":{}
}
```

* Fields:

  * `token`: present **only** on first‑time enrollment.
  * `bud_id`: present **only** on reconnection.
  * `capabilities`: advertised host features (see §9).

#### 4.1.2 `hello_challenge` (Backend → Bud)

*Sent only in reconnection flow:*

```json
{
  "proto":"0.1","type":"hello_challenge","id":"01...","ts":1731,
  "nonce":"base64url-32bytes",
  "ext":{}
}
```

#### 4.1.3 `hello_proof` (Bud → Backend)

*Response to challenge using HMAC(device_secret, nonce):*

```json
{
  "proto":"0.1","type":"hello_proof","id":"01...","ts":1731,
  "bud_id":"b_01H...",
  "hmac":"base64url",
  "ext":{}
}
```

#### 4.1.4 `hello_ack` (Backend → Bud)

*On enrollment, server **issues** identity; on reconnection, confirms session.*

```json
{
  "proto":"0.1","type":"hello_ack","id":"01...","ts":1731,
  "session_id":"s_01H...",
  "bud_id":"b_01H...",
  "device_secret":"base64url-32bytes",   // ONLY on first-time enrollment
  "heartbeat_sec":30,
  "ext":{}
}
```

> **Errors:** If enrollment fails or proof invalid, server sends `error` with `code` (see §8) and closes.

---

### 4.2 Execution

#### 4.2.1 `run` (Backend → Bud)

```json
{
  "proto":"0.1","type":"run","id":"01...","ts":1731,
  "run_id":"run_01H...",
  "cmd":"git clone https://github.com/foo/bar && cd bar && ./run.sh",
  "cwd":"~",
  "env":{"CI":"1","GIT_ASKPASS":"/bin/true","LANG":"C.UTF-8"},
  "timeout_ms":1800000,
  "use_pty":false,
  "shell":"/bin/bash",                   // OPTIONAL (default: see capabilities)
  "ext":{}
}
```

**Rules**

* Bud MUST queue if busy and queue size allows; otherwise respond with `error(code:"BUD_BUSY")`.
* Bud MUST execute in a **new process group**.
* On timeout, Bud MUST terminate as per §4.2.4.

#### 4.2.2 `stdout` / `stderr` (Bud → Backend)

```json
{
  "proto":"0.1","type":"stdout","id":"01...","ts":1731,
  "run_id":"run_01H...","seq":42,"data_b64":"...","ext":{}
}
```

* `seq`: 0‑based, MUST increase by 1 per stream.
* `data_b64`: raw bytes (base64url). Bud SHOULD split into chunks ≤ **16 KiB**.

#### 4.2.3 `log_ack` (Backend → Bud) — OPTIONAL

Allows explicit backpressure by acknowledging receipt up to sequence `upto`.

```json
{
  "proto":"0.1","type":"log_ack","id":"01...","ts":1731,
  "run_id":"run_01H...","stream":"stdout","upto":84,"ext":{}
}
```

Bud MAY drop buffered chunks with `seq ≤ upto`.

#### 4.2.4 `cancel` (Backend → Bud)

```json
{ "proto":"0.1","type":"cancel","id":"01...","ts":1731,
  "run_id":"run_01H...","reason":"user","ext":{} }
```

* On `cancel`, Bud MUST:

  1. send **SIGTERM** to the **process group**,
  2. wait **5 s**, then
  3. send **SIGKILL**.
* Bud MUST still emit `run_finished`.

#### 4.2.5 `run_finished` (Bud → Backend)

```json
{
  "proto":"0.1","type":"run_finished","id":"01...","ts":1731,
  "run_id":"run_01H...",
  "exit_code":137,
  "canceled":true,
  "signal":"SIGKILL",
  "killed_after_ms":5000,
  "duration_ms":123456,
  "ext":{}
}
```

* If normal exit: `canceled:false`, omit `signal/killed_after_ms`.

---

### 4.3 Liveness & Errors

#### 4.3.1 `heartbeat` (Bud → Backend)

```json
{ "proto":"0.1","type":"heartbeat","id":"01...","ts":1731,"ext":{} }
```

#### 4.3.2 `ping` / `pong` (Backend ⇄ Bud) — OPTIONAL

Used by either side for latency checks.

```json
{ "proto":"0.1","type":"ping","id":"01...","ts":1731,"ext":{} }
{ "proto":"0.1","type":"pong","id":"01...","ts":1731,"ext":{} }
```

#### 4.3.3 `error` (Either direction)

```json
{
  "proto":"0.1","type":"error","id":"01...","ts":1731,
  "code":"EXEC_FAILED",
  "run_id":"run_01H...",     // OPTIONAL
  "message":"Process spawn failed",
  "ext":{}
}
```

**Codes**: see §8.

---

## 5. Ordering, Delivery, and Limits

* **Per‑run stream ordering**: Bud MUST preserve intra‑stream order (`stdout`, `stderr` each maintain `seq`).
* **At‑least‑once** delivery: Backend MUST de‑dupe on `(run_id, stream, seq)`.
* **Chunk sizes**: Bud SHOULD keep chunks ≤ **16 KiB**.
* **In‑flight window**: Bud SHOULD keep ≤ **128** unsent or un‑acked chunks per stream to avoid memory blowups.
* **Timeouts**:

  * Default per‑run timeout is given by `timeout_ms`.
  * Backend MAY impose a wall‑clock limit server‑side (out of scope for protocol).
* **Queue**: Bud SHOULD cap incoming `run` queue at **10**; when full, return `error(code:"BUD_BUSY")`.

---

## 6. Execution Semantics on Bud

* Shell: Use `shell` if set; otherwise `capabilities.shell_default`.
* Command wrapper: **`<shell> -lc "<cmd>"`**.
* Environment: Merge of Bud default env and provided `env`.

  * The following SHOULD be set by default:
    `CI=1`, `LANG=C.UTF-8`, `GIT_ASKPASS=/bin/true`, `GIT_TERMINAL_PROMPT=0`
* Process group: Each `run` MUST start a new process **group** to allow group signals on cancel.

---

## 7. Browser Event Protocol (SSE)

**Event names** and **payloads**. Every event includes:

```json
{ "event_id":"01E...", "ts":1731, "...": "..." }
```

### 7.1 Events

* `status`
  `{ "event_id":"...", "ts":1731, "phase":"queued|planning|running|canceling|succeeded|failed|canceled" }`

* `agent.message`
  `{ "event_id":"...", "ts":1731, "text":"Cloning repository..." }`

* `agent.tool_call`
  `{ "event_id":"...", "ts":1731, "name":"shell.run", "args":{"cmd":"...", "cwd":"~", "timeout_sec":600} }`

* `exec.stdout`
  `{ "event_id":"...", "ts":1731, "chunk":"base64url" }`

* `exec.stderr`
  `{ "event_id":"...", "ts":1731, "chunk":"base64url" }`

* `agent.tool_result`
  `{ "event_id":"...", "ts":1731, "name":"shell.run", "exit_code":0, "summary":"last 4KB of output..."}`

* `final`
  `{ "event_id":"...", "ts":1731, "status":"succeeded|failed|canceled", "text":"Done.", "log_truncated":false }`

### 7.2 SSE framing

Server MUST emit in this format:

```
id: 01E...
event: agent.message
data: {"event_id":"01E...","ts":1731,"text":"..."}

\n
```

* Keep‑alive: `: heartbeat\n\n`
* Resume: Client MAY send header `Last-Event-ID: 01E...`; server SHOULD replay from a small ring buffer if available.

---

## 8. Error Codes

**Enrollment & Identity**

* `AUTH_FAILED` — invalid token or token expired/consumed.
* `PROTO_VERSION_MISMATCH` — incompatible `proto`.
* `PROOF_INVALID` — bad HMAC in `hello_proof`.

**Execution**

* `BUD_BUSY` — queue full or active run prevents another.
* `EXEC_FAILED` — spawn error or non‑recoverable failure.
* `TIMEOUT` — `timeout_ms` exceeded.
* `CANCELED` — user/system initiated cancellation.
* `BUD_DISCONNECTED` — WS dropped during run.
* `SERVER_RESTARTED` — backend restarted during run.

**Transport**

* `FLOW_CONTROL` — sender violated in‑flight/size limits.
* `MALFORMED_FRAME` — invalid JSON or missing required fields.

---

## 9. Capabilities (Bud → Backend)

Sent in `hello.capabilities` to let the backend adapt:

```json
{
  "max_concurrency": 1,         // integer >= 1
  "supports_pty": false,        // reserved for future
  "shell_default": "/bin/sh",   // default shell path
  "os_release": "Ubuntu 22.04", // optional
  "ext": {}
}
```

Backends MUST NOT rely on unsupported features without checking.

---

## 10. Flows (Illustrative)

### 10.1 First‑time Enrollment

```
Bud                  Backend
---                  -------
hello(token)   ─────▶ validate token; mint bud_id + device_secret
hello_ack(bud_id, device_secret, session_id) ◀────
(connected)
```

### 10.2 Reconnection (Challenge/Response)

```
Bud                  Backend
---                  -------
hello(bud_id)  ─────▶ issue nonce
hello_challenge(nonce) ◀────
hello_proof(hmac(nonce, device_secret)) ─────▶ verify proof
hello_ack(session_id) ◀────
(connected)
```

### 10.3 Run + Streaming + Finish

```
Backend → Bud: run{run_id, cmd, ...}
Bud → Backend: stdout/stderr(seq=0..N)
Bud → Backend: run_finished{exit_code,...}
```

### 10.4 Cancel

```
Browser: POST /api/runs/:id/cancel
Backend → Bud: cancel{run_id}
Bud: SIGTERM group → wait 5s → SIGKILL group
Bud → Backend: run_finished{canceled:true, signal:"SIGKILL"}
Backend → Browser SSE: status=canceling → final=canceled
```

---

## 11. Validation (JSON Schema, excerpts)

> The spec uses JSON for transport. Below are simplified JSON Schemas for key frames. Full schemas can live under `/docs/schema/`.

### 11.1 Envelope (subschema)

```json
{
  "$id": "https://bud.dev/schema/envelope-0.1.json",
  "type": "object",
  "properties": {
    "proto": { "const": "0.1" },
    "type": { "type": "string" },
    "id":   { "type": "string" },
    "ts":   { "type": "number" },
    "ext":  { "type": "object" }
  },
  "required": ["proto","type","id","ts","ext"],
  "additionalProperties": true
}
```

### 11.2 `run`

```json
{
  "$id": "https://bud.dev/schema/run-0.1.json",
  "allOf": [{ "$ref": "envelope-0.1.json" }],
  "properties": {
    "type": { "const": "run" },
    "run_id": { "type": "string" },
    "cmd": { "type": "string", "minLength": 1 },
    "cwd": { "type": "string" },
    "env": { "type": "object", "additionalProperties": { "type": "string" } },
    "timeout_ms": { "type": "integer", "minimum": 1000 },
    "use_pty": { "type": "boolean" },
    "shell": { "type": "string" }
  },
  "required": ["run_id","cmd","timeout_ms"]
}
```

### 11.3 `stdout`/`stderr`

```json
{
  "$id": "https://bud.dev/schema/stream-0.1.json",
  "allOf": [{ "$ref": "envelope-0.1.json" }],
  "properties": {
    "type": { "enum": ["stdout","stderr"] },
    "run_id": { "type": "string" },
    "seq": { "type": "integer", "minimum": 0 },
    "data_b64": { "type": "string" }
  },
  "required": ["run_id","seq","data_b64"]
}
```

---

## 12. Security Considerations

* **Enrollment tokens** MUST be time‑limited, single‑use, and hashed at rest.
* **Device secrets** MUST be stored server‑side and on Bud with restrictive perms (0600). Never log secrets.
* **Reconnections** SHOULD use challenge‑response (`hello_challenge`/`hello_proof`).
* **Process execution** MUST run as a non‑privileged user; server SHOULD apply deny‑list on commands.
* **TLS** MUST be used for WSS.
* **SSE** responses MUST disable proxy buffering to avoid head‑of‑line blocking.

---

## 13. Error Handling & Close

* On fatal errors, sender SHOULD send an `error` frame then close the socket.
* Receivers SHOULD tolerate transient duplicates and out‑of‑order frames (use `(run_id, stream, seq)`).
* The server MAY close with WebSocket close code 1008 (policy violation) for size/window abuse.

---

## 14. Changelog

* **0.1**

  * Initial PoC spec.
  * Enrollment & challenge/response handshake.
  * Single `run` execution model, streaming, and cancel.
  * SSE event catalog and resume semantics.
  * Reserved `ext` on all frames; capability advertisement.
