# Plan: Phase 3 — Exec Path (No Agent Yet)

## Context
- Link to issue(s): _TBD (Phase 3 tracking issue)_
- Related docs/sections in `/plan/proof-of-concept.md`: §3 (Bud, Backend, Web), §5 (REST/SSE), §11 Phase 3.

## Objective
- Allow a user (or simple REST call) to trigger a `run` that executes a shell command on Bud and streams logs back via SSE.
- Backend should enqueue a `run` for a specific Bud, persist metadata (`run`, `run_step`, `run_log`), and relay stdout/stderr chunks.
- Bud should execute commands serially (queue depth 1 for now), send `stdout`/`stderr` frames with seq numbers, and emit `run_finished`.
- Web should consume `exec.stdout`/`exec.stderr` SSE events (simple console view acceptable).

## Design / Approach
- **REST entry point**: `POST /api/threads/:thread_id/messages` (temporary simplified body `{ text }`) that creates a run with provided shell command (no LLM yet). Return `run_id`.
- **Run dispatch**:
  - Backend registry holds connected Bud sessions; `dispatchRun(run_id, bud_id, payload)` sends a `run` frame on the WS.
  - Maintain per-bud queue (length 10) so multiple runs can enqueue while Bud is busy.
  - Persist `run` row (status `running`), `run_step` row for the shell command (tool = `shell.run`), then append log chunks to `run_log`.
- **Bud execution**:
  - When receiving `run`, spawn `/bin/bash -lc "<cmd>"` (fallback `/bin/sh`).
  - Set env vars from payload (`CI=1`, `LANG=C.UTF-8`, `GIT_ASKPASS=/bin/true`).
  - Stream stdout/stderr chunks ≤16 KB with monotonic `seq`.
  - Support `cancel` by tracking child process group and applying SIGTERM → 5s → SIGKILL (wire minimal backend path but UI “Stop” can arrive later).
- **SSE stream**:
  - `/api/runs/:run_id/stream` emits events from an in-memory buffer per run:
    - `status`, `exec.stdout`, `exec.stderr`, `final`.
  - For now, keep buffer small (e.g., 1000 events) and drop once final event sent.
- **Storage**:
  - `run_log` insert per chunk; update `logs_bytes`, set `log_truncated` if >100 MB.

## Impacted contracts
- [x] WSS protocol (`run`, `stdout`, `stderr`, `run_finished`, `cancel`)
- [x] SSE events (`exec.stdout`, `exec.stderr`, `status`, `final`)
- [x] DB schema usage (no migration changes, but tables heavily used)
- [ ] Agent adapter/tool registry
- [x] Web UI surfaces (basic run console)

## Test plan
- Backend unit tests for registry queue + dispatch logic (mock WS).
- Bud integration test (feature flag) to run a no-op command and assert `run_finished`.
- Manual E2E:
  1. Start backend + Bud + web.
  2. Call REST endpoint with `echo hello`.
  3. Observe SSE stream showing stdout chunk and final status.
  4. Trigger cancellation mid `sleep 30` to verify SIGTERM/KILL behavior.

## Rollout
- Update `/docs/proto.md` (sections for `run`, `stdout`, `stderr`, `run_finished`, `cancel` if shape changed).
- Document CLI instructions for invoking the new REST endpoint and viewing SSE output.
- Ensure `service/README.md` covers run dispatch commands; update `web/README.md` with SSE viewer instructions.

## Open questions & follow-ons
- **Cancel semantics**: wiring `POST /api/runs/:id/cancel` touches multiple subsystems (WS registry, run manager, Bud executor). We paused this to avoid destabilizing Phase 3 and will tackle it during Phase 5 (dedicated cancel milestone).
- **Agent integration**: real tool-calling will rework the REST trigger path; Phase 4 will layer LLM orchestration on top of the current run APIs.
- **Queue management**: Bud’s in-process queue currently drops when full but we haven’t implemented backpressure or persistence yet; needs deeper design once the agent starts issuing multiple steps.

## Out of scope
- LLM agent/tool-calling loop (Phase 4).
- Multi-run concurrency per Bud.
- Log download endpoints or S3 offload.
