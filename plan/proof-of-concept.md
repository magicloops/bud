# Bud — Proof‑of‑Concept Plan

**Goal:** A minimal but end‑to‑end working system where a user installs **Bud** (a Rust daemon) on a machine, it phones home to the backend over **WSS**, appears in a web UI, and a **tool‑calling agent** (OpenAI GPT‑5 via Responses API) can answer questions or run shell commands on that machine. PoC emphasizes simplicity, cancels cleanly, and leaves room for production‑grade evolution and open‑source use.

---

## 1) High‑Level Description

* **Bud (device agent):** A single Rust binary the user runs on Linux (first) or macOS (next). It makes an outbound **WSS** connection to the backend, receives “run shell command” requests, executes them locally, and streams logs back. It supports **cancel** (TERM → 5s → KILL).
* **Backend (Node/TS monolith):** Hosts the **WS gateway** for Buds, an **agent** that talks to OpenAI’s **Responses API** using a **tool‑calling loop** (one tool initially: `shell.run`), a **REST API**, and a **real‑time SSE stream** to the browser. Persists state in **Supabase Postgres**.
* **Web UI (Vite + React):** Lists connected Buds, provides a per‑Bud **chat thread**, shows **interleaved agent messages** and **live shell output**, and exposes a **Stop** button that cancels both the Bud process and the in‑flight OpenAI request.
* **Infra:** Single region; domain **`bud.dev`**; TLS; Supabase for Postgres. OSS‑friendly: everything also runs locally with vanilla Postgres and a mock LLM.

**Non‑goals (PoC):** Proxy/MITM, multi‑tenant auth/RBAC, schedulers/alerts, artifacts store beyond stdout/stderr, Windows support, auto‑update/signing, compliance.

---

## 2) Architecture Overview

```
[ Vite + React (SSE+REST) ]
            │
            ▼
[ Node/TS Backend (API + SSE + Agent + WSS Gateway) ]───►[ OpenAI Responses API ]
            ▲
            │ WSS (JSON)
            ▼
           [ Bud (Rust daemon) ]

               [ Supabase Postgres ]
```

* **Transport choices**

  * Bud ⇄ Backend: **WSS** at `wss://bud.dev/ws`, JSON messages.
  * Browser ⇄ Backend: **REST** + **SSE** (keep‑alive, resume with Last‑Event‑ID).

* **Agent style**

  * **Multi‑turn tool‑calling**: the model decides whether to answer directly or call the `shell.run` tool (possibly multiple times) before producing a final answer.

---

## 3) Components & Boundaries

### 3.1 Bud (Rust)

* **Crates:** `tokio`, `tokio-tungstenite`, `rustls` + `rustls-native-certs`, `serde`, `serde_json`, `clap`, `tracing`, `nix` (process group).

* **Core behaviors**

  * Connect WSS + auto‑reconnect (jittered backoff).
  * Send `hello` with token (first boot) or `bud_id` + HMAC (reconnect).
  * **Single worker** runs one command at a time; FIFO queue length **10**.
  * Execute `/bin/bash -lc` if present, else `/bin/sh -lc`; set `CI=1`, `GIT_ASKPASS=/bin/true`, `LANG=C.UTF‑8`.
  * **Cancel:** send SIGTERM to the process **group**, wait **5s**, then SIGKILL; always emit `run_finished`.
  * Stream stdout/stderr chunks (≤16 KB) base64‑encoded with monotonic `seq`.

* **Local config**

  * `~/.bud/identity.json` (0600): `{ bud_id, device_secret, server_url, name, default_cwd }`

### 3.2 Backend (Node/TypeScript)

* **Modules**

  * `wsGateway`: `/ws` server; handles `hello/ack`, heartbeats, routes `run/cancel`, ingests `stdout/stderr/finished`.
  * `registry`: in‑memory map of online Buds (mirrored to DB timestamps).
  * `agent`: provider‑agnostic **LLMAdapter** (OpenAI Responses API first) implementing multi‑turn tool‑calling with streaming + **cancel**.
  * `api`: REST endpoints for Buds, threads, messages, runs.
  * `sse`: SSE endpoint for run events with keep‑alive and `Last-Event-ID`.
  * `db`: Supabase/Postgres connection; migrations (Drizzle or Prisma).
  * `events`: in‑proc pub/sub, run‑scoped ring buffer for SSE replay.

* **Secrets & config (env)**

  ```
  PORT=3000
  BASE_URL=https://bud.dev
  DATABASE_URL=postgres://...            # Supabase
  OPENAI_API_KEY=...
  SESSION_SECRET=dev-secret
  WS_HEARTBEAT_SEC=30
  RUN_WALL_CLOCK_MIN=30
  STEP_TIMEOUT_SEC=600
  RUN_LOG_MAX_BYTES=104857600            # 100MB soft cap
  ```

### 3.3 Web UI (Vite + React)

* **Views**

  * **Buds list**: name, OS/arch, version, online/offline, last seen.
  * **Thread**: chat composer; events stream; tool chips; log tail (virtualized); **Stop** button. “Unsafe PoC” banner and truncation warnings.
* **SSE client**

  * Auto‑reconnect; uses `Last-Event-ID` to resume; auto‑scroll with pause.

---

## 4) Protocol (WSS) — Bud ⇄ Backend

* **Every frame** includes: `type`, `proto:"0.1"`, `message_id`, `sent_at`, and reserved `extensions:{}`.

**hello (Bud→Backend)**

```json
{
  "type":"hello", "proto":"0.1",
  "name":"raspi-4", "os":"linux", "arch":"arm64", "version":"0.1.0",
  "token":"<enrollment-token-or-empty>",
  "bud_id":"b_01H...",                // optional on reconnect
  "hmac":"base64url..."               // HMAC(nonce, device_secret) if bud_id present
}
```

**hello_ack (Backend→Bud)**

```json
{
  "type":"hello_ack", "session_id":"s_01H...", "bud_id":"b_01H...",
  "device_secret":"base64url...",     // only on first enroll
  "nonce":"base64url...", "heartbeat_sec":30
}
```

**run (Backend→Bud)**

```json
{
  "type":"run", "run_id":"run_01H...",
  "cmd":"git clone https://... && cd repo && ./run.sh",
  "cwd":"~",
  "env":{"CI":"1","GIT_TERMINAL_PROMPT":"0","LANG":"C.UTF-8"},
  "timeout_ms":1800000, "use_pty":false
}
```

**cancel (Backend→Bud)**
`{ "type":"cancel", "run_id":"run_01H..." }`

**stdout / stderr (Bud→Backend)**
`{ "type":"stdout", "run_id":"run_01H...", "seq":42, "data":"<base64>" }`

**run_finished (Bud→Backend)**

```json
{
  "type":"run_finished", "run_id":"run_01H...",
  "exit_code":137, "canceled":true, "signal":"SIGKILL",
  "killed_after_ms":5000, "duration_ms":123456
}
```

**Delivery & limits**

* Bud chunks ≤ **16 KB**, up to **128 in‑flight** (backpressure).
* Max WS frame **64 KB**.
* Heartbeats every **30s**; offline after **90s** silence.

---

## 5) Browser API (REST + SSE)

**REST**

* `GET /api/buds` → `[ {bud_id, name, os, arch, version, status, last_seen_at} ]`
* `POST /api/threads` body: `{ bud_id, title? }` → `{ thread_id }`
* `POST /api/threads/:thread_id/messages` body: `{ role: "user", text }` → `{ run_id }`
* `POST /api/runs/:run_id/cancel` → `{ ok: true }`
* `GET /api/runs/:run_id` → run metadata & status

**SSE** — `GET /api/runs/:run_id/stream`

* Events (each includes `event_id` ULID for resume):

  * `status { phase }` — `queued|planning|running|canceling|succeeded|failed|canceled`
  * `agent.message { text }`
  * `agent.tool_call { name:"shell.run", args }`
  * `exec.stdout { chunk }`
  * `exec.stderr { chunk }`
  * `agent.tool_result { name, exit_code, summary }`
  * `final { text, status, log_truncated }`

**SSE reliability**

* Keep‑alive comment every **15s**.
* In‑proc ring buffer (~**5k** events) to support `Last-Event-ID` replay.

---

## 6) Data Model (Supabase Postgres)

*Major tables (simplified) — add multi‑tenant columns now to keep doors open.*

```sql
-- Devices
create table bud (
  bud_id        text primary key,
  name          text not null,
  os            text not null,
  arch          text not null,
  version       text,
  status        text not null default 'offline', -- online|offline
  last_seen_at  timestamptz,
  device_secret text,       -- opaque; stored server-side
  device_pubkey text,       -- reserved for future mTLS/attestation
  tenant_id     text, created_by_user_id text,
  created_at    timestamptz not null default now()
);

-- Enrollment tokens (copy/paste)
create table enrollment_token (
  token_hash    text primary key,     -- hash(token)
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  consumed_at   timestamptz
);

create table thread (
  thread_id     uuid primary key default gen_random_uuid(),
  bud_id        text not null references bud(bud_id) on delete cascade,
  title         text,
  tenant_id     text, created_by_user_id text,
  created_at    timestamptz not null default now()
);

create table message (
  message_id    uuid primary key default gen_random_uuid(),
  thread_id     uuid not null references thread(thread_id) on delete cascade,
  role          text not null check (role in ('user','assistant','tool')),
  content       text not null,
  tenant_id     text, created_by_user_id text,
  created_at    timestamptz not null default now()
);

create table run (
  run_id        text primary key,     -- ULID/string
  thread_id     uuid not null references thread(thread_id) on delete cascade,
  status        text not null,        -- queued|planning|running|canceling|succeeded|failed|canceled
  started_at    timestamptz,
  finished_at   timestamptz,
  error         text,
  step_count    int not null default 0,
  logs_bytes    bigint not null default 0,
  log_truncated boolean not null default false,
  logs_blob_url text,                 -- S3/minio later
  workspace_path text,
  canceled      boolean not null default false,
  canceled_at   timestamptz,
  canceled_by_user_id text,
  tenant_id     text, created_by_user_id text,
  created_at    timestamptz not null default now()
);

create table run_step (
  step_id       uuid primary key default gen_random_uuid(),
  run_id        text not null references run(run_id) on delete cascade,
  idx           int not null,         -- 0..N
  tool          text not null,        -- 'shell.run'
  args_json     jsonb not null,
  tool_meta_json jsonb,               -- provider ids, timings, etc.
  exit_code     int,
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Binary-safe log chunks (prefer bytea over base64 at rest)
create table run_log (
  run_id        text not null references run(run_id) on delete cascade,
  seq           bigint not null,
  stream        text not null check (stream in ('stdout','stderr')),
  data          bytea not null,
  tenant_id     text,
  created_at    timestamptz not null default now(),
  primary key (run_id, seq)
);
```

**Indexes (examples)**

* `create index run_thread_idx on run(thread_id, started_at desc);`
* `create index run_log_stream_idx on run_log(run_id, stream, seq);`

---

## 7) Agent Execution Model (Responses API)

* **LLMAdapter**: an internal interface (`send(messages, tools, opts)`) with:

  * streaming callbacks (`onToken`, `onToolCall`, `onFinal`, `onError`)
  * returns `request_id/response_id` so we can **cancel server‑side**.

* **Loop**

  1. User message → create `run` (status `planning|running`).
  2. Call model with tool schema for `shell.run`.
  3. If model returns **final answer** → emit `agent.message` and `final`.
  4. If model calls **`shell.run`** → create `run_step`, dispatch `run` to Bud, stream `exec.*` events; on finish, summarize last N KB + exit code; send back to model as tool result; loop.
  5. Caps: `MAX_STEPS=10`; per‑step timeout; **denylist** pre‑check.

* **Cancel**

  * If the step is a **Bud exec** → send Bud `cancel`, mark run `canceling`.
  * If the step is an **LLM call** → abort client stream and **cancel** the background request by id when available.
  * Emit `final { status:"canceled" }`.

* **Observations fed back to the model**

  * `{ exit_code, tail_stdout, tail_stderr, bytes_stdout, bytes_stderr }` (token‑bounded).

---

## 8) Run Lifecycle & State Machine

```
queued → planning → running → (succeeded | failed)
                    ↘
                    canceling → canceled
```

* **Transitions**

  * `planning` when waiting on model’s first decision.
  * `running` when a tool call is active or the model is streaming a response.
  * `cancel` request from UI → `canceling`, then → `canceled` when both LLM and Bud are stopped.
  * Backend restarts: any `running` ⇒ `failed` with reason `"server_restarted"` (PoC), or you can implement resume later.

---

## 9) Security & Safety (PoC)

* **Identity & Enrollment**

  * Enrollment tokens: 24h TTL, single use, **hashed at rest** (HMAC with server secret).
  * On enroll, server issues `bud_id` and a **device secret**; Bud stores locally; reconnects use **HMAC challenge‑response**.
  * Door open: later swap to cert‑based or TPM attestation without re‑enroll.

* **Guardrails**

  * Denylist of obviously destructive patterns (server‑side).
  * Default non‑privileged user; no `sudo`.
  * CWD default `~`, optional workspace `~/bud_runs/<run_id>`.

* **Transport**

  * TLS, 443; Bud honors `HTTPS_PROXY/NO_PROXY`.
  * Heartbeats + offline detection.

* **Logs**

  * 100 MB soft cap per run; `log_truncated` flag; future **S3/MinIO** via `logs_blob_url`.

---

## 10) Open‑Source & Production “Door‑Openers”

* **Multi‑tenancy fields present** (nullable now).
* **Provider‑agnostic LLMAdapter** (OpenAI first; others later).
* **Transport boundary** (WSS first; gRPC/long‑poll fallback later).
* **Workspace path & tool registry** (start with `shell.run`; add more tools without touching the loop).
* **Local equivalents** documented: Postgres (no‑Supabase), MinIO for S3, mock‑LLM mode.
* **License** decision tracked (Apache‑2.0 vs dual license). Telemetry default **off** for OSS build.

---

## 11) Phased Build Plan (with acceptance criteria)

### Phase 0 — Repo & Scaffolding

* Create `bud/` (Rust), `service/` (Node/TS), `web/` (Vite).
* Add `/docs/poc-plan.md`, `/docs/proto.md`.
* **DoD:** Repos compile; `docker-compose` can boot backend + Postgres locally.

### Phase 1 — DB & Schema

* Apply Supabase schema (including tenant/user, logs columns).
* Seed an enrollment token and a sample Bud row.
* **DoD:** `GET /api/buds` returns data from Postgres.

### Phase 2 — WSS Handshake & Presence

* Implement `hello/hello_ack`, enrollment token validation, device secret issuance, heartbeats, online/offline.
* Web Buds list shows presence.
* **DoD:** Running Bud appears online; flips to offline if stopped.

### Phase 3 — Exec Path (No Agent Yet)

* `POST /api/threads/:id/messages` triggers a single `run` command (fixed or user‑provided).
* Bud executes; backend streams `exec.stdout/stderr` → SSE; stores `run_log`.
* **DoD:** See live logs in browser; `run` finishes with exit code.

### Phase 4 — Agent (Tool-Calling) + SSE Interleave

* Implement **LLMAdapter** (OpenAI Responses API); add tool schema for `shell.run`.
* Agent loop: interleave agent messages, tool_call, tool_result; step/time caps; denylist.
* **DoD:** User asks “Clone X and run it”; agent issues `shell.run` calls and returns a final answer.

**Phase 4 TODOs (prep work informed by the agent loop)**

* Add thread/message listing APIs so the UI + agent can hydrate prior context.
* Track richer run metadata (log bytes, truncation flags, per-step summaries) to give the agent grounded observations.

### Phase 5 — Cancel Semantics

* UI **Stop** → backend sets `canceling`, aborts LLM stream & cancels background req, sends Bud `cancel`.
* Bud TERM→5s→KILL; emits `run_finished(canceled:true)`.
* **DoD:** Cancels reliably even mid‑stream; final `canceled` state; SSE closes cleanly.

### Phase 6 — Polish & Resilience

* SSE keep‑alives + `Last-Event-ID` resume; event ring buffer; browser reconnect.
* Soft **100 MB** run log cap + truncation UI notice; “Download logs” endpoint.
* **DoD:** Simulate network hiccups; logs steady; UI informative.

### Phase 7 — Packaging & Docs

* Bud: prebuilt binaries for Linux x86_64/arm64; simple install instructions.
* Backend: `.env` template; `docker-compose` for local; deploy script for bud.dev.
* **DoD:** New dev can follow README to run the full loop locally.

### Phase 8 — Optional Quick Wins

* macOS support (launchd plist).
* Per‑run workspace dir enable; capture small artifacts (stdout file).
* Minimal metrics (p95 run latency, success rate).

---

## 12) Example E2E Flow (golden path)

1. User generates enrollment token in web UI.
2. On a Linux VM:

   ```
   ./bud --server wss://bud.dev/ws --token <TOKEN> --name dev-vm --cwd ~
   ```
3. UI shows Bud online. User opens thread and types:
   “Clone [https://github.com/foo/bar](https://github.com/foo/bar) and run it.”
4. Agent posts an `agent.message` (“Cloning repo…”), calls `shell.run`.
5. Bud streams clone logs; agent summarizes; calls next `shell.run` (install/run).
6. Final `agent.message` with status; run shows **succeeded**.
7. User presses **Stop** during another run → LLM canceled + Bud process group terminated; run ends **canceled**.

---

## 13) Risks & Mitigations (PoC)

* **LLM unsafe commands** → Denylist, non‑privileged user, prominent “unsafe PoC” banner.
* **WS blocked by some proxies** → For later: pluggable transport; keep `Transport` interface.
* **DB bloat from logs** → 100 MB soft cap + tail‑only persist; S3/MinIO path via `logs_blob_url`.
* **Lock‑in to OpenAI** → Provider‑agnostic adapter; local model mock path.
* **OSS vs hosted split** → Keep cloud dependencies optional; license early; secrets via env only.

---

## 14) Decision Log (snapshot)

| Area              | Decision                                                           |
| ----------------- | ------------------------------------------------------------------ |
| Device transport  | WSS (JSON), `proto:"0.1"`, heartbeats 30s                          |
| Browser transport | SSE with keep‑alive + resume                                       |
| Agent style       | Multi‑turn tool‑calling; start with `shell.run`                    |
| LLM               | OpenAI GPT‑5 via Responses API                                     |
| DB                | Supabase Postgres (Postgres‑pure schema)                           |
| Logs              | Postgres up to 100 MB soft cap; S3/MinIO later via `logs_blob_url` |
| Identity          | Enrollment token → `bud_id` + device secret (HMAC re‑auth)         |
| Cancel            | Stop both LLM and Bud (TERM→5s→KILL)                               |
| OSS               | Add tenant/user columns now; adapters & local fallbacks documented |
