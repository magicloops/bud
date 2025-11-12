# Bud PoC Progress — Phase 3 Snapshot

_Last updated: $(date -u +%Y-%m-%dT%H:%M:%SZ)_

## What’s implemented
- **Run dispatch (Phase 3)**: `POST /api/runs` creates a run, persists it in Postgres, and dispatches a `run` frame to the selected Bud. `RunManager` handles `run_step`, `run_log`, and SSE broadcasts (`status`, `exec.stdout`, `exec.stderr`, `final`).
- **Bud executor**: Rust agent enrolls via `hello`/`hello_ack`, maintains heartbeats, executes commands serially via `<shell> -lc`, streams base64 stdout/stderr chunks, and emits `run_finished` after each command.
- **Web console**: Minimal Vite/React page that lets you POST `/api/runs`, then opens `/api/runs/:id/stream` to view live `exec.*` events.
- **Docs**: `README.md` files, `docs/proto.md`, and `plan/phase-3-exec-path.md` describe the Phase 3 architecture, API usage, and future work.

## Known gaps / next phases
- **Phase 4 (Agent loop)**: hook the LLM tool-calling loop into `/api/threads` + `/api/runs`, interleave agent messages, and orchestrate multi-step plans.
- **Phase 5 (Cancel semantics)**: wire `/api/runs/:id/cancel`, propagate through WS registry, and implement SIGTERM→SIGKILL handling in Bud. (Captured in plan doc.)
- **Reliability polish**: resume/replay for SSE buffers, better queue backpressure, enforced timeouts/log truncation.

## Quick start
1. `pnpm db:migrate && pnpm db:seed` inside `service/` (local Postgres).
2. `pnpm dev` (backend) and `cargo run -- --server ws://localhost:3000/ws --token DEV-ENROLL-0001` (Bud).
3. Optional: `pnpm dev` inside `web/` to use the run console.
4. `curl -X POST http://localhost:3000/api/runs -d '{"bud_id":"b_dev_seed","cmd":"echo hello"}' -H 'Content-Type: application/json'`.
5. Stream events: `curl -N http://localhost:3000/api/runs/<run_id>/stream`.

## Notes
- Cancel support intentionally deferred to Phase 5 to avoid destabilizing Phase 3.
- Keep `AGENTS.md` invariants in mind (plan/debug docs, proto updates, etc.).
