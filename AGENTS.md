# AGENTS.md

> How we (humans + code assistants) operate in this codebase while we build the Bud PoC.
> The PoC follows `/plan/proof-of-concept.md`. We keep the process light but deliberate so we
> can evolve this into a production, open‑source system without closing doors.

---

## 0) Scope (for now)

- We are building the **PoC described in `/plan/proof-of-concept.md`**:
  - **Bud**: Rust daemon that connects to the backend via **WSS** and executes shell commands.
  - **Backend**: Node/TypeScript monolith; **REST + SSE** to the web, **WSS** to Bud; uses **Supabase Postgres**.
  - **Web**: Vite + React chat UI (threads, live logs, cancel).
  - **Agent**: Multi‑turn, tool‑calling loop using **OpenAI GPT‑5 (Responses API)** with one tool: `shell.run`.
- Non‑goals (PoC): proxy/MITM, RBAC/SSO, schedulers, artifact store beyond stdout/stderr, Windows, auto‑update/signing.

---

## 1) Repo layout (top‑level subprojects)

| Path     | Purpose                                   | Language / Frameworks                                  |
|----------|-------------------------------------------|--------------------------------------------------------|
| `bud/`   | Device agent (daemon)                     | **Rust**, Tokio, Tungstenite (WSS), rustls             |
| `service/` | Backend API + SSE + Agent + WS gateway  | **Node.js (TypeScript)**, Express/Fastify, `ws`, Postgres client/ORM |
| `web/`   | Web UI (chat, streaming console)          | **Vite + React**, EventSource (SSE)                    |
| `docs/`  | Design docs                               | Markdown (`proto.md`, etc.)             |
| `plan/`  | Work plans for **larger tasks**           | Markdown (see template below)                          |
| `debug/` | Debug notes for **issues/bugs**           | Markdown (see template below)                          |
| `scripts/` | Utility scripts (optional)              | Shell/Node                                             |

**Core technologies**: WSS (Bud⇄Backend), SSE (Browser⇄Backend), Postgres (Supabase),
OpenAI **Responses API (GPT‑5)**, JSON protocols, ULIDs for IDs.

**Design considerations**:
- Must run **open‑source, free‑standing** (local Postgres + mock LLM possible).
- Keep **doors open** for production (multi‑tenant fields, log offload to S3, provider adapters).
- Protocols and schemas are **versioned** and **forwards‑compatible**.

---

## 2) Operating rules (how we work)

1) **Plan first for larger tasks**  
   - Before writing code, create a markdown plan in `plan/` (template below) and link it from an issue.
   - Keep scope small and traceable to `/plan/proof-of-concept.md`.

2) **Write a debug note before fixing any issue**  
   - Create a markdown note in `debug/` (template below) that captures environment, steps to reproduce, logs, and hypotheses.

3) **Always read files in full**  
   - Do **not** rely on partial snippets. Codex‑style defaults read ~200 lines; that is **not acceptable** here.
   - Open/read the **entire file** before analyzing or editing. If tooling cannot load the full file, pause and ask a human for the full content or path.

4) **Build/run failures → defer to humans**  
   - Provide the exact command you attempted and the error output, **then stop**.  
   - Do **not** try multiple alternative commands/flags on your own. The team will run locally and advise.

5) **Protocol / schema changes require docs**  
   - If you change Bud⇄Backend JSON or SSE event shapes: update `/docs/proto.md`, bump `proto` version if breaking, and include migration notes.

6) **Security posture (PoC)**  
   - Treat the PoC as **unsafe**: never suggest `sudo` or destructive commands; prefer non‑privileged users and explicit prompts in the agent.

---

## 3) Invariants & “do not break” contracts

- **Wire protocol (WSS)**  
  - Every frame includes: `type`, `proto`, `message_id`, `sent_at`, and reserved `extensions:{}`.  
  - `hello` includes a **capabilities** object; `hello_ack` may issue `device_secret`.  
  - Bud chunks logs ≤ **16 KB**, monotonically increasing `seq`.

- **Cancel semantics (end‑to‑end)**  
  - UI **Stop** cancels **both**:  
    1) Bud process group: SIGTERM → 5s → SIGKILL.  
    2) OpenAI Responses request: abort stream + **background cancel by id**.
  - Runs transition through `canceling → canceled` (or `failed` with reason).

- **Data model**  
  - Include **`tenant_id`** and **`created_by_user_id`** in new top‑level tables (nullable for PoC).  
  - Use **ULIDs** for `run_id`, `event_id` when possible.  
  - `run_log` primary key is `(run_id, seq)`; DB soft log cap of **100 MB** per run; `logs_blob_url` is present for future S3 offload.

- **Agent adapter**  
  - Keep a provider‑agnostic interface (`LLMAdapter`)—do not leak vendor‑specific shapes upstream.  
  - Single tool now: `shell.run`. Additional tools must register in a small **tool registry** without rewiring the loop.

---

## 4) Task templates

### `plan/` template (for larger tasks)
```markdown
# Plan: <short-title>

## Context
- Link to issue(s):
- Related docs/sections in `/plan/proof-of-concept.md`:

## Objective
- Desired outcome and acceptance criteria.

## Design / Approach
- Summary of changes (APIs, protocol, data model).
- Risks and mitigations.
- Doors kept open (list any long-term considerations).

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (migration)
- [ ] Agent adapter/tool registry
- [ ] Web UI surfaces

## Test plan
- Unit/Integration/E2E outline.
- Manual steps to verify.

## Rollout
- Migration steps if any.
- Docs to update (`/docs/proto.md`, README, UI help).

## Out of scope
- Things we will not do here.
````

### `debug/` template (for issues/bugs)

```markdown
# Debug: <short-title>

## Environment
- OS / arch / versions (bud, backend, web)
- DB (Supabase/Local) and connection string style (redact secrets)
- LLM mode (real/mocked)

## Repro steps
1. …
2. …

## Observed
- Logs (full or linked)
- Screenshots (if UI)
- SSE/WS traces (if relevant)

## Expected
- What should have happened

## Hypotheses
- Root cause candidates

## Proposed fix
- Minimal patch outline
- Side effects / risks

## Next actions
- [ ] Confirm repro
- [ ] Implement fix
- [ ] Add regression test
```

---

## 5) Build & run (guardrails)

> We intentionally keep this section minimal. If any command fails, **stop** and open a `debug/` note; do **not** try multiple alternative paths.

* **Bud**: typical workflow uses `cargo` (Rust stable).
* **Service**: Node/TS with a Postgres connection (Supabase or local).
* **Web**: Vite dev server.

> Full commands and environment details live in each subproject `README.md`. If those steps fail, capture the **exact** command and **verbatim error** in `debug/` and defer to maintainers.

---

## 6) Code conventions (short list)

* **Rust**: `rustfmt`, `clippy` on `bud/`. Async with Tokio; avoid blocking calls.

* **TypeScript**: strict mode, `eslint`/`prettier`. Use `pino` for structured logs with `run_id`/`bud_id` correlation.

* **React**: small components, no global mutable state for SSE buffers; window/virtualize log panes.

* **IDs**: use ULIDs for runs and events.

* **Errors**: use canonical error codes: `AUTH_FAILED`, `PROTO_VERSION_MISMATCH`, `BUD_BUSY`, `EXEC_FAILED`, `TIMEOUT`, `CANCELED`, `BUD_DISCONNECTED`, `SERVER_RESTARTED`.

---

## 7) When changing core contracts

If your change affects any of the following, **open a `plan/` doc first** and update `/docs/proto.md`:

* WSS message shapes or `proto` version.
* SSE event names/payloads.
* DB schema (add migration + backfill notes).
* Agent tool schema or adapter interface.
* Cancel semantics or run state machine.

---

## 8) Definition of Done (PoC tasks)

* Code compiles and runs locally on Linux with the documented commands.
* Protocol and schema docs updated (if touched).
* Added or updated tests (unit/integration/fixture or a manual test recipe).
* `plan/` or `debug/` doc exists and is linked from the PR.
* Doors stay open (no vendor lock‑in, multi‑tenant fields preserved, protocol remains versioned).
