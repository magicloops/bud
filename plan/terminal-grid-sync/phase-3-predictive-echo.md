# Phase 3: predictive local echo

## Context

- Design: [design/terminal-grid-sync-and-predictive-echo.md](../../design/terminal-grid-sync-and-predictive-echo.md) §3.3
- Contracts: [implementation-spec.md](./implementation-spec.md) §7
- Depends on: phase 2 (predictions need the grid substrate to reconcile against)

## Objective

mosh-style typing feel on high-RTT links: keystrokes paint immediately in a
tentative style and are confirmed/corrected by authoritative grid frames.

## Changes

### stem — termios fact (the one holder IPC change)

- New IPC variant pair (postcard structs are not self-describing — never add
  fields to existing messages): `ClientMsg::QueryTermios` →
  `HolderMsg::Termios { echo: bool, icanon: bool }` via `tcgetattr` on the
  PTY master. `PROTO_VERSION` 1 → 2; client treats `VersionMismatch`/v1
  holders as "no termios fact" (predictions stay off). In-process skew test
  for the v1-holder fallback.
- `Session` exposes `termios_facts()` (cached, refreshed on each grid take —
  cheap op, and staleness only mis-gates predictions briefly).

### Daemon

- `terminal_input` frames accept optional `input_seq` (monotonic per SSE
  client, minted browser-side); after writing seq-stamped input to the PTY,
  the session records `last_applied_input_seq`; every emitted grid frame
  carries `applied_input_seq`.
- Grid frames gain optional `predict_ok: bool` — daemon-computed gate:
  mode ∈ {shell, repl} ∧ ¬alt_screen ∧ echo ∧ icanon. (Server-computed so
  password prompts — ECHO off — kill predictions within one frame.)

### Service

- `/terminal/input` body accepts optional `seq`; forwarded on the WS frame.
  Pass-through only; no storage.

### Web

- `features/threads/terminal-prediction.ts` — pure prediction engine:
  `predict(state, keystroke, seq)` handles printables (insert at cursor),
  backspace, CR (tentative new blank prompt line — conservative: only cursor
  movement, no prompt guess); everything else (arrows, tabs, control chars)
  is never predicted. Rendered as underline+dim overlay runs, tracked by seq.
- Reconciliation in the grid reducer: a frame with `applied_input_seq ≥ seq`
  retires that prediction; authoritative dirty rows always overwrite overlay
  cells (contradictions simply vanish — mosh's model). All predictions
  dropped on `predict_ok: false`, mode change, or discontinuity.
- Optional polish: mosh-like "predictions only after RTT > threshold"
  (measure input→applied_input_seq round-trip; enable overlay display only
  when p50 exceeds ~80 ms) — keeps low-latency LAN sessions visually pure.

## Test plan

- stem: termios query against a real PTY (`stty -echo` toggling observed);
  v1-holder fallback test.
- Daemon integration: input with seq → next frame carries
  `applied_input_seq`; `predict_ok` flips off inside `read -s` / alt-screen.
- Web unit: prediction insert/backspace/CR; confirm-clears; contradiction
  overwrite; gate transitions drop overlays.
- Manual: artificial latency (Network throttling / `tc netem` on a remote
  bud) — typing paints immediately, corrections invisible in the common
  case; password prompt predicts nothing.

## Spec files to update

- [ ] `bud/stem/stem.spec.md` (ipc PROTO_VERSION 2, session termios)
- [ ] `bud/src/src.spec.md`, `service/src/routes/routes.spec.md`, web specs
- [ ] `docs/proto.md` (`input_seq`, `applied_input_seq`, `predict_ok`)

## Definition of done

Predictions demonstrably reconcile under throttled latency; ECHO-off and TUI
states never predict; v1 holders degrade to predictions-off with no errors.
