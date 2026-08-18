# terminal-grid-sync.spec.md

Implementation plan for **terminal grid sync + predictive echo** — replacing
raw-byte-stream live rendering with server-authoritative grid deltas, then
building mosh-style predictive echo on that substrate. Picked up from the
Phase 4 slot of
[plan/native-terminal-session-manager](../native-terminal-session-manager/phase-4-deferred-follow-ups.md);
design authority:
[design/terminal-grid-sync-and-predictive-echo.md](../../design/terminal-grid-sync-and-predictive-echo.md).

## Files

| File | Purpose | Status |
|---|---|---|
| [implementation-spec.md](./implementation-spec.md) | Shared contracts: run/cell encoding, `GridFrame`, `terminal_grid`/`terminal_grid_watch` wire frames, SSE `terminal.grid`, generation + cadence semantics, rollout flags | authored |
| [phase-0-stem-grid-deltas.md](./phase-0-stem-grid-deltas.md) | stem: styled-row export (`row_runs`), damage accumulation, `Session::take_grid_frame` + parity harness | **complete** (2026-08-18) — plus exact scroll accounting at history saturation via top-row identity tracking (a plan-time unknown: naive `history_size` deltas undercount to 0 once saturated) |
| [phase-1-wire-and-service-forwarding.md](./phase-1-wire-and-service-forwarding.md) | Daemon tick/emit + watch handling; service watch refcount + SSE forwarding; proto docs | **complete** (2026-08-18) — grid frames ride the `legacy_json` envelope payload (no BudEnvelope table change); `terminal.grid` SSE is live-only (`emit buffer:false` so grid traffic never evicts output events from the replay buffer); watch re-arms on every `ready` status while viewers exist |
| [phase-2-web-grid-renderer.md](./phase-2-web-grid-renderer.md) | DOM-row grid renderer behind a per-user flag; snapshot bootstrap; validation pass | **complete + browser-validated** (2026-08-18) — 19/19 automated headless-Chromium scenarios against the real stack ([browser-validation.md](./browser-validation.md)): prompt/echo/colors/scrollback/nvim/reload/resize/floods/interrupt/byte-path regression. Four bugs found and fixed by the run (stale-presence replay loop, second-viewer seeding, missing geometry re-assert, multi-viewer size tug-of-war). Remaining human-only: rendering feel, IME, wide-glyph fonts, codex-style TUIs |
| [phase-3-predictive-echo.md](./phase-3-predictive-echo.md) | Termios fact (IPC v2), input sequencing, client prediction + reconciliation | **complete + browser-validated** (2026-08-18) — ghost-tail model shipped; E2E under 300 ms injected latency: ghost pre-echo, reconciliation, gate closed during commands. Gate design corrected from the plan: readline/zle prompts are raw-mode with app-side echo, so the gate excludes silent-canonical (`ICANON && !ECHO`) + open commands instead of requiring `ECHO && ICANON` |
| [browser-validation.md](./browser-validation.md) | Automated headless-Chromium validation of phase 2 against the real stack: setup, 19 scenarios, the four bugs it found (all fixed) | complete (2026-08-18) |
| [harness/grid-e2e.mjs](./harness/grid-e2e.mjs) | The playwright-core harness itself (prereqs in its header + browser-validation.md) | reference |
| — mouse/wheel (post-phase-3) | SGR/X10 mouse encoding gated on frame DECSET facts, wheel → mouse events or alternate-scroll arrows, DECCKM-aware cursor keys | **complete + browser-validated** (2026-08-18, 26/26) |
| — scroll-hint delta (§6.8.5, WAN readiness) | Take-time row-identity shift detection → `row_shift` + revealed-rows-only frames; full-frame fallback on any ambiguity | **complete + browser-validated** (2026-08-18, 28/28 — measured 50 shifts : 1 full at ~441B vs ~2331B/frame on a sparse screen) |
| — cursor shape + IME (§6.8.6) | DECSCUSR shape/blink on frames (vim beam/underline); hidden-textarea focus target for IME composition, dead keys, emoji-picker insertions | **complete + browser-validated** (2026-08-18, 32/32) |
| — focus-dependent cursor | Filled/blinking cursor only while the pane owns keyboard focus; hollow outline otherwise (xterm parity) | **complete + browser-validated** (2026-08-18, 35/35) |
| — **default renderer flip** | `terminal-renderer.ts` default `bytes` → `grid` after human dogfooding; xterm stays as the `?renderer=bytes` / localStorage fallback | **complete** (2026-08-18, harness re-validated with the flipped default) |

## Design-doc open questions resolved by this plan

1. Attr fidelity floor → the `SgrState` set (6 attrs, named/indexed/truecolor); run object additive for later (hyperlinks etc.).
2. Selection/copy → DOM-row renderer with native browser selection in v1; canvas deferred until profiling demands it.
3. Scrollback → emu-line pushes over the delta channel + snapshot line-history bootstrap (confirms the design's lean).
4. Flag placement → per-user `localStorage` toggle + `?renderer=` override; byte-stream/xterm.js remained default until validation passed; flipped to `grid` 2026-08-18 after browser validation + human dogfooding.

## Non-goals (unchanged from design §4)

Byte-stream storage/offset-resume untouched; no multi-viewer sharing; xterm.js
not removed on day one; mobile adopts later (frames are additive).

---

*Referenced by: [../../design/terminal-grid-sync-and-predictive-echo.md](../../design/terminal-grid-sync-and-predictive-echo.md)*
