# Terminal Grid Sync — Implementation Spec (shared contracts)

Authority: [design/terminal-grid-sync-and-predictive-echo.md](../../design/terminal-grid-sync-and-predictive-echo.md).
This file pins the cross-phase contracts (frame schema, encoding, generation
semantics) so each phase can land independently. Phases:

- [phase-0-stem-grid-deltas.md](./phase-0-stem-grid-deltas.md) — stem: styled-row export + damage accumulation
- [phase-1-wire-and-service-forwarding.md](./phase-1-wire-and-service-forwarding.md) — daemon frames, watch subscription, SSE forwarding
- [phase-2-web-grid-renderer.md](./phase-2-web-grid-renderer.md) — DOM grid renderer behind a flag
- [phase-3-predictive-echo.md](./phase-3-predictive-echo.md) — input sequencing + client prediction

## 1. Architecture recap (from the design doc)

The daemon-side stem emulator is already the authoritative grid. Grid sync
ships that state to clients as damage deltas; clients render cells and parse
**no** VT sequences. The raw byte stream is untouched — it remains the durable
transcript, agent-observation substrate, and the fallback/live path for
clients that don't opt in (xterm.js keeps working throughout; mobile adopts
whenever it wants).

```
PTY bytes ─▶ stem emu (authoritative) ─▶ GridFrame deltas ─▶ terminal_grid (WS)
                                              │                    │
                                              └── daemon coalescing┴─ service fan-out ─▶ SSE terminal.grid ─▶ dumb row renderer
```

## 2. Cell/run encoding (all layers)

A row is a sequence of **styled runs** (run-length by presentation, exactly the
grouping `SgrState` already computes for `screen_ansi`):

```jsonc
// run — "t" required; style keys omitted when default
{ "t": "cargo test", "fg": 2, "bg": [30, 30, 46], "a": 1 }
```

- `t`: run text. Wide chars appear once (no spacer cells); zero-width
  combiners stay attached. Trailing default-styled blanks of a row are
  trimmed (client clears the remainder of the row).
- `fg` / `bg` color: `number` 0–255 = ANSI palette index (0–15 named,
  16–255 indexed — one space, exactly how alacritty stores them);
  `[r, g, b]` = truecolor. Omitted = terminal default.
- `a` attrs bitfield: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse,
  32 strikeout. Omitted = 0.

**v1 fidelity floor** (design open q.1 resolved): the six attrs above +
named/indexed/truecolor — the same set `screen_ansi` serializes today.
Hyperlinks (OSC 8), underline styles/colors, and images are out of scope; the
run object is open for additive keys.

## 3. `GridFrame` (stem → daemon, Rust)

```rust
pub struct GridFrame {
    pub generation: u64,          // monotonic per attachment, starts at 1
    pub full: bool,               // dirty_rows covers ALL rows
    pub cols: u16, pub rows: u16,
    pub alt_screen: bool,
    pub cursor: CursorPos,        // row/col/visible
    pub dirty_rows: Vec<GridRow>,         // GridRow { row: u16, runs: Vec<StyledRun> }
    pub scrollback_push: Vec<Vec<StyledRun>>, // lines pushed to history since last frame
    pub scrollback_dropped: u64,  // pushes evicted from the pending buffer (overflow)
}
```

Produced by `Session::take_grid_frame(full: bool) -> Option<GridFrame>` — a
**pull** API: the caller (daemon tick loop) decides cadence; the session
accumulates dirty rows and scrollback pushes between calls, so coalescing is
free (a row overwritten 100× between ticks ships once). `None` when nothing
changed and `full` wasn't requested.

Dirty accumulation rules:

- `FeedReport.damaged_rows` → dirty set.
- `full_repaint` (any viewport scroll) or resize or alt-screen toggle → all
  rows dirty on the next frame (`full: true`).
- `scrolled_lines > 0` → capture the lines that just entered history
  immediately (they can be evicted by later feeds); pending buffer capped
  (1024 lines) with `scrollback_dropped` counting overflow. Alt screen never
  scrolls history, so TUI floods generate no scrollback traffic.

## 4. Wire frames (proto 0.3, additive — docs/proto.md §6)

Byte-stream frames are unchanged. Two additions:

**service → daemon** — viewer-driven subscription (grid frames cost WAN
bandwidth; a session nobody is watching must not emit them):

```jsonc
{ "type": "terminal_grid_watch", "session_id": "sess_…", "enabled": true }
```

On `enabled: true` the daemon immediately emits a `full` frame, then streams
deltas on its tick cadence; `enabled: false` stops emission. Idempotent; watch
state dies with the WS connection. The service re-arms on **every viewer
join** (not just 0→1 — a newcomer to an already-watched session has no
baseline and the daemon cannot target one SSE connection; the fresh full is
idempotent for existing viewers) and on every `terminal_status ready` while
viewers exist.

**daemon → service** — the delta stream:

```jsonc
{
  "type": "terminal_grid", "proto": "0.3", "session_id": "sess_…",
  "generation": 42, "full": false,
  "cols": 120, "rows": 40, "alt_screen": false,
  "cursor": { "row": 12, "col": 7, "visible": true },
  "dirty_rows": [ { "row": 12, "runs": [ … ] } ],
  "scrollback_push": [ [ …runs… ] ],
  "scrollback_dropped": 0
  // "applied_input_seq": 17   — phase 3, optional
}
```

Cadence: while watched and dirty, emit every **50 ms**; always emit on
`Settled`/`PromptReady` (so the final state after quiet is never 50 ms stale).
Slow-consumer behavior is skip-ahead by construction: frames are deltas from
*last emitted*, never a queue of intermediate states.

**Generation semantics**: monotonic per daemon attachment. The client applies
frames in order; `generation != last + 1` (SSE drop, daemon restart) means the
client's grid is untrustworthy → request a fresh full frame (reconnect the
grid stream). No client acks in v1 (SSE is ordered per connection).

## 5. SSE (service → browser)

New event on the existing `/terminal/stream` SSE: `terminal.grid`, payload =
the daemon frame minus envelope. **No storage, no buffering** — frames are
emitted `buffer:false` (buffered grid frames would replay stale state and
evict output events from the shared replay buffer), and grid connections
attach **live-only** (`replay:false`): their state rebuilds from the watch
re-arm's full frame. Related invariant surfaced by the browser validation:
`terminal.bud_offline`/`bud_online` presence events are also emitted
unbuffered — replayed stale presence made clients treat old transitions as
fresh and reconnect-loop. The service refcounts grid viewers per session
(every join re-arms the watch; last one gone → `enabled:false`). Grid frames
carry no SSE `id:` (the byte-offset cursor contract of §6.7.7 is untouched).

Clients opt in per connection with `?grid=1` on the stream URL. A grid client
still receives `terminal.event` / `terminal.status` (chips, facts) but ignores
`terminal.output` for rendering (it may still track offsets for gap detection
during coexistence; scrollback bootstrap comes from `/terminal/snapshot`).

## 6. Resize under grid sync

Client sends desired dims (existing `/terminal/resize`); the daemon resizes
PTY + emu, which forces the next frame `full` at the new size. The client
renders **only** what frames describe — it never has a grid at a size the
server didn't render, so the size-mismatch artifact class is structurally
gone. (Renderer-authoritative geometry ownership is unchanged.)

## 7. Predictive echo (phase 3 summary)

- Input POSTs gain a client `seq`; daemon stamps `applied_input_seq` on frames
  emitted after writing that input to the PTY.
- Client renders predictions (printables at cursor, backspace, CR) in a
  distinct underline style, keyed by seq; a frame with
  `applied_input_seq >= seq` clears the prediction and the authoritative
  cells overwrite whatever it painted.
- Predictions only when: mode ∈ {shell, repl}, not alt_screen, and the PTY
  line discipline has ECHO+ICANON (termios fact via a **new** holder IPC op —
  postcard structs are not self-describing, so this is a new request/response
  variant pair + `PROTO_VERSION` bump to 2, degrading gracefully against v1
  holders: no termios fact → predictions disabled).

## 8. Coexistence & rollout

- xterm.js byte-stream path remains the default and untouched until the grid
  renderer passes validation; the flag (design open q.4 resolved) is
  per-user — `localStorage` toggle surfaced in the web UI — plus a
  `?renderer=grid|bytes` URL override for testing.
- Mobile keeps the byte stream; `terminal_grid` is additive and documented so
  iOS can adopt later (libghostty rendering the same feed is the long-term
  native story).
- Agent tools are untouched (observe still serves the agent; delta baselines
  independent of grid watch).

## 9. Risks

| Risk | Mitigation |
|---|---|
| Grid traffic on WAN floods | 50 ms coalescing + delta-from-last-emitted + watch refcount (no viewers ⇒ zero frames) |
| DOM renderer perf at 120×40 | per-row patching only (dirty rows), runs not per-cell nodes; canvas remains the later escape hatch |
| Scrollback seams across reconnect | full-frame + snapshot-history rebuild on generation discontinuity (same recovery as `output_gap` today) |
| Frame/emulator drift bugs | fixture-corpus parity test: feed corpus → frames → apply in a reference reducer → compare to `screen_lines()` |
| Holder IPC change (termios) breaks skew | new variant pair only, version-gated, falls back to predictions-off |
