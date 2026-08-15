# Phase 4: Deferred Follow-ups (Optional)

Explicitly **not** required to ship the tmux replacement. Each item stands alone; pick up individually when justified.

Design refs: D13 (attach), D15e (scope), D1 (extraction).

## 4.1 `bud term attach <session>` — human escape hatch

Replaces the undocumented `tmux attach` operator hatch lost at cutover. CLI speaks the holder IPC directly: raw-mode TTY, `Subscribe` from ring tail, `Write` passthrough, resize propagation. Sub-decision deferred from design D13: read-only `bud term peek` first vs. full read-write attach (recommend peek first — zero risk of fighting the agent for input). Estimated ~1–2 days on the existing protocol.

## 4.2 Command-block UX

Warp-style grouping of command + output in web/mobile, built on `terminal_command` byte ranges (`output_byte_start..output_byte_end` into `terminal_session_output`). Product work: design doc first (rendering model, live vs historic blocks, interaction with raw terminal view). The substrate ships in Phase 2; nothing in the schema should need to change.

## 4.3 `stem` extraction / publication

Move `bud/stem/` to its own repo and/or publish to crates.io if external interest or reuse (e.g. a future mobile-local agent) warrants. Prerequisites: crates.io name check (design open q. 4/5), API stabilization pass, docs. The workspace layout and the no-`bud`-imports rule (Phase 1) keep this cheap.

## 4.4 Candidate later work surfaced by the design (unscheduled)

- Windows/ConPTY backend (D12) — `portable-pty` + a holder-equivalent (job objects) when Windows becomes a target.
- Service-configurable ring caps per session (design open q. 1 follow-on).
- Backfill-to-Postgres of ring bytes produced while the *service* (not daemon) was down — only if reconciliation demands it.
