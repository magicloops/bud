# Plan: Native Terminal Session Manager (`stem`) — Parent Implementation Spec

## Context

- Design (source of truth for all decisions referenced as D1–D15): [design/native-terminal-session-manager.md](../../design/native-terminal-session-manager.md)
- Motivating assessment: [review/repo-quality-assessment-2026-08-14.md](../../review/repo-quality-assessment-2026-08-14.md) §1
- Related specs: [bud/src/src.spec.md](../../bud/src/src.spec.md) (terminal subsystem), [service/src/runtime/runtime.spec.md](../../service/src/runtime/runtime.spec.md), [docs/proto.md](../../docs/proto.md)
- Constraint status: **pre-release** — daemon internals, Bud↔service wire contract, SSE shapes, agent tools, and web/mobile API may all change (design doc rev 2). Hard cutover, no dual-backend rollout.

## Objective

Replace tmux with `stem`, a Bud-shipped PTY session manager, and redesign the terminal contract around its typed events. Done means:

1. A fresh machine installs **only Bud** and gets working thread-scoped terminal sessions (no tmux preflight anywhere in installer, doctor, or docs).
2. Sessions (processes, screen state, scrollback) survive daemon restarts and installer upgrades via detached per-session holder processes.
3. Shell commands issued by the agent complete with **real exit codes as events** (OSC 133), with zero polling on that path.
4. TUIs settle via emulator damage tracking; line-based REPLs via a scoped prompt registry; heuristics survive only as an honest `mode: unknown` fallback.
5. The wire/tool contracts carry typed terminal events (`terminal_event`, `terminal.run`) and offset-only, resume-correct output streaming end to end (daemon ring → service store → browser).

## Phase overview

| Phase | Doc | Delivers | Gates |
|---|---|---|---|
| 0 | [phase-0-holder-survival-spike-and-proto-draft.md](./phase-0-holder-survival-spike-and-proto-draft.md) | Go/no-go on detached-holder survival (launchd/systemd); emulator bake-off decision; drafted proto revision | **Gates everything.** No-go → fall back to tmux control mode (design D2d) and re-plan |
| 1 | [phase-1-stem-crate.md](./phase-1-stem-crate.md) | `stem` crate: PTY, holder, IPC, ring, registry, emulator wrapper, OSC 133 scanner, mode machine, key table — independently tested | Phase 0 go |
| 2 | [phase-2-daemon-and-service-cutover.md](./phase-2-daemon-and-service-cutover.md) | Daemon terminal runtime rebuilt on `stem`; tmux backend/trait deleted; new wire contract implemented daemon- and service-side; `terminal.run` tool; `terminal_command` table | Phase 1 |
| 3 | [phase-3-web-mobile-and-install-cleanup.md](./phase-3-web-mobile-and-install-cleanup.md) | Web/mobile event adoption + offset resume; installer/doctor/docs tmux removal | Phase 2 |
| 4 | [phase-4-deferred-follow-ups.md](./phase-4-deferred-follow-ups.md) | Optional: `bud term attach`, command-block UX, crates.io extraction | Ship without |

Sequencing rule (design D15, risk register): **contract first** — the `docs/proto.md` revision drafted in Phase 0 is the interface Phases 1–3 build against. Phase 2 lands daemon+service in lockstep on one branch; Phase 3 clients follow.

## Design / Approach (summary — details in design doc)

- `stem` = library crate in a Cargo workspace at `bud/` (root package + `bud/stem/` member); the holder process is the same shipped `bud` binary re-invoked as hidden subcommand `bud term-hold` (D1).
- **Dumb holder** (D2/D3): detached per-session process owning only PTY + capped file-backed ring + ~8-op versioned UDS protocol. All intelligence (emulation, OSC 133, readiness) runs daemon-side and upgrades freely.
- Mode state machine drives readiness (D7): `Shell` via OSC 133, `Tui` via alt-screen, `Repl` via prompt registry, `Unknown` fallback.
- Contract redesign (D15): offset-only output addressing with ring-backfill resume; `terminal_event` frames; `terminal.run`/`terminal.send`/`terminal.observe` tool surface; `terminal_command` table.

## Impacted Contracts

- [x] WSS protocol — new proto revision: `terminal_event`, offset-only `terminal_output`, `terminal_ensure` resume offset, `terminal_send_result` slimmed, `keys` alias removed (`docs/proto.md`)
- [x] SSE events — `terminal_event` forwarded; browser resume via last-applied offset (`docs/proto.md`)
- [x] DB schema — new `terminal_command` table; output-store offset-range reads (`service/src/db/schema.ts`, `pnpm db:push` + checked-in migration via `pnpm db:generate`)
- [x] Agent tools — `terminal.run` added; `wait_for`/confidence removed from tool results and prompts
- [x] Web UI — event-driven terminal status; offset-based resync
- [x] Mobile API — same SSE/REST contract changes; handoff doc for the iOS team

## Spec Files to Update

- [ ] `bud/bud.spec.md`, `bud/src/src.spec.md` (terminal subsystem rewrite; new `stem` crate spec `bud/stem/stem.spec.md`)
- [ ] `docs/proto.md` (proto revision — Phase 0 draft, finalized Phase 2)
- [ ] `service/src/runtime/runtime.spec.md`, `service/src/agent/agent.spec.md`, `service/src/routes/routes.spec.md`, `service/src/db/db.spec.md`, `service/drizzle/migrations/migrations.spec.md`
- [ ] `web/src/features/threads/threads.spec.md` (or current equivalent) for the stream-hook changes
- [ ] Root `bud.spec.md`: §Why tmux? rewritten; design/plan index rows
- [ ] `AGENTS.md` §4.3 (agent tools), §4.4 (readiness → mode/events)

## Test Plan

Per-phase test sections in each phase doc; cross-cutting:
- `stem` unit + integration suite runs without the daemon (Phase 1 exit criterion).
- IPC version-skew test in CI: holder built at previous tag, client at HEAD (D3d).
- Fixture corpus: recorded raw byte streams (shell with/without OSC 133, vim, htop, codex, python/psql REPLs) replayed through scanner + emulator; shared between Phases 1 and 2.
- End-to-end validation: [validation-checklist.md](./validation-checklist.md), run before Phase 2 merges and again after Phase 3.

## Rollout

- Single long-lived branch for Phase 2 (daemon+service lockstep); Phases 0–1 can merge to `main` independently (additive: spike lives in `spikes/`, `stem` is an unused crate until cutover).
- No data migration: old tmux sessions become unreachable at cutover; `bud doctor --cleanup-tmux` offered for orphan cleanup (D14).
- Open questions tracked in the design doc §7 must be resolved no later than the phase that implements them (ring cap → Phase 1; offset idempotency → Phase 2; lockstep-vs-trailing service PR → Phase 2 kickoff).
