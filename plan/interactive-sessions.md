# Bud Interactive Sessions — Comprehensive Spec

*(PTY baseline with optional `tmux` durability backend)*

> **Purpose:** Add first‑class interactive sessions to Bud so users and agents can open a CLI/TUI, interact over time, and (optionally) **resume after Bud daemon restarts**. The baseline uses a native PTY owned by Bud; the durable mode uses **tmux** when available.

---

## 0) Scope & Goals

**Goals**

* Open long‑lived interactive **sessions** (distinct from one‑off **runs**).
* Bi‑directional streaming (keystrokes ↔ screen bytes), resize, cancel.
* **Detach/attach** across browser/backend hiccups.
* Optional **durability** across **Bud restarts** using `tmux`.
* Clean writer/spectator semantics; one active writer per session.
* Production‑ready cancel semantics, TTLs, GC, metrics.

**Non‑Goals (for now)**

* Survival across **host reboots** (requires supervisor/container; out of scope).
* Multi‑pane/window tmux UX (we constrain to 1 window/1 pane).
* Full tmux **control mode** parser (can be a later upgrade).

---

## 1) Terminology

* **Run:** one‑off non‑interactive command (current PoC).
* **Session:** long‑lived interactive process with a TTY/PTY.
* **Backend (for sessions):** implementation behind the scenes:

  * `pty` — native pseudo‑terminal owned by Bud (default).
  * `tmux` — session hosted inside a tmux server (durable).
* **Writer:** the single client (UI or agent) allowed to send input.
* **Spectator:** read‑only viewer(s).

---

## 2) High‑Level Architecture Additions

* **Bud (Rust):** adds session manager with pluggable **SessionBackend**.
* **Backend (Node/TS):** introduces `/term` WebSocket for terminal I/O and `/api/sessions` REST for control; SSE continues for status/events.
* **Web UI (React):** terminal component (xterm.js), writer lease UI, “Keep running if I leave” toggle → chooses `tmux`.

---

## 3) Capabilities & Discovery

### 3.1 Bud Hello Extension (WSS)

Bud advertises session support and tmux availability.

**hello (Bud→Backend) add:**

```json
{
  "type":"hello", "proto":"0.1",
  "caps":{
    "sessions": true,
    "sessions_backends": ["pty", "tmux"],   // or ["pty"] if tmux missing
    "tmux_version": "3.3a"                  // optional
  }
}
```

**hello_ack (Backend→Bud)** remains unchanged. Backend stores capabilities and surfaces them in `/api/buds`.

---

## 4) Session Lifecycle

```
created → open → (attached | detached)* → (paused | running) → (closed | canceled | failed)
```

**Key semantics**

* **Attach/Detach:** network‑level; the session continues when no client is attached.
* **Pause/Resume (optional):** SIGSTOP/SIGCONT the process group (backend‑agnostic).
* **Close:** graceful EOF then TERM→5s→KILL (same as runs).

---

## 5) Wire Protocol — Bud ⇄ Backend (WSS JSON + binary)

> Reuse your frame envelope (`type`, `proto`, `message_id`, `sent_at`, `extensions`).
> Chunk size ≤ **16 KB**, at most **128 in‑flight** per session (backpressure).

### 5.1 Control Frames

**session_open (Backend→Bud)**

```json
{
  "type":"session_open",
  "session_id":"sess_01H...",
  "backend":"pty",                     // "pty" | "tmux" (default "pty")
  "cmd":"/bin/bash -l",
  "args":[],
  "cwd":"~",
  "env":{"LANG":"C.UTF-8"},
  "pty":{"rows":24,"cols":80},
  "timeouts":{
    "idle_kill_sec":1200,             // inactivity: no input & no output
    "hard_ttl_sec":43200,             // absolute max
    "linger_on_disconnect_sec":600    // keep alive without attachments
  }
}
```

**session_opened (Bud→Backend)**

```json
{
  "type":"session_opened",
  "session_id":"sess_01H...",
  "backend":"pty",
  "pid":12345,                        // foreground child (PTY) or tmux pane pid
  "started_at":1731820000000
}
```

**session_resize (Backend→Bud)**

```json
{ "type":"session_resize", "session_id":"sess_01H...", "rows":40, "cols":120 }
```

**session_close (Backend→Bud)**

```json
{ "type":"session_close", "session_id":"sess_01H...", "reason":"user_request" }
```

**session_pause / session_resume (Backend→Bud)** *(optional)*

```json
{ "type":"session_pause",  "session_id":"sess_01H..." }
{ "type":"session_resume", "session_id":"sess_01H..." }
```

**session_attach / session_detach (Backend→Bud)**

```json
{ "type":"session_attach", "session_id":"sess_01H...", "from_seq":1000 }
{ "type":"session_detach", "session_id":"sess_01H..." }
```

**session_closed (Bud→Backend)**

```json
{
  "type":"session_closed",
  "session_id":"sess_01H...",
  "exit_code":0,
  "signal":null,
  "canceled":false,
  "duration_ms":123456,
  "bytes_out":1234567
}
```

**session_error (Bud→Backend)**

```json
{
  "type":"session_error",
  "session_id":"sess_01H...",
  "code":"tmux_unavailable",         // see §13 error codes
  "message":"tmux not installed"
}
```

### 5.2 Data Frames (binary preferred)

**session_output (Bud→Backend)**

* *Binary WS payload* containing raw bytes; metadata in JSON sidecar:

```json
{ "type":"session_output", "session_id":"sess_01H...", "seq":42, "stream":"pty", "binary":true }
```

**session_input (Backend→Bud)**

* *Binary WS payload* of bytes to write:

```json
{ "type":"session_input", "session_id":"sess_01H...", "seq":7, "binary":true }
```

> If binary is not possible end‑to‑end, fallback to base64 `data:"<base64>"`.

---

## 6) Browser ⇄ Backend APIs

### 6.1 REST

* `POST /api/sessions` → `{ session_id, attach_token, backend }`
  Body:

  ```json
  { "thread_id":"...", "bud_id":"...", "backend":"pty|tmux", "cmd":"/bin/bash -l", "cwd":"~", "rows":24, "cols":80 }
  ```
* `POST /api/sessions/:id/close` → `{ ok:true }`
* `POST /api/sessions/:id/pause|resume` → `{ ok:true }`
* `GET /api/sessions/:id` → metadata (status, backend, ttl, started_at, last_activity, writer, spectators)
* `GET /api/sessions?bud_id=...` → list (including detached/alive)
* `POST /api/sessions/:id/take-writer` → lease control; returns new `attach_token`

### 6.2 WebSocket `/term` (Browser⇄Backend)

* **Client→Server** JSON control:

  * `attach { session_id, attach_token, from_seq? }`
  * `input { bytes }` *(binary frames preferred)*
  * `resize { rows, cols }`
  * `detach {}`
* **Server→Client:**

  * `output { seq }` *(binary frames with data)*
  * `status { attached|detached|closed, reason? }`
  * `error { code, message }`

**Auth**: `attach_token` is a short‑lived JWT scoped to `{session_id, role: "writer"|"spectator"}`.

---

## 7) Data Model

```sql
create table session (
  session_id      text primary key,
  bud_id          text not null references bud(bud_id) on delete cascade,
  thread_id       uuid references thread(thread_id) on delete set null,
  backend         text not null check (backend in ('pty','tmux')),
  status          text not null, -- open|detached|closed|canceled|failed
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  exit_code       int,
  signal          text,
  bytes_out       bigint not null default 0,
  writer_user_id  text, -- current writer lease holder
  hard_ttl_sec    int not null default 43200,
  idle_kill_sec   int not null default 1200
);

-- Streamed bytes; same model as run_log (bytea!).
create table session_log (
  session_id      text not null references session(session_id) on delete cascade,
  seq             bigint not null,
  data            bytea not null,
  created_at      timestamptz not null default now(),
  primary key (session_id, seq)
);
create index session_log_created_idx on session_log(session_id, created_at);
```

> For huge/long sessions, tee logs to object storage and mark `logs_blob_url` in `session`.

---

## 8) Bud Implementation

### 8.1 Session Manager

* Map: `sessions: SessionId → SessionHandle`.
* **Backpressure:** limit **128** in‑flight output frames per session; drop or stall writes when backend is slow.
* **Ring buffer:** in‑memory **4 MB** per session for re‑attach (`from_seq`).
* **Process groups:** each session runs in its own PGID; cancel = TERM→5s→KILL the group.
* **Idle/TTL/Linger:** close on idle; enforce hard TTL; keep alive for `linger_on_disconnect_sec` without attachments.

### 8.2 Backend Interface (Rust)

```rust
#[async_trait]
trait SessionBackend {
  async fn open(&self, opts: OpenOpts) -> Result<Handle>;
  async fn write(&self, id: &SessionId, bytes: &[u8]) -> Result<()>;
  async fn resize(&self, id: &SessionId, rows: u16, cols: u16) -> Result<()>;
  async fn pause(&self, id: &SessionId) -> Result<()>;  // SIGSTOP PGID
  async fn resume(&self, id: &SessionId) -> Result<()>; // SIGCONT PGID
  async fn close(&self, id: &SessionId, graceful: bool) -> Result<()>;
  async fn adopt_existing(&self) -> Result<Vec<Summary>>; // esp. for tmux
}
```

#### 8.2.1 `pty` backend

* Crate: `portable-pty`.
* Spawn child under PTY; set env (`LANG`, `CI=1`, `GIT_ASKPASS=/bin/true`), cwd.
* Reader task copies master PTY → `session_output`.
* Writer task writes bytes on `session_input`.
* Resize via PTY ioctl.
* Pause/resume via signals on PGID.

#### 8.2.2 `tmux` backend (Pattern A — attach client per writer)

* **Detect** tmux at startup; check version; set caps accordingly.
* **Server isolation:** start `tmux` server under Bud’s user:

  ```
  tmux -L bud_<budid> -S ~/.bud/tmux/bud.sock -f ~/.bud/tmux.conf start-server
  ```

  `~/.bud/tmux.conf`:

  ```
  set -g status off
  set -g mouse off
  set -g focus-events on
  set -g escape-time 0
  set -g default-terminal "screen-256color"
  set -as terminal-overrides ",*:Tc"
  ```
* **Open:** `tmux new-session -d -t s_<session_id> -x <cols> -y <rows> "<cmd>"`
* **Attach stream:** spawn child `tmux attach -t s_<session_id>`; wire its stdio to WSS bridge.
* **Input:** write to the child’s stdin (goes to tmux).
* **Resize:** `tmux resize-window -t s_<session_id> -x <cols> -y <rows>`.
* **Detach:** kill only the attach child.
* **Close:** `tmux kill-session -t s_<session_id>`.
* **Adopt:** on Bud startup, `tmux -L bud_<budid> list-sessions -F '#{session_name}'`, re‑map `s_*` sessions to `session_id`s.

> Later upgrade path: switch streaming to **tmux control mode (`-C`)** to support efficient multi‑viewer without extra attach processes.

**Security (tmux):**

* Socket dir `~/.bud/tmux` with `0700` perms; run as **non‑privileged** Bud user.
* One tmux **server** per Bud for isolation; never reuse OS‑global socket.
* Enforce **GC** and TTLs to avoid orphaned sessions.

---

## 9) Backend Implementation

* **/ws Bud gateway:** route new `session_*` frames; enforce budgets (bytes/sec per session, total in‑flight).
* **/term WebSocket:** multiplex multiple browser clients to one Bud session; lease a single **writer**; others are spectators.
* **Attach tokens:** short‑lived JWT `{ session_id, role, user_id, exp }`.
* **SSE:** emit high‑level events:

  * `session.status { session_id, status }`
  * `session.writer_changed { user_id }`
  * `session.final { exit_code, signal, bytes_out }`

---

## 10) Web UI

* **Terminal view** (xterm.js):

  * Binary WS for output/input; 60fps render throttle; handle paste & bracketed paste.
  * Controls: **Detach**, **Stop**, **Pause/Resume**, **Take writer**.
  * Toggle: **“Keep running if I leave”** → sets backend to `tmux` (if available), else disabled with tooltip “tmux not available”.
* **List & re‑attach:** show all sessions (open/detached), with **Re‑attach** button.
* **Copy as text:** strip ANSI server‑side; download transcript.

---

## 11) Performance

* Use **binary WebSocket frames** for data; **permessage‑deflate** enabled on both hops.
* Chunk ≤ **16 KB**, window **128**; adaptive coalescing for small bursts.
* Per‑session ring **4 MB**; per‑Bud max concurrent sessions default **8**.
* UI render throttle; collapse bursts from chatty TUIs (`htop`, `watch`).

---

## 12) Security & Safety

* All sessions run as **non‑privileged** user; no `sudo`.
* **Denylist** pre‑check for obviously destructive commands (as with runs).
* **Writer lease**: only one writer at a time, with “take over” consent UI.
* **Audit trail:** log writer changes, pauses, closes.
* **Redaction (optional):** best‑effort secrets masking in archived transcripts.

---

## 13) Errors & Codes (common)

* `tmux_unavailable` — tmux not installed or below min version.
* `backend_unsupported` — requested backend not in Bud caps.
* `session_not_found`
* `session_closed`
* `writer_conflict` — another writer holds the lease.
* `rate_limited` — bytes/sec exceeded.
* `invalid_resize`
* `ttl_expired` / `idle_timeout`

---

## 14) Observability

* **Metrics (Bud):** sessions_open, bytes_out/in per session, inflight_frames, throttles, p95 write latency, SIGKILL count.
* **Metrics (Backend):** /term WS connections, attach/detach counts, writer handoffs, compressor ratio.
* **Logs:** lifecycle transitions, errors/codes, GC actions.

---

## 15) Testing Matrix (core)

* Open/write/resize/detach/attach/close (pty & tmux).
* Idle/TTL/linger timers.
* Cancel during large output.
* Writer lease contention.
* Backend restart while session active (browser recovers).
* Bud restart: **pty fails** (session gone) vs **tmux survives** (adopt).
* tmux missing → “durable” toggle disabled and server returns `tmux_unavailable`.

---

## 16) Configuration

**Bud (env / flags)**

```
SESSIONS_MAX=8
SESSION_RING_BYTES=4194304
SESSION_OUT_INFLIGHT=128
SESSION_IDLE_KILL_SEC=1200
SESSION_HARD_TTL_SEC=43200
SESSION_LINGER_SEC=600

# tmux
TMUX_ENABLE=true               # can be false even if tmux exists
TMUX_MIN_VERSION=3.2
TMUX_SOCKET=~/.bud/tmux/bud.sock
TMUX_LABEL=bud_<budid>
```

**Backend**

```
TERM_WS_PERMESSAGE_DEFLATE=true
SESSION_ATTACH_TOKEN_TTL_SEC=600
SESSION_DB_SOFT_CAP_BYTES=100000000
```

---

## 17) Compatibility & Migration

* Protocol stays at `proto:"0.1"`; sessions are **additive** types.
* Legacy Buds (no `caps.sessions`) simply won’t be offered session UI.

---

# Phased Build Plan (stacked on your existing phases)

> We’ll introduce sessions incrementally, **stubbing tmux early** so the UI can show “Durable (tmux) unavailable” until the backend is ready.

### Phase 4.5 — Plumbing & Stubs

**Deliverables**

* Extend Bud **hello** to include `caps.sessions` and `sessions_backends`.
* Backend `/api/buds` surfaces caps.
* Web UI: terminal tab gated by capability. Add **“Keep running if I leave (tmux)”** toggle; when selected but unavailable, show tooltip and block.
* Backend: `/api/sessions` and `/term` WS endpoints **stubbed**; return `501 Not Implemented` or `tmux_unavailable` where appropriate.

**Acceptance**

* UI displays correct capability state; durable toggle disabled when `tmux` missing.

---

### Phase 4.6 — Native PTY Sessions (MVP)

**Deliverables**

* Bud: `pty` backend (open/write/output/resize/close), ring buffer, timers (idle, hard TTL, linger), PGID signals.
* Backend: `/term` WS with **binary frames**; writer lease; spectators (read‑only).
* SSE: `session.status`, `session.final`.
* DB: `session` & `session_log` tables; soft cap & truncation flag.

**Acceptance**

* Open bash; type; resize; detach/attach; stop; transcripts stored with truncation notice if capped.

---

### Phase 4.7 — Reliability & Perf

**Deliverables**

* Backpressure windows, adaptive chunking, permessage‑deflate.
* Attach tokens (JWT), “Take writer” flow.
* Observability: core metrics & structured logs.
* UI: ANSI‑stripped “Copy as text”; 60fps render.

**Acceptance**

* Survives backend restarts; throttles chatty TUIs; metrics visible.

---

### Phase 4.8 — tmux **Stubs** & Capability UX (No tmux yet)

**Deliverables**

* Backend accepts `backend:"tmux"` but returns `tmux_unavailable` if Bud caps lack it.
* UI: clear messaging when user selects durable mode on unsupported Buds.
* Docs: “How to enable tmux” guide (install, path, terminfo).

**Acceptance**

* Attempting “durable” on a non‑tmux Bud yields clean, actionable error; standard PTY still works.

---

### Phase 5.0 — tmux (Minimal Durable) — **Pattern A**

**Deliverables**

* Bud: tmux server management (`-L`/`-S`, socket perms, `~/.bud/tmux.conf`), create/attach/detach/resize/close; **adopt existing** sessions on Bud start.
* Backend: surfacing tmux sessions in `/api/sessions` (detached/alive), re‑attach flow.
* UI: durable toggle enabled where supported; sessions survive Bud restart.

**Acceptance**

* Start interactive program under tmux; kill Bud; restart Bud; re‑attach and find the TUI “in the same spot.”
* GC respects idle/hard TTL; sockets cleaned.

---

### Phase 5.1 — tmux Multi‑viewer & Backfill

**Deliverables**

* Multiple spectators via additional `tmux attach -r` clients (cap or pool).
* On attach, **backfill** scrollback: `tmux capture-pane -e -p -S -2000` before live stream.
* Better close semantics (EOF, SIGINT, KILL options).

**Acceptance**

* Two spectators viewing same durable session; new attach sees last N lines instantly.

---

### Phase 5.2 — Production Polish (Optional)

**Deliverables**

* Option to switch streaming to **tmux control mode (-C)** for single upstream connection & structured updates.
* Terminfo bundling (`tmux-256color`) or fallback logic.
* Session export/download to object storage beyond DB caps.
* Admin GC sweeper; quotas.

**Acceptance**

* Efficient multi‑viewer under load; clean color handling across distros; transcripts exportable.

---

### Phase 5.3 — Docs & Hardening

**Deliverables**

* User docs (durable vs standard), troubleshooting (TERM, terminfo).
* Operator docs (caps, envs, metrics).
* Chaos tests (network flap, backend restart, Bud restart).
* Security review (socket perms, writer lease, audit logs).

**Acceptance**

* New dev can enable tmux, run the full loop locally, and verify durability.

---

## Appendix A — tmux Commands at a Glance

* Start server:

  ```
  tmux -L bud_<budid> -S ~/.bud/tmux/bud.sock -f ~/.bud/tmux.conf start-server
  ```
* New session:

  ```
  tmux -L bud_<budid> new-session -d -s s_<session_id> -x <cols> -y <rows> "<cmd>"
  ```
* Attach (writer):

  ```
  tmux -L bud_<budid> attach -t s_<session_id>
  ```
* Attach (spectator):

  ```
  tmux -L bud_<budid> attach -r -t s_<session_id>
  ```
* Resize:

  ```
  tmux -L bud_<budid> resize-window -t s_<session_id> -x <cols> -y <rows>
  ```
* Close:

  ```
  tmux -L bud_<budid> kill-session -t s_<session_id>
  ```
* List / adopt:

  ```
  tmux -L bud_<budid> list-sessions -F "#{session_name}"
  ```

---

## Appendix B — Writer Lease Policy

* Default lease TTL: **10 min** inactivity (auto‑release).
* **Takeover** prompts existing writer (if attached) and forces detach after **5s** if no response.
* All lease changes logged to `session` audit stream.

---

With this spec and phased plan, you can ship **interactive sessions** quickly on top of the existing PoC, deliver immediate value with the **PTY** backend, and flip on **tmux durability**—cleanly and visibly—once the stubs are in place and hosts are prepared.
