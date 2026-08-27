# Grid Terminal Contract Pack — for the mobile team

Everything requested for building a native grid-terminal client, in one
place: the four contract answers, exact field schemas, verbatim excerpts of
`docs/proto.md` §§6.2/6.4/6.8/7.2, the full grid-sync design doc, the web
reference reducer (types + apply logic) verbatim, and a **freshly captured
raw SSE transcript** (dev stack, real daemon, 2026-08-21) containing an
initial full frame, ordinary deltas, styled runs, Unicode/tab rows, scroll
shifts with scrollback pushes, an alt-screen full, predict-gate flips, a
client reconnect, and a daemon-restart generation reset — each exemplar
annotated inline in §4 and the complete transcript at the end.

Repo sources of truth (this pack quotes them; they win if drift ever
appears): `docs/proto.md` §6 + §7.2, `design/terminal-grid-sync-and-predictive-echo.md`,
`web/src/features/threads/terminal-grid-state.ts`,
`design/mobile-terminal-events-handoff.md` (events/offsets/snapshot contract,
unchanged and still accurate).

---

## 1. The four contract answers

### 1.1 Does `?grid=1` still deliver replayed `terminal.output` from `from_offset`?

**No. Live-only applies to the entire connection.** Verified in
`service/src/routes/threads/terminal.ts`: when `grid=1` is present, the
connection attaches with `replay: false` and the durable offset-replay loop
is never entered — `from_offset` and `Last-Event-ID` are parsed but unused
on that branch. What a grid connection receives:

- **Live** `terminal.output`, `terminal.status`, `terminal.event` — forwarded
  as they happen (grid clients ignore `terminal.output` for rendering but may
  use the facts in `terminal.event` for command chips).
- `terminal.grid` frames (never buffered, never replayed; no SSE `id`).
- Heartbeats — the first one on a grid connection is stamped `{"grid": true}`.
- **No backfill of any kind**: no buffered-event replay, no durable output
  replay, no stale presence replay.

If you ever need byte backfill (transcript export, "jump to earlier output"),
use the REST `GET /terminal/history` route or a separate non-grid stream —
don't expect it on the grid connection.

### 1.2 How do snapshot `history_text`/`screen_text` combine with the first full frame?

The web client's bootstrap, which we recommend copying exactly:

1. `GET /terminal/snapshot?lines=N` → call it **only for `history_text`**,
   which seeds the scrollback buffer as *plain-text* lines (one unstyled run
   per line — see `seedGridScrollback` in the reducer below).
2. **Ignore `screen_text` / `screen_ansi` / `ring_next_offset` in grid
   mode.** The live viewport comes exclusively from the watch re-arm's
   `full` frame (which arrives immediately on connect), and a grid
   connection never resumes by offset, so the watermark is unused.
3. Connect `?grid=1`; apply the seed full when it arrives; from then on
   scrollback grows only from live `scrollback_push` entries (which ARE
   styled).

Consequences to accept rather than fight: **there is no styled initial
scrollback** — history predating the watch is plain text by contract
(historical presentation isn't preserved; only live pushes carry runs), and
a line that scrolls off between snapshot and first frame can be missing from
the seeded scrollback (accepted race; the durable byte transcript still has
it). If a fancier styled-history handshake ever matters to native, that's an
additive protocol conversation — ask, don't work around.

### 1.3 Is every iOS device an observer, or is there a geometry-owner threshold?

**There is no wire-level threshold — geometry ownership is purely "does this
client send `POST /terminal/resize`".** The wire is always correct for an
observer: render frames at whatever `cols`/`rows` they declare, pan/scroll
locally. The web's policy is viewport-width < 768px ⇒ observer (never
resizes, never re-asserts), ≥ 768px ⇒ geometry owner with a converge-once
policy (assert measured size until the stream matches once; re-arm on
reconnect). Between multiple owners the semantics are **last resize wins** —
there is no arbitration.

**Shipped iOS policy (decided by mobile, 2026-08-21, and now the design
doc's second amendment): session-scoped, not device-scoped.** For
**mobile-only sessions** (the phone is the sole viewer) the mobile client
IS the geometry owner — it sends `terminal_resize` and the PTY takes phone
dimensions. For sessions shared with (or reachable by) desktop viewers,
the client stays an observer. The invariant behind the original rule is
what actually binds: **never reshape the PTY under other concurrent
viewers**. A mobile owner must follow the same discipline desktop web
does — converge-once (assert the measured size until the stream matches
once, then STOP; blind re-assertion recreates the multi-viewer
tug-of-war), re-arm the assertion on reconnect, and accept
last-resize-wins if another viewer joins and asserts.

### 1.4 How does the client detect a backend without proto 0.3 or `grid=1` support?

Three signals, layered:

1. **Daemon capability**: `GET /api/buds` returns each bud's daemon-reported
   `capabilities`, including `"terminal_proto": "0.3"`. There is deliberately
   no separate `grid` flag: grid sync shipped before the first public daemon
   release (v0.1.0), so **every daemon that reports `0.3` in the wild also
   emits grid frames**. Treat `terminal_proto === "0.3"` as "grid available";
   anything else (absent, older) ⇒ byte-stream rendering only.
2. **Service capability**: the first heartbeat on a `?grid=1` connection is
   stamped `{"grid": true}`. An older service ignores the unknown query param
   and serves a plain replaying stream — the marker's absence tells you that
   within ~1s. (Production and staging services already support grid; this
   mostly matters for self-hosted/dev skew.)
3. **Behavioral fallback**: regardless of the above, if no `full` frame
   arrives within a few seconds of connect (or after `bud_online` +
   reconnect), fall back to the byte-stream renderer — the snapshot + offset
   contract in `design/mobile-terminal-events-handoff.md` is fully supported
   forever and is the correct degraded mode.

If native wants a hard, explicit `grid` capability bit instead of the
`terminal_proto` inference, it's a one-line additive change to the daemon
hello — tell us and we'll add it.

### One more rule the capture surfaced (not in your list, but you'll hit it)

After a **daemon restart**, a connected grid client receives
`terminal.bud_offline` → `terminal.bud_online` and then live byte events —
but **no further grid frames**: watch state died with the daemon, and
nothing re-arms it on an existing connection until a viewer join or a
status-ready transition. The client rule (what web does): **reconnect the
grid stream on `bud_online`**. The new connection's viewer-join re-arms the
watch and the seed full arrives with `generation: 1` (new daemon
attachment). The captured transcript demonstrates the whole sequence,
including the shell state surviving the restart via the holder process.

---

## 2. Exact field schemas (consolidated)

Normative wire text is in §3 below; this table consolidates it with the
emulator-level facts that don't appear in proto.md.

### 2.1 `terminal.grid` frame (SSE payload = daemon frame minus envelope)

| Field | Type | Notes |
|---|---|---|
| `session_id` | string | `sess_<ULID>` — service-owned, thread-scoped (one session per thread) |
| `generation` | int | Monotonic **per daemon session attachment**, starts at 1. Delta valid iff `generation === last + 1` AND same `cols`/`rows` AND state is seeded. Anything else ⇒ discontinuity ⇒ reconnect (never trust, never guess) |
| `full` | bool | **The full/delta discriminant.** `true`: `dirty_rows` covers every row 0..rows-1 — rebuild the viewport from scratch. `false`: apply against previous state only |
| `cols`, `rows` | int | Frame geometry. A size change always arrives as a `full` |
| `alt_screen` | bool | Alternate screen active (vim/less/htop). Alt toggles force fulls; the alt screen never pushes scrollback |
| `cursor` | object | `{ row, col, visible, shape?, blink? }` — 0-based viewport coords; `shape ∈ block\|underline\|beam` (DECSCUSR; absent on older daemons ⇒ render block), `blink` bool (absent ⇒ render blinking). Hidden = `visible: false`, never a shape |
| `dirty_rows` | array | `[{ row, runs: Run[] }]` — replaces those rows entirely. `runs: []` = blank row. Untouched rows persist from previous state |
| `row_shift` | int? | Delta frames only, omitted when 0: FIRST move viewport content up by n (`new[i] = old[i + n]`; negative = down), THEN apply `dirty_rows` (which always covers every hole/reveal) |
| `scrollback_push` | `Run[][]` | Lines pushed off the top since last frame, oldest first, styled. Append to client scrollback |
| `scrollback_dropped` | int | Best-effort count of pushes lost since last frame. Nonzero ⇒ your accumulated scrollback has a seam (mark it; viewport is unaffected) |
| `predict_ok` | bool? | §6.8.3 gate. Predict only while true. Absent (old daemon) ⇒ off |
| `applied_input_seq` | int? | Highest client `seq` written to the PTY. Retire ghosts with seq ≤ it. Absent ⇒ carry previous value |
| `mouse` | object? | `{ report: none\|click\|drag\|motion, sgr: bool, alt_scroll: bool }`. Absent ⇒ keep previous (client default: `report:none, sgr:false, alt_scroll:true` — alt-scroll defaults ON like real terminals) |
| `app_cursor` | bool? | DECCKM: send arrows as SS3 `ESC O A/B/C/D` instead of CSI. Absent ⇒ keep previous |

### 2.2 `Run` (one styled cell run)

| Field | Type | Notes |
|---|---|---|
| `t` | string | Required. Cell text of the run (see Unicode rules below) |
| `fg`, `bg` | int \| [r,g,b] | Omitted = terminal default. Int = 256-palette index (0–15 ANSI, 16–231 the 6×6×6 cube, 232–255 grayscale ramp); array = truecolor |
| `a` | int | Attr bitfield, omitted = 0: **1** bold, **2** dim, **4** italic, **8** underline, **16** inverse, **32** strikeout |

The run object is additive — ignore unknown keys (future: hyperlinks,
underline styles).

**Unicode cell rules** (from stem's emulator export, `bud/stem/src/emu.rs`):

- **Wide characters** (CJK, most emoji) appear **once** in run text; their
  spacer/continuation cells are skipped at export and never appear on the
  wire. Cell width is a client rendering concern (standard wcwidth/grapheme
  rules) — column positions in `cursor`/`dirty_rows` are real grid columns,
  so a client must advance two columns when rendering a wide char.
- **Zero-width combining marks** stay attached to their base character
  inside the run text (e.g. `e` + U+0301 arrives as the two code points in
  sequence, occupying one cell).
- **Tabs**: the `\t` occupies exactly ONE cell (its start cell) and is
  exported as a single space; the cells from there to the tab stop are
  ordinary blank cells. The exported text is column-exact — re-expanding
  tabs client-side (e.g. `white-space: pre` per-span in web terms) breaks
  column alignment. Never re-expand.
- **Empty/blank cells**: interior blanks are literal spaces in run text;
  trailing default-styled blanks are trimmed from each row (clear the
  remainder of the row); a wholly-empty row is `runs: []`. Styled trailing
  blanks (e.g. background-colored padding) are content and are kept.
- Chunk-safety does not apply here: run text is complete UTF-8 by
  construction (only the raw byte stream can split code points).

### 2.3 Input, status, and the predictive-echo trio

`POST /api/threads/:thread_id/terminal/input` body
(`service/src/routes/threads/shared.ts`):

```json
{ "input": "echo hi\r", "seq": 7 }
```

- `input`: UTF-8 text written to the PTY verbatim (include `\r` to submit).
- `seq` (optional): client-minted, monotonic, non-negative int per page/app
  session — forwarded to the daemon as `terminal_input.input_seq`
  (BudEnvelope typed field 4) and acked back via `applied_input_seq`.
  Omit it if you don't do predictive echo.
- **Serialize input POSTs** (await each before sending the next): parallel
  HTTP requests can arrive out of order and interleave bytes at the PTY —
  a real bug the web client hit with fast typing.

`predict_ok` gate semantics (daemon-computed; client never infers): true only
at an interactive prompt — mode ∈ {shell, repl}, no open command, primary
screen, and the PTY not in the silent-canonical state (`ICANON && !ECHO`,
i.e. password prompts). Client prediction rules: ghost only printable bursts
and backspace over the unflushed tail; Enter, control keys, gate closure,
failed POSTs, or reconnect ⇒ clear all ghosts. Ghosts render in a distinct
tentative style and are never written into grid state.

`terminal.status` `info` object (all fields optional — proto §6.2):

```json
{
  "pid": 12345,
  "cwd": "/Users/adam/bud",
  "cols": 120,
  "rows": 40,
  "ring_next_offset": 84213,
  "mode": "shell",
  "integration": "osc133"
}
```

`state ∈ ready|active|idle|closed`; `mode ∈ shell|tui|repl|unknown`;
`integration ∈ osc133|sentinel|none`; `pid` is the PTY child.

### 2.4 Client-side obligations checklist

- Generation contiguity or reconnect — never render an untrusted grid.
- `row_shift` before `dirty_rows`; blanks the shift reveals are always
  covered by the frame's dirty rows.
- Reconnect on `terminal.bud_online` (see §1.4's extra rule).
- Route keyboard input through a hidden text field at the cursor for
  IME/dead keys/emoji-picker insertions; never translate mid-composition
  keydowns (keyCode 229 in web terms; the UIKit analogue is marked-text).
- Mouse encoding only while `report != none` (SGR when `sgr`, else legacy
  X10 with clamped coords); wheel: reporting ⇒ SGR buttons 64/65; else alt
  screen + `alt_scroll` ⇒ arrow keys (SS3 when `app_cursor`); else scroll
  local scrollback.
- Cap client scrollback (web uses 5000 lines) and surface
  `scrollback_dropped` seams honestly.

---

## 3. Verbatim wire excerpts (`docs/proto.md`)

Quoted exactly from the repo at capture time.

### 6.2 `terminal_status` (Bud → Service)

```json
{
  "proto": "0.3",
  "type": "terminal_status",
  "id": "01...",
  "ts": 1731,
  "session_id": "sess_01H...",
  "state": "ready",
  "info": {
    "pid": 12345,
    "cwd": "/Users/adam/bud",
    "cols": 120,
    "rows": 40,
    "ring_next_offset": 84213,
    "mode": "shell",
    "integration": "osc133"
  },
  "ext": {}
}
```

`pid` is the session's PTY child pid. `mode` ∈ `shell|tui|repl|unknown`;
`integration` ∈ `osc133|sentinel|none`.


### 6.4 `terminal_event` (Bud → Service)

```json
{
  "proto": "0.3",
  "type": "terminal_event",
  "id": "01...",
  "ts": 1731,
  "session_id": "sess_01H...",
  "event": "command_finished",
  "data": {
    "command_id": "cmd_01H...",
    "exit_code": 1,
    "duration_ms": 2311,
    "output_byte_start": 16384,
    "output_byte_end": 18101
  },
  "ext": {}
}
```

| `event` | `data` | Emitted when |
|---|---|---|
| `prompt_ready` | `{ "cwd"?: string }` | OSC 133 `A` (shell back at prompt); `cwd` from OSC 7 when available |
| `command_started` | `{ "command_id", "output_byte_start" }` | OSC 133 `B`→`C` (or sentinel-issued command dispatched) |
| `command_finished` | `{ "command_id", "exit_code"?, "duration_ms"?, "output_byte_start", "output_byte_end" }` | OSC 133 `D;<exit>` |
| `mode_changed` | `{ "mode", "integration" }` | alt-screen enter/exit, REPL pattern match, integration detection |
| `settled` | `{ "mode", "quiet_ms" }` | damage-quiet threshold reached in `tui`/`repl`/`unknown` modes, or in `shell` mode while a command is mid-flight (inline TUIs that never enter the alternate screen); an at-prompt shell emits `prompt_ready` instead |
| `output_gap` | `{ "from_offset", "resume_offset" }` | ring truncation on resume (§6.1) |
| `interactive_started` | `{ "command_id", "signal": "alt_screen"\|"bracketed_paste" }` | the OPEN command launched an interactive program (alt-screen entry, or a mid-command bracketed-paste enable — shells keep `?2004` off while a command runs, so an enable is the child speaking) |
| `child_exited` | `{ "exit_code"?, "signal"?: string }` | session root process exited (`signal` is a name such as `"SIGTERM"`) |

Rules:
- `command_id` is a daemon-minted ULID; the service persists `terminal_command`
  rows keyed by it and slices transcript output via the byte range
- `exit_code`/`duration_ms` are **omitted** (not null) when unknown
  (e.g. a `command_finished` synthesized without an observed start)
- an event's byte references never point past output the service has not yet
  been sent
- unknown `event` values must be ignored (additive evolution); the service
  still forwards them to SSE
- `mode: "unknown"` with heuristic settling is the honest fallback; producers
  must not fabricate `command_finished` without a marker or sentinel exit code


### 6.8 Grid Sync (additive; plan/terminal-grid-sync)

Server-authoritative grid deltas for live client rendering. The byte stream
(§6.3) remains the durable transcript and resume substrate; grid frames are
the live *rendering* transport for clients that opt in, and are emitted only
while at least one viewer is watching. Neither frame has a typed BudEnvelope
slot — both travel via the `legacy_json` payload.

#### 6.8.1 `terminal_grid_watch` (Service → Bud)

```json
{ "type": "terminal_grid_watch", "proto": "0.3", "session_id": "sess_01H...", "enabled": true }
```

- Idempotent. `enabled: true` (re)starts emission and always produces an
  immediate `full` frame; `enabled: false` stops it.
- Watch state dies with the daemon's session attachment and the WS
  connection. The service refcounts grid viewers per session and re-arms on
  **every viewer join** (a newcomer to an already-watched session has no
  baseline, and the daemon cannot target one SSE connection — the fresh full
  is idempotent for existing viewers), on every `terminal_status
  state:"ready"` while viewers exist (covers ensure/reconnect/resize), and
  disarms when the last viewer leaves.

#### 6.8.2 `terminal_grid` (Bud → Service)

```json
{
  "type": "terminal_grid", "proto": "0.3", "session_id": "sess_01H...",
  "generation": 42, "full": false,
  "cols": 120, "rows": 40, "alt_screen": false,
  "cursor": { "row": 12, "col": 7, "visible": true },
  "dirty_rows": [ { "row": 12, "runs": [ { "t": "cargo test", "fg": 2 }, { "t": " ok", "fg": [0, 255, 0], "a": 1 } ] } ],
  "scrollback_push": [ [ { "t": "a line that scrolled off" } ] ],
  "scrollback_dropped": 0
}
```

- **Runs**: a row is maximal same-presentation text runs. `t` required; `fg`/
  `bg` omitted = terminal default, palette index number (0–255) or `[r,g,b]`
  truecolor; `a` attr bitfield (1 bold, 2 dim, 4 italic, 8 underline, 16
  inverse, 32 strikeout), omitted = 0. Wide chars appear once; zero-width
  combiners stay attached; trailing default-styled blanks are trimmed (client
  clears the rest of the row). Run text is cell text: a tab lives in exactly
  one grid cell (the emulator stores `\t` in the tab's start cell) and is
  exported as a single space — clients must never re-expand tabs (CSS
  `white-space: pre` would re-expand at per-span tab stops and misalign
  columns, e.g. BSD `ls` output). The run object is additive (future keys:
  hyperlinks, underline styles).
- **Deltas** are relative to the previously emitted frame. Cadence:
  event-driven — the daemon emits when session activity produces damage,
  after a ~8 ms coalescing beat (a burst of PTY chunks becomes one frame)
  and floored by a ~16 ms minimum inter-frame gap (~60 fps cap; a row
  overwritten many times inside the window ships once, and slow consumers
  skip intermediate states by construction). An idle poll (~100 ms) covers
  predict-gate flips that paint nothing. `full: true` means `dirty_rows` covers every row
  (watch start, resize, viewport scroll, alt-screen toggle). Cursor-only
  changes emit a frame with empty `dirty_rows`.
- **`generation`** is monotonic per daemon session attachment starting at 1.
  A client seeing anything other than `last + 1` (SSE drop, daemon restart —
  which resets to 1) must treat its grid as untrustworthy and recover via
  reconnect (the watch re-arm produces a fresh `full`).
- **`scrollback_push`**: lines pushed into scrollback history since the last
  frame, oldest first (exact even at emulator history-cap saturation; the
  alt screen never pushes). **`scrollback_dropped`** is a best-effort count
  of pushes lost since the last frame (pending-buffer overflow, tracking
  loss); any nonzero value means the client's accumulated scrollback has a
  seam.
- The service forwards frames live (SSE `terminal.grid`, §7.2) and stores
  nothing — grid state is reconstructible, so frames are excluded from the
  SSE replay buffer.

#### 6.8.3 Predictive echo sequencing (additive)

Client-side predictive echo (mosh-style ghost text) rides three additive
fields; all are optional for compatibility with pre-phase-3 peers.

- `terminal_input` (Service → Bud) gains `input_seq` (client-minted,
  monotonic per page session; BudEnvelope typed field **4** — field 3 is the
  retired 0.2 `await_ready`). Browser input posts carry it as `seq` on
  `POST /terminal/input`.
- `terminal_grid` gains:
  - `applied_input_seq`: highest `input_seq` the daemon has written to the
    PTY. A client retires its prediction chunks with `seq <= applied` — the
    authoritative echo owns those cells now.
  - `predict_ok`: daemon-computed gate. True only at an interactive prompt:
    mode ∈ {shell, repl} with **no open command**, primary screen, and the
    PTY line discipline not in the silent-canonical state
    (`ICANON && !ECHO`, the classic password prompt). Note this is an
    exclusion, not `ECHO && ICANON`: readline/zle shells sit at the prompt
    in raw mode with kernel echo off and echo app-side — exactly what
    predictions model. A gate flip with no accompanying damage forces a
    frame on the idle poll (a password prompt closes the gate within
    ~100 ms). The
    termios facts come from the v2 holder IPC op `QueryTermios` (holder
    PROTO_VERSION 2); surviving v1 holders answer nothing and the gate
    stays closed.
- Client rules: predict only printable bursts and backspace over the
  unflushed tail; anything else (Enter, control keys, gate closure, failed
  input posts, reconnects) clears all ghosts. Ghosts render in a distinct
  tentative style after the authoritative cursor and are never written into
  grid state.

#### 6.8.4 Mouse + cursor-key facts (additive)

`terminal_grid` frames carry the application's input-mode DECSET facts so
grid clients can encode input correctly (all optional; older daemons omit
them, and mode toggles force a frame even when they damage no cells):

- `mouse: { report, sgr, alt_scroll }` — `report` is the highest enabled
  reporting level (`none` | `click` (1000) | `drag` (1002) | `motion`
  (1003)); `sgr` = extended coordinates (1006); `alt_scroll` = the
  alternate-scroll convention (1007, default-on like real terminals).
- `app_cursor: bool` — DECCKM: cursor keys must be sent as SS3 (`ESC O x`)
  instead of CSI. Pagers in smkx (`less`) ignore CSI arrows entirely.

Client behavior: mouse events are encoded (SGR preferred; legacy X10 with
coordinates clamped to the UTF-8-safe range) only while `report != none`,
with Shift bypassing to native browser selection (terminal convention).
Wheel: `report != none` → SGR wheel buttons 64/65 at the hovered cell;
otherwise in the alt screen with `alt_scroll` → arrow keys (SS3 when
`app_cursor`); otherwise the primary screen scrolls local scrollback
natively.

#### 6.8.5 Scroll-hint delta (additive)

Scrolling marks the whole viewport damaged in the emulator, which would ship
a full frame per scroll step (~KBs at up to 60 fps — the dominant grid-sync
WAN cost). Instead, when a pending full repaint can be explained by a
vertical shift, the daemon emits a **shift delta**:

- `row_shift: n` (non-`full` frames only; omitted when zero): the client
  first moves its viewport content UP by `n` rows (negative = down) —
  `new[i] = old[i + n]` — then applies `dirty_rows` as usual.
- Detection is take-time and identity-based: each viewport row carries a
  stable identity (its cell-buffer address, which survives every emulator
  rotation) plus a content hash; the shift is the dominant offset that maps
  current rows onto the last emitted frame's rows, and every row the shift
  cannot account for byte-for-byte (revealed, rewritten, region-static) is
  included in `dirty_rows`. Correctness never depends on the hint — any
  ambiguity (no baseline, resize, alt toggle, under a quarter of rows
  matching) degrades to a true `full` frame.
- Multiple scroll steps between frames collapse into one net shift; region
  scrolls (vim with a status line) emit the region's shift with the static
  rows re-sent as dirty; whole-screen replacements (a giant output burst)
  legitimately remain fulls.
- Generation contiguity rules are those of ordinary deltas.

Measured on the validation harness: paced scrolling ships ~50 shift frames
per 1 full, at ~5× fewer bytes per frame even on a sparse screen.

#### 6.8.6 Cursor style facts (additive)

The frame `cursor` object gains `shape` (`block` | `underline` | `beam`) and
`blink` — DECSCUSR facts (vi-mode aware via the emulator), frame-worthy on
change like the other input-mode facts since DECSCUSR paints no cells.
Absent on older daemons; clients render a blinking block then. Hidden
cursors remain expressed via `visible`, never as a shape.

The emulator's default style is a **blinking block**, and prompt return
(OSC 133 `A`) resets DECSCUSR back to that default: full-screen apps
(nvim) leave an explicit steady style behind on exit and never restore it,
which would permanently steady the shell cursor. Prompt-level styling
(zsh vi-mode widgets) is emitted after the prompt marker and therefore
lands on top of the reset and is honored normally.

(Client-side, not wire: grid clients must route keyboard focus through a
hidden text element at the cursor position so IME composition, dead keys,
and non-keyboard insertions — emoji pickers — commit as ordinary input text;
mid-composition keydowns, keyCode 229, must not be translated.)


### 7.2 Terminal Stream Events

`GET /api/threads/:thread_id/terminal/stream` may emit:

- `terminal.output`
  - `{ "session_id": "sess_01H...", "data": "base64 payload", "byte_offset": 16384 }`
  - SSE `id:` is the chunk's END offset (`byte_offset + decoded length`); a client's `Last-Event-ID` therefore always names the next byte it needs, and the server replays durable output from that offset on reconnect
- `terminal.status`
  - `{ "session_id": "bud-b_123-thread-456", "state": "ready|active|idle|closed", "info"?: { ... } }`
- `terminal.event`
  - `{ "session_id": "sess_01H...", "event": "command_finished", "data": { ... }, "ts": 1731 }` — §6.4 frames forwarded verbatim; non-output events carry no SSE `id` so output offsets stay the resume cursor
- `terminal.grid`
  - `{ "session_id": "sess_01H...", "generation": 42, "full": false, "cols": 120, "rows": 40, "alt_screen": false, "cursor": { ... }, "dirty_rows": [ ... ], "scrollback_push": [ ... ], "scrollback_dropped": 0 }` — §6.8.2 frames forwarded verbatim, minus envelope
  - emitted only to connections that opted in with `?grid=1` registered as grid viewers; carries no SSE `id` and is never buffered/replayed (a reconnecting grid client re-arms the watch and receives a fresh `full` frame)
- `terminal.bud_offline`
  - `{ "bud_id": "b_01H...", "reason": "disconnected" }`
- `terminal.bud_online`
  - `{ "bud_id": "b_01H..." }`
- `heartbeat`

`terminal.bud_offline` / `terminal.bud_online` are live presence signals and
are **never buffered/replayed**: a replayed stale transition reads as fresh
and triggers spurious client reconnects (which loop forever on connections
that never resume by offset).

Grid opt-in: `GET /terminal/stream?grid=1` registers the SSE connection as a
grid viewer for its lifetime (refcounted across connections; every join
re-arms `terminal_grid_watch enabled:true`, the last one leaving sends
`enabled:false`). Grid connections attach **live-only** — no buffered-event
replay of any kind; their state rebuilds from the re-arm's full frame. Grid
clients still receive `terminal.status` / `terminal.event`; they ignore
`terminal.output` for rendering.

The old Bud-scoped `/api/terminals/:bud_id/stream` route is not part of the supported contract.


---

## 4. Captured SSE transcript — annotated exemplars

Captured 2026-08-21 against the dev stack (real service + real daemon +
real zsh session at 80×24, resized from the 200×50 spawn hint before
attach). Frames are quoted verbatim from the capture (pretty-printed;
key order aside, byte-identical content). The complete raw stream —
both connections, all 44 grid frames, every heartbeat — is in §7.

### Initial attach — heartbeat marker, then the seed full frame

Connection A opens `GET /terminal/stream?grid=1`. The service immediately sends a heartbeat stamped `grid: true` (the service-side signal that grid registration happened), then viewer registration re-arms the daemon watch, which always produces a `full` frame — here generation 1 at 80×24. `"runs": []` is a blank row (clear it). Every frame carries the input-mode facts.

```json
{
  "heartbeat": {
    "ts": 1787289254936,
    "grid": true
  }
}
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 1,
  "full": true,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 0,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    },
    {
      "row": 1,
      "runs": []
    },
    {
      "row": 2,
      "runs": []
    },
    {
      "row": 3,
      "runs": []
    },
    {
      "row": 4,
      "runs": []
    },
    {
      "row": 5,
      "runs": []
    },
    {
      "row": 6,
      "runs": []
    },
    {
      "row": 7,
      "runs": []
    },
    {
      "row": 8,
      "runs": []
    },
    {
      "row": 9,
      "runs": []
    },
    {
      "row": 10,
      "runs": []
    },
    {
      "row": 11,
      "runs": []
    },
    {
      "row": 12,
      "runs": []
    },
    {
      "row": 13,
      "runs": []
    },
    {
      "row": 14,
      "runs": []
    },
    {
      "row": 15,
      "runs": []
    },
    {
      "row": 16,
      "runs": []
    },
    {
      "row": 17,
      "runs": []
    },
    {
      "row": 18,
      "runs": []
    },
    {
      "row": 19,
      "runs": []
    },
    {
      "row": 20,
      "runs": []
    },
    {
      "row": 21,
      "runs": []
    },
    {
      "row": 22,
      "runs": []
    },
    {
      "row": 23,
      "runs": []
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Ordinary delta with an input ack

`echo grid_transcript_1` was typed via `POST /terminal/input {input, seq: 1}`. The delta touches three rows and acks the input with `applied_input_seq: 1` — the client retires prediction ghosts with seq ≤ 1.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 2,
  "full": false,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 2,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % echo grid_transcript_1"
        }
      ]
    },
    {
      "row": 1,
      "runs": [
        {
          "t": "grid_transcript_1"
        }
      ]
    },
    {
      "row": 2,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 1,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Styled runs — palette, 256-color + bold, truecolor

The three color encodings in one row: `"fg": 1` (palette index), `"fg": 42, "a": 1` (256-color + bold attr bit), `"fg": [255, 128, 0]` (truecolor triple). Runs without `fg`/`bg`/`a` are terminal-default.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 3,
  "full": false,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 5,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 2,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % printf '\\033[31mRED\\033[0m plain \\033[1;38;5;42mBOL"
        }
      ]
    },
    {
      "row": 3,
      "runs": [
        {
          "t": "D256\\033[0m \\033[38;2;255;128;0mRGB\\033[0m\\n'"
        }
      ]
    },
    {
      "row": 4,
      "runs": [
        {
          "fg": 1,
          "t": "RED"
        },
        {
          "t": " plain "
        },
        {
          "a": 1,
          "fg": 42,
          "t": "BOLD256"
        },
        {
          "t": " "
        },
        {
          "fg": [
            255,
            128,
            0
          ],
          "t": "RGB"
        }
      ]
    },
    {
      "row": 5,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 2,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Unicode + tab cells

Row 7: `printf 'tabbed:a\tb\n'` — the '\t' occupies exactly ONE cell (exported as one space at column 8); columns 9–15 are ordinary blank cells; 'b' lands at the tab stop (column 16). The exported text is already column-exact — never re-expand tabs. Row 8: wide CJK chars appear once (no spacer/continuation cells on the wire — width is a rendering concern), the emoji is one cell entry, and `café é` carries the combining mark U+0301 attached to its base char in the run text.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 4,
  "full": false,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 9,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 5,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % printf 'tabbed:a\\tb\\n'; echo '日本語 🙂 café e\\u030"
        }
      ]
    },
    {
      "row": 6,
      "runs": [
        {
          "t": "1'"
        }
      ]
    },
    {
      "row": 7,
      "runs": [
        {
          "t": "tabbed:a        b"
        }
      ]
    },
    {
      "row": 8,
      "runs": [
        {
          "t": "日本語 🙂 café é"
        }
      ]
    },
    {
      "row": 9,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 3,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Scroll-hint delta with a scrollback push

A paced output burst. `row_shift: 1` = move viewport content UP one row (new[i] = old[i+1]) BEFORE applying `dirty_rows`; the row that scrolled off arrives in `scrollback_push` (styled). Note `predict_ok` flipped to false — a command is running.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 17,
  "full": false,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 23,
    "col": 0,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 22,
      "runs": [
        {
          "t": "tick_13"
        }
      ]
    },
    {
      "row": 23,
      "runs": []
    }
  ],
  "scrollback_push": [
    [
      {
        "t": "adam@Adams-MacBook-Pro-2 ~ % echo grid_transcript_1"
      }
    ]
  ],
  "scrollback_dropped": 0,
  "predict_ok": false,
  "applied_input_seq": 4,
  "row_shift": 1,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Alt-screen full with app-cursor fact

`less` opened: alt-screen entry forces a `full` frame with `alt_screen: true`; `app_cursor: true` (DECCKM — arrows must be SS3); the status line run carries `"a": 16` (inverse).

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 37,
  "full": true,
  "cols": 80,
  "rows": 24,
  "alt_screen": true,
  "cursor": {
    "row": 23,
    "col": 12,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "1"
        }
      ]
    },
    {
      "row": 1,
      "runs": [
        {
          "t": "2"
        }
      ]
    },
    {
      "row": 2,
      "runs": [
        {
          "t": "3"
        }
      ]
    },
    {
      "row": 3,
      "runs": [
        {
          "t": "4"
        }
      ]
    },
    {
      "row": 4,
      "runs": [
        {
          "t": "5"
        }
      ]
    },
    {
      "row": 5,
      "runs": [
        {
          "t": "6"
        }
      ]
    },
    {
      "row": 6,
      "runs": [
        {
          "t": "7"
        }
      ]
    },
    {
      "row": 7,
      "runs": [
        {
          "t": "8"
        }
      ]
    },
    {
      "row": 8,
      "runs": [
        {
          "t": "9"
        }
      ]
    },
    {
      "row": 9,
      "runs": [
        {
          "t": "10"
        }
      ]
    },
    {
      "row": 10,
      "runs": [
        {
          "t": "11"
        }
      ]
    },
    {
      "row": 11,
      "runs": [
        {
          "t": "12"
        }
      ]
    },
    {
      "row": 12,
      "runs": [
        {
          "t": "13"
        }
      ]
    },
    {
      "row": 13,
      "runs": [
        {
          "t": "14"
        }
      ]
    },
    {
      "row": 14,
      "runs": [
        {
          "t": "15"
        }
      ]
    },
    {
      "row": 15,
      "runs": [
        {
          "t": "16"
        }
      ]
    },
    {
      "row": 16,
      "runs": [
        {
          "t": "17"
        }
      ]
    },
    {
      "row": 17,
      "runs": [
        {
          "t": "18"
        }
      ]
    },
    {
      "row": 18,
      "runs": [
        {
          "t": "19"
        }
      ]
    },
    {
      "row": 19,
      "runs": [
        {
          "t": "20"
        }
      ]
    },
    {
      "row": 20,
      "runs": [
        {
          "t": "21"
        }
      ]
    },
    {
      "row": 21,
      "runs": [
        {
          "t": "22"
        }
      ]
    },
    {
      "row": 22,
      "runs": [
        {
          "t": "23"
        }
      ]
    },
    {
      "row": 23,
      "runs": [
        {
          "a": 16,
          "t": "/tmp/cap.txt"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": false,
  "applied_input_seq": 5,
  "app_cursor": true,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Predict gate on a silent read

`read -s` put the PTY into the silent-canonical state: frames report `predict_ok: false` with no visible damage while the secret is typed (gen 40 — cursor/gate only, empty dirty_rows possible), then the gate reopens at the next prompt.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 40,
  "full": false,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 23,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 23,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": false,
  "applied_input_seq": 8,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 41,
  "full": true,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 23,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "tick_10"
        }
      ]
    },
    {
      "row": 1,
      "runs": [
        {
          "t": "tick_11"
        }
      ]
    },
    {
      "row": 2,
      "runs": [
        {
          "t": "tick_12"
        }
      ]
    },
    {
      "row": 3,
      "runs": [
        {
          "t": "tick_13"
        }
      ]
    },
    {
      "row": 4,
      "runs": [
        {
          "t": "tick_14"
        }
      ]
    },
    {
      "row": 5,
      "runs": [
        {
          "t": "tick_15"
        }
      ]
    },
    {
      "row": 6,
      "runs": [
        {
          "t": "tick_16"
        }
      ]
    },
    {
      "row": 7,
      "runs": [
        {
          "t": "tick_17"
        }
      ]
    },
    {
      "row": 8,
      "runs": [
        {
          "t": "tick_18"
        }
      ]
    },
    {
      "row": 9,
      "runs": [
        {
          "t": "tick_19"
        }
      ]
    },
    {
      "row": 10,
      "runs": [
        {
          "t": "tick_20"
        }
      ]
    },
    {
      "row": 11,
      "runs": [
        {
          "t": "tick_21"
        }
      ]
    },
    {
      "row": 12,
      "runs": [
        {
          "t": "tick_22"
        }
      ]
    },
    {
      "row": 13,
      "runs": [
        {
          "t": "tick_23"
        }
      ]
    },
    {
      "row": 14,
      "runs": [
        {
          "t": "tick_24"
        }
      ]
    },
    {
      "row": 15,
      "runs": [
        {
          "t": "tick_25"
        }
      ]
    },
    {
      "row": 16,
      "runs": [
        {
          "t": "tick_26"
        }
      ]
    },
    {
      "row": 17,
      "runs": [
        {
          "t": "tick_27"
        }
      ]
    },
    {
      "row": 18,
      "runs": [
        {
          "t": "tick_28"
        }
      ]
    },
    {
      "row": 19,
      "runs": [
        {
          "t": "tick_29"
        }
      ]
    },
    {
      "row": 20,
      "runs": [
        {
          "t": "tick_30"
        }
      ]
    },
    {
      "row": 21,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"
        }
      ]
    },
    {
      "row": 22,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"
        }
      ]
    },
    {
      "row": 23,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 8,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Reconnect — fresh full, generation CONTINUES

Connection A aborted; connection B attaches live-only, viewer-join re-arms the watch, and the seed full arrives as generation 42 — the SAME daemon attachment, so generation keeps counting. No output replay happens on a grid connection.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 42,
  "full": true,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 23,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "tick_10"
        }
      ]
    },
    {
      "row": 1,
      "runs": [
        {
          "t": "tick_11"
        }
      ]
    },
    {
      "row": 2,
      "runs": [
        {
          "t": "tick_12"
        }
      ]
    },
    {
      "row": 3,
      "runs": [
        {
          "t": "tick_13"
        }
      ]
    },
    {
      "row": 4,
      "runs": [
        {
          "t": "tick_14"
        }
      ]
    },
    {
      "row": 5,
      "runs": [
        {
          "t": "tick_15"
        }
      ]
    },
    {
      "row": 6,
      "runs": [
        {
          "t": "tick_16"
        }
      ]
    },
    {
      "row": 7,
      "runs": [
        {
          "t": "tick_17"
        }
      ]
    },
    {
      "row": 8,
      "runs": [
        {
          "t": "tick_18"
        }
      ]
    },
    {
      "row": 9,
      "runs": [
        {
          "t": "tick_19"
        }
      ]
    },
    {
      "row": 10,
      "runs": [
        {
          "t": "tick_20"
        }
      ]
    },
    {
      "row": 11,
      "runs": [
        {
          "t": "tick_21"
        }
      ]
    },
    {
      "row": 12,
      "runs": [
        {
          "t": "tick_22"
        }
      ]
    },
    {
      "row": 13,
      "runs": [
        {
          "t": "tick_23"
        }
      ]
    },
    {
      "row": 14,
      "runs": [
        {
          "t": "tick_24"
        }
      ]
    },
    {
      "row": 15,
      "runs": [
        {
          "t": "tick_25"
        }
      ]
    },
    {
      "row": 16,
      "runs": [
        {
          "t": "tick_26"
        }
      ]
    },
    {
      "row": 17,
      "runs": [
        {
          "t": "tick_27"
        }
      ]
    },
    {
      "row": 18,
      "runs": [
        {
          "t": "tick_28"
        }
      ]
    },
    {
      "row": 19,
      "runs": [
        {
          "t": "tick_29"
        }
      ]
    },
    {
      "row": 20,
      "runs": [
        {
          "t": "tick_30"
        }
      ]
    },
    {
      "row": 21,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"
        }
      ]
    },
    {
      "row": 22,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"
        }
      ]
    },
    {
      "row": 23,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 8,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```

### Daemon restart — generation RESETS to 1

The daemon was killed and restarted under connection B: B received `terminal.bud_offline` → `terminal.bud_online` and then live byte events, but NO further grid frames (watch state died with the daemon). The client rule is: reconnect on `bud_online` (the web client does exactly this). Connection C's seed full arrives as generation 1 — a NEW daemon attachment — while the shell state survived intact (holder persistence): the transcript's last stage echoes `survived_restart` into the same session.

```json
{
  "session_id": "sess_01M0HBSWPHMT0KJ4XF79TEDK46",
  "generation": 1,
  "full": true,
  "cols": 80,
  "rows": 24,
  "alt_screen": false,
  "cursor": {
    "row": 23,
    "col": 29,
    "visible": true,
    "shape": "block",
    "blink": true
  },
  "dirty_rows": [
    {
      "row": 0,
      "runs": [
        {
          "t": "tick_12"
        }
      ]
    },
    {
      "row": 1,
      "runs": [
        {
          "t": "tick_13"
        }
      ]
    },
    {
      "row": 2,
      "runs": [
        {
          "t": "tick_14"
        }
      ]
    },
    {
      "row": 3,
      "runs": [
        {
          "t": "tick_15"
        }
      ]
    },
    {
      "row": 4,
      "runs": [
        {
          "t": "tick_16"
        }
      ]
    },
    {
      "row": 5,
      "runs": [
        {
          "t": "tick_17"
        }
      ]
    },
    {
      "row": 6,
      "runs": [
        {
          "t": "tick_18"
        }
      ]
    },
    {
      "row": 7,
      "runs": [
        {
          "t": "tick_19"
        }
      ]
    },
    {
      "row": 8,
      "runs": [
        {
          "t": "tick_20"
        }
      ]
    },
    {
      "row": 9,
      "runs": [
        {
          "t": "tick_21"
        }
      ]
    },
    {
      "row": 10,
      "runs": [
        {
          "t": "tick_22"
        }
      ]
    },
    {
      "row": 11,
      "runs": [
        {
          "t": "tick_23"
        }
      ]
    },
    {
      "row": 12,
      "runs": [
        {
          "t": "tick_24"
        }
      ]
    },
    {
      "row": 13,
      "runs": [
        {
          "t": "tick_25"
        }
      ]
    },
    {
      "row": 14,
      "runs": [
        {
          "t": "tick_26"
        }
      ]
    },
    {
      "row": 15,
      "runs": [
        {
          "t": "tick_27"
        }
      ]
    },
    {
      "row": 16,
      "runs": [
        {
          "t": "tick_28"
        }
      ]
    },
    {
      "row": 17,
      "runs": [
        {
          "t": "tick_29"
        }
      ]
    },
    {
      "row": 18,
      "runs": [
        {
          "t": "tick_30"
        }
      ]
    },
    {
      "row": 19,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"
        }
      ]
    },
    {
      "row": 20,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"
        }
      ]
    },
    {
      "row": 21,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ % echo survived_restart"
        }
      ]
    },
    {
      "row": 22,
      "runs": [
        {
          "t": "survived_restart"
        }
      ]
    },
    {
      "row": 23,
      "runs": [
        {
          "t": "adam@Adams-MacBook-Pro-2 ~ %"
        }
      ]
    }
  ],
  "scrollback_push": [
    [
      {
        "t": "tick_10"
      }
    ],
    [
      {
        "t": "tick_11"
      }
    ]
  ],
  "scrollback_dropped": 0,
  "predict_ok": true,
  "applied_input_seq": 9,
  "app_cursor": false,
  "mouse": {
    "report": "none",
    "sgr": false,
    "alt_scroll": true
  }
}
```
---

## 5. Web reference implementation

Everything lives in `web/src/features/threads/` (pure logic, all unit-tested
in colocated `*.test.ts` files — port these tests) plus the pane component:

| Module | What it owns |
|---|---|
| `terminal-grid-state.ts` | **The reducer** (below, verbatim): frame types, apply/discontinuity logic, scrollback accumulation, snapshot seeding, 256-color → CSS |
| `terminal-prediction.ts` | Predictive-echo ghost tail: append printable/backspace, retire on `applied_input_seq`, clear-on-anything-else |
| `terminal-input-queue.ts` | Strict serialization of input POSTs (ordering bug guard) |
| `terminal-mouse.ts` | SGR/X10 mouse + wheel encoding per the §6.8.4 policy |
| `terminal-command-state.ts` | Command chips from `terminal.event` facts |
| `terminal-resume.ts` | Snapshot/resume planning shared with the byte renderer |
| `use-terminal-session.ts` | Orchestration: snapshot seeding, stream connect (`grid=1`, no offset), discontinuity → reconnect, `bud_online` → reconnect |
| `../../components/workbench/thread-terminal-grid-pane.tsx` | DOM renderer: run spans, cursor (focus-dependent hollow/filled), hidden IME textarea at the cursor, observer-mode geometry (`assertGeometry={false}` below 768px) |

Server-side emulator fixtures (the corpus the exporter is validated
against, useful for a native renderer's own parity tests):
`bud/stem/tests/fixtures/` — raw VT byte captures with a
frames → reducer == `screen_lines()` parity harness in
`bud/stem/src/session.rs` tests.

> **Unicode width parity**: `reference/grid-width-parity/` now carries
> machine-checkable goldens generated from the live emulator — a 53-probe
> width oracle (ambiguous-width, emoji/ZWJ/VS16, combining marks) and
> per-fixture screen dumps as wire-shape runs — plus the four width rules a
> SwiftTerm-table client must match. Start there before porting width
> tables.

### `terminal-grid-state.ts` (verbatim)

```typescript
/**
 * Grid-sync client state (plan/terminal-grid-sync phase 2).
 *
 * Pure reducer over `terminal.grid` SSE frames (proto §6.8.2). The server's
 * emulator is authoritative: this module never interprets VT sequences — it
 * applies row deltas, tracks the cursor, and accumulates scrollback pushes.
 * Rendering size mismatches are impossible by construction because the state
 * is only ever what a frame described.
 */

export type GridColor = number | [number, number, number]

export type GridRun = {
  t: string
  fg?: GridColor
  bg?: GridColor
  /** Attr bitfield: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikeout. */
  a?: number
}

export type GridCursorShape = 'block' | 'underline' | 'beam'

export type GridCursor = {
  row: number
  col: number
  visible: boolean
  /** DECSCUSR shape; absent on older daemons (render as block). */
  shape?: GridCursorShape
  /** DECSCUSR blink; absent on older daemons (render blinking). */
  blink?: boolean
}

export type GridMouseReport = 'none' | 'click' | 'drag' | 'motion'

export type GridMouseModes = {
  report: GridMouseReport
  /** SGR extended coordinate encoding (DECSET 1006). */
  sgr: boolean
  /** Alternate-scroll (DECSET 1007): wheel → arrows in the alt screen. */
  altScroll: boolean
}

export type TerminalGridFrame = {
  generation: number
  full: boolean
  cols: number
  rows: number
  alt_screen: boolean
  cursor: GridCursor
  dirty_rows: Array<{ row: number; runs: GridRun[] }>
  scrollback_push: GridRun[][]
  scrollback_dropped: number
  /** §6.8.3: predictive-echo gate (absent on pre-phase-3 daemons = off). */
  predict_ok?: boolean
  /** §6.8.3: highest client input_seq the daemon has written to the PTY. */
  applied_input_seq?: number
  /** §6.8.4: mouse-reporting facts (absent on older daemons). */
  mouse?: { report: GridMouseReport; sgr: boolean; alt_scroll: boolean }
  /** §6.8.4: DECCKM — arrows must be SS3 (`ESC O x`) when set. */
  app_cursor?: boolean
  /** §6.8.5: scroll hint — shift viewport content up by n rows (negative =
   * down) BEFORE applying dirty rows. Never on full frames. */
  row_shift?: number
}

export type TerminalGridState = {
  /** A full frame has been applied; deltas are only valid against a seed. */
  seeded: boolean
  generation: number
  cols: number
  rows: number
  altScreen: boolean
  cursor: GridCursor
  /** Live viewport rows (length === rows once seeded). */
  grid: GridRun[][]
  /** Accumulated scrolled-off lines, oldest first (capped). */
  scrollback: GridRun[][]
  /** Cumulative count of known scrollback seams/losses. */
  scrollbackDropped: number
  /** Predictive-echo gate from the latest frame (§6.8.3). */
  predictOk: boolean
  /** Highest server-acked input_seq seen (survives frames that omit it). */
  appliedInputSeq: number | null
  /** Mouse-reporting facts from the latest frame (§6.8.4). */
  mouse: GridMouseModes
  /** DECCKM application cursor mode from the latest frame. */
  appCursor: boolean
}

export const GRID_SCROLLBACK_CAP = 5000

export function emptyGridState(): TerminalGridState {
  return {
    seeded: false,
    generation: 0,
    cols: 0,
    rows: 0,
    altScreen: false,
    cursor: { row: 0, col: 0, visible: true },
    grid: [],
    scrollback: [],
    scrollbackDropped: 0,
    predictOk: false,
    appliedInputSeq: null,
    // altScroll defaults ON (real-terminal default): wheel → arrows in the
    // alt screen even against daemons that predate the mouse facts.
    mouse: { report: 'none', sgr: false, altScroll: true },
    appCursor: false,
  }
}

export type ApplyGridFrameResult = {
  state: TerminalGridState
  /**
   * The frame could not be applied against current state (generation gap on
   * a delta, size mismatch, unseeded delta). The caller must recover by
   * reconnecting the grid stream — the watch re-arm produces a fresh full.
   */
  discontinuity: boolean
}

export function applyGridFrame(
  state: TerminalGridState,
  frame: TerminalGridFrame,
): ApplyGridFrameResult {
  if (!frame.full) {
    const contiguous =
      state.seeded &&
      frame.generation === state.generation + 1 &&
      frame.cols === state.cols &&
      frame.rows === state.rows
    if (!contiguous) {
      return { state, discontinuity: true }
    }
  }

  let grid: GridRun[][]
  if (frame.full) {
    grid = Array.from({ length: frame.rows }, (): GridRun[] => [])
  } else if (frame.row_shift) {
    // Scroll hint: splice the existing rows by the shift (preserving row
    // array identity for unmoved-content memoization), blank the holes —
    // the frame's dirty rows always cover every hole.
    const shift = frame.row_shift
    grid = Array.from({ length: frame.rows }, (_, i): GridRun[] => {
      const src = i + shift
      return src >= 0 && src < state.grid.length ? state.grid[src]! : []
    })
  } else {
    grid = state.grid.slice()
  }
  for (const dirty of frame.dirty_rows) {
    if (dirty.row >= 0 && dirty.row < frame.rows) {
      grid[dirty.row] = dirty.runs
    }
  }

  let scrollback = state.scrollback
  let scrollbackDropped = state.scrollbackDropped + (frame.scrollback_dropped ?? 0)
  if (frame.scrollback_push.length > 0) {
    scrollback = state.scrollback.concat(frame.scrollback_push)
    if (scrollback.length > GRID_SCROLLBACK_CAP) {
      scrollback = scrollback.slice(scrollback.length - GRID_SCROLLBACK_CAP)
    }
  }
  // A full frame after missed generations means missed scrollback pushes too:
  // record the seam (the viewport itself is fully corrected by the frame).
  if (frame.full && state.seeded && frame.generation !== state.generation + 1) {
    scrollbackDropped += 1
  }

  return {
    state: {
      seeded: true,
      generation: frame.generation,
      cols: frame.cols,
      rows: frame.rows,
      altScreen: frame.alt_screen,
      cursor: frame.cursor,
      grid,
      scrollback,
      scrollbackDropped,
      predictOk: frame.predict_ok ?? false,
      appliedInputSeq:
        frame.applied_input_seq !== undefined
          ? Math.max(frame.applied_input_seq, state.appliedInputSeq ?? 0)
          : state.appliedInputSeq,
      mouse: frame.mouse
        ? { report: frame.mouse.report, sgr: frame.mouse.sgr, altScroll: frame.mouse.alt_scroll }
        : state.mouse,
      appCursor: frame.app_cursor ?? state.appCursor,
    },
    discontinuity: false,
  }
}

/**
 * Seed scrollback from the snapshot endpoint's line-oriented `history_text`
 * (plain text — presentation of historical lines is not preserved; live
 * pushes carry styled runs).
 */
export function seedGridScrollback(
  state: TerminalGridState,
  historyText: string,
): TerminalGridState {
  if (!historyText) {
    return { ...state, scrollback: [] }
  }
  const lines = historyText.split('\n')
  const scrollback: GridRun[][] = lines.map((line) => (line.length > 0 ? [{ t: line }] : []))
  return {
    ...state,
    scrollback: scrollback.slice(Math.max(0, scrollback.length - GRID_SCROLLBACK_CAP)),
  }
}

/** Plain text of one row (for tests/copy fallbacks). */
export function gridRowText(runs: GridRun[]): string {
  return runs.map((run) => run.t).join('')
}

// ---------------------------------------------------------------------------
// Color resolution (256-color palette + truecolor → CSS)
// ---------------------------------------------------------------------------

/** Matches the xterm.js theme the byte-stream renderer uses. */
export const GRID_DEFAULT_FG = '#d1ffe1'
export const GRID_DEFAULT_BG = '#000000'

const ANSI_16: string[] = [
  '#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5',
  '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff',
]

export function gridColorToCss(color: GridColor | undefined, fallback: string): string {
  if (color === undefined) {
    return fallback
  }
  if (Array.isArray(color)) {
    return `rgb(${color[0]}, ${color[1]}, ${color[2]})`
  }
  if (color < 16) {
    return ANSI_16[color] ?? fallback
  }
  if (color < 232) {
    // 6×6×6 color cube.
    const index = color - 16
    const levels = [0, 95, 135, 175, 215, 255]
    const r = levels[Math.floor(index / 36) % 6]
    const g = levels[Math.floor(index / 6) % 6]
    const b = levels[index % 6]
    return `rgb(${r}, ${g}, ${b})`
  }
  if (color < 256) {
    const value = 8 + (color - 232) * 10
    return `rgb(${value}, ${value}, ${value})`
  }
  return fallback
}
```

---

## 6. Design doc (text verbatim; headings demoted two levels for embedding): `design/terminal-grid-sync-and-predictive-echo.md`

### Design: Terminal Grid Sync + Predictive Echo (the "right way" for live terminal UX)

Status: **accepted — implementation planned** (2026-08-18). Owning plan:
[plan/terminal-grid-sync/](../plan/terminal-grid-sync/terminal-grid-sync.spec.md)
(phases 0–3; open questions §6 resolved there). Originally the
plan/native-terminal-session-manager Phase 4 slot.

Related: [design/native-terminal-session-manager.md](./native-terminal-session-manager.md)
(D5 emulator, D8 output model, D15 contracts),
[design/network-upgrade-quic-transport.md](./network-upgrade-quic-transport.md),
validation findings in
[plan/native-terminal-session-manager/validation-checklist.md](../plan/native-terminal-session-manager/validation-checklist.md).

#### 1. Problems this solves

1. **Byte-stream fragility at the client.** §A validation (2026-08-17) proved a
   class of live-rendering defects where the backend stream was byte-perfect
   (ring == DB, xterm.js renders it correctly in isolation) yet the live view
   corrupted: any transient mismatch between xterm's grid size and the PTY's
   winsize — or an xterm reflow racing live writes — permanently paints
   artifacts (zsh PROMPT_SP `%` marks). Raw-stream rendering makes the client
   responsible for replicating terminal state exactly, so every size/timing
   race becomes a rendering bug. Mitigations shipped (ResizeObserver
   convergence, one-shot dim assert) shrink but cannot eliminate the window.
2. **Typing latency to remote Buds.** Round-tripping every keystroke
   browser → service → daemon → PTY → echo → back is visibly laggy on
   high-RTT links. mosh solved this with client-side prediction against a
   synchronized screen state; prediction over a raw byte stream has no clean
   reconciliation point.
3. **Renderer ambitions.** xterm.js fidelity is fine (proven), but the team
   wants ghostty-class rendering eventually, and native (iOS/desktop) clients
   shouldn't each re-implement a VT emulator.

#### 2. The core insight

**We already run the authoritative terminal state server-side.** stem's
daemon-side emulator (alacritty_terminal, D5) maintains the true grid with
damage tracking for every session — today it only feeds agent observation.
mosh's architecture (SSP: synchronize *screen state*, not the byte stream) is
therefore mostly already built; what's missing is a diff protocol and a client
that renders grid state instead of interpreting bytes.

```
today:   PTY bytes ──ring──▶ raw stream ──▶ xterm.js re-derives state (fragile)
target:  PTY bytes ──▶ stem emu (authoritative grid) ──damage diffs──▶ dumb grid renderer
```

The raw byte stream does not go away: it remains the durable transcript
(`terminal_session_output`, command byte ranges, history export). It stops
being the *live rendering* transport.

#### 3. Scoped components

##### 3.1 Grid-sync protocol (daemon → service → client)

- Frame: `terminal_grid_delta { generation, cols, rows, cursor, mode_flags,
  damage: [{row, col_start, cells: [{ch, fg, bg, attrs}...]}...], full?: bool }`
  emitted on damage-quiet ticks and bounded intervals (coalesce during floods —
  natural flow control mosh-style: a slow client skips intermediate states
  instead of buffering them).
- `generation` is a monotonic state counter; client acks drive delta baseline
  selection (start simple: always delta-from-last-sent, `full` on
  attach/resize/gap).
- stem work: expose cell-level damage snapshots from `emu` (today only row
  granularity leaves the module); serialize attrs compactly.
- Service: forward frames; no storage (state is reconstructible; transcript
  stays byte-based). Scrollback for the live pane: client requests history
  ranges from the byte store as today.

##### 3.2 Client grid renderer

- Web: render the grid directly (canvas/WebGL or DOM) — no VT parsing in the
  client at all. Resize = send desired dims; server resizes PTY + emu and
  ships a `full` snapshot: **size mismatch becomes impossible by
  construction** (the client never renders state for a size other than the
  one the server rendered).
- Keep xterm.js only as the interim/live fallback and for local-echo-free
  paths until the grid renderer matures; long-term it can be removed.
- ghostty: libghostty is a C ABI without a production web/WASM target — not
  embeddable in the browser today. Positioning: grid-sync makes the renderer
  choice *per-client*: web = custom canvas (small: it draws cells, not VT),
  native iOS/desktop = libghostty rendering the same grid feed becomes viable
  later without protocol changes.

##### 3.3 Predictive local echo (the mosh-like part)

- Client predicts keystroke effects (echo printable chars at cursor,
  backspace, CR → tentative newline) rendered in a "prediction" style
  (underline), tagged with input sequence numbers.
- Daemon echoes back `applied_input_seq` with grid deltas; confirmed
  predictions clear, contradicted predictions are erased by the authoritative
  cells (mosh's exact model). Predictions only in `shell`/`repl` modes with
  echo on (stem knows ECHO/ICANON via termios query — small holder Stat
  extension); never in `tui` mode or password prompts.
- Requires grid-sync first: prediction reconciliation against a byte stream
  has no stable substrate.

##### 3.4 Transport evolution (independent axis)

SSE works for grid deltas initially. The QUIC/WebTransport design
(network-upgrade docs) slots in later for loss-tolerant low-latency delivery;
grid-sync's skip-ahead semantics are what make lossy transport *useful*
(mosh's datagram insight). Don't couple the two initially.

##### 3.5 Revisit under grid-sync: single adaptive terminal tool

Recorded from the 2026-08-17 codex incident debate: the two-tool model-facing
surface (`terminal.run` = declared command intent, `terminal.send` = declared
interactive intent) exists because *the same bytes are legitimate under both
interpretations with opposite correctness* when a program is foreground —
state and content cannot disambiguate; only declared intent can, and declared
intent is what lets the system REFUSE (side-effect-free) instead of guess
(typing into an unknown interactive program is not un-doable). The current
mitigation set: daemon busy guard (`command_in_flight` when a command is open),
`open_command` surfaced in every tool result, ~2-minute still-running budget.
Under grid-sync the client/system models the foreground program much more
richly; at that point a single `terminal.input` with an `expect:
"command"|"interactive"` parameter (equivalent information, different syntax)
or a safe adaptive default for the unambiguous states becomes worth
re-evaluating. Do not collapse the tools before that state model exists.

*Convergence update (2026-08-18):* the completion machinery beneath the two
tools has already effectively unified — command-awaits resolve on
`command_finished` OR `interactive_started`; settled-awaits resolve on
`settled` OR `prompt_ready`; `terminal.run` results are a tagged status union
(`completed|still_running|terminal_busy|interactive`). The residual
difference is exactly ONE intent bit (which transitions count as completion,
and whether an open-command state refuses) plus the result promise
(exit-code+output vs delta). That bit is irreducible: same bytes with a
command open mean opposite correct actions. The successor design is therefore
`terminal.input` with a REQUIRED `expect` — never an inferred one — and the
choice vs two tools is purely model-ergonomics (bash-tool post-training
priors currently favor the split). Live-testing note: the model has misused
the split several times, each time recoverably BECAUSE intent was declared —
evidence for keeping the bit, neutral on the syntax carrying it.

*Substitutability correction (2026-08-18):* "the split is nearly free" was
wrong — the split's cost is borne by the MODEL (tool choice is a failure
surface), and it taxes smaller models hardest, which matters because Bud
first-class-supports local ds4 models. The mitigation shipped instead of a
merge: the tools are now SUBSTITUTABLE outside the one ambiguous state —
run-on-interactive returns `status:"interactive"` in ~1s; send-of-a-command
at a prompt resolves via `command_finished` and carries the real exit code.
Wrong tool choice degrades to a slightly different result emphasis, never an
error, except the busy-state refusal that no design removes. If small-model
telemetry still shows tool-choice churn after this, that is the trigger to
trial the single `terminal.input {expect}` surface ahead of grid-sync.

*DECIDED (2026-08-18):* keep the two-tool surface for now (owner call, after
full review of the single-tool auto-await design and its two regressions:
losing the busy refusal — silent text-into-foreground-agents — and losing
sentinel exit codes on unintegrated shells). The small-model telemetry
tripwire above is the standing revisit condition; the auto-await machinery
(C-marker detection window, outcome union, open_command facts) is already
built and nothing blocks flipping later.

#### 4. What this is NOT

- Not a replacement for `terminal_output` byte storage, command byte ranges,
  or offset resume — the durable/audit path is untouched.
- Not multi-viewer session sharing (still out of scope per AGENTS.md).
- Not a commitment to drop xterm.js on day one — it runs behind a flag until
  the grid renderer passes the same fixture corpus.

#### 5. Rough effort

| Piece | Size |
|---|---|
| stem cell-damage export + termios facts | S–M |
| grid-delta frames daemon→service→SSE | M |
| web canvas grid renderer (cells, cursor, selection, scrollback splice) | M–L |
| predictive echo + reconciliation | M |
| native-client renderer (libghostty) | later, unblocked by protocol |

#### 6. Open questions

1. Cell attr fidelity floor for v1 (truecolor + basic attrs; hyperlinks/images later?).
2. Selection/copy UX on a grid renderer (needs logical-line metadata from emu reflow info).
3. Scrollback: server-side emu history vs client splice of byte-derived history (lean: emu scrollback lines over the same delta channel, capped). Note: byte-derived history is now a DOCUMENTED §A limitation — a raw byte tail after TUI-heavy use renders ~zero lines (alt-screen bytes leave no scrollback), so emu-line scrollback is the accepted resolution, not just a preference.
4. Where the flag lives during coexistence (per-user? per-session?).


#### Amendment (2026-08-20): small viewports are geometry observers

Per [responsive-web-layout.md](./responsive-web-layout.md) §3.4: below the
web app's `md` breakpoint the grid pane never sends `terminal_resize` and
never re-asserts geometry — it renders whatever size frames arrive at
inside a pannable container with keep-cursor-in-view on local activity.
"Last resize wins" therefore only ever applies between geometry-owning
(desktop/tablet) viewers; a phone joining a shared thread cannot reshape
the PTY.

#### Amendment (2026-08-21): geometry ownership is per-client policy, not viewport size

The mobile team's native client ships **mobile-only sessions** where the
phone is the sole viewer — and there the mobile client IS the geometry
owner (it sends `terminal_resize` and the PTY takes phone dimensions).
This sharpens the 2026-08-20 rule to its actual invariant: the wire has no
ownership concept; owning geometry means choosing to send resizes, and the
rule is **never reshape the PTY under other concurrent viewers**, not
"small screens never resize". The web app's policy is unchanged (below
`md` = observer, because mobile web always coexists with potential desktop
viewers of the same thread). A mobile owner must follow the same
discipline desktop web does: converge-once (assert measured size until the
stream matches once, then stop — blind re-assertion recreates the
multi-viewer tug-of-war fixed in Phase 2 validation), and accept
last-resize-wins if another viewer joins and asserts.

---

## 7. Full raw SSE transcript

The complete captured stream, unedited. `##########` lines are capture
markers (not SSE data) injected between stages; connection boundaries
and the driving inputs are described in each marker. Base64 payloads in
`terminal.output` events decode to the raw PTY bytes (grid clients
ignore these for rendering).

````text

########## CONNECT A (initial attach; expect heartbeat {grid:true} then a full frame): GET /api/threads/646d8294-1f6c-4f3b-81f3-2f3fd14cf9c4/terminal/stream?grid=1 ##########

retry: 3000

event: heartbeat
data: {"ts":1787289254936,"grid":true}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":1,"full":true,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":0,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]},{"row":1,"runs":[]},{"row":2,"runs":[]},{"row":3,"runs":[]},{"row":4,"runs":[]},{"row":5,"runs":[]},{"row":6,"runs":[]},{"row":7,"runs":[]},{"row":8,"runs":[]},{"row":9,"runs":[]},{"row":10,"runs":[]},{"row":11,"runs":[]},{"row":12,"runs":[]},{"row":13,"runs":[]},{"row":14,"runs":[]},{"row":15,"runs":[]},{"row":16,"runs":[]},{"row":17,"runs":[]},{"row":18,"runs":[]},{"row":19,"runs":[]},{"row":20,"runs":[]},{"row":21,"runs":[]},{"row":22,"runs":[]},{"row":23,"runs":[]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289255937}

event: heartbeat
data: {"ts":1787289256938}


########## STAGE 1: type "echo grid_transcript_1" (watch applied_input_seq + ordinary deltas) ##########

id: 388
event: terminal.output
data: {"data":"ZQ==","byte_offset":387}

id: 409
event: terminal.output
data: {"data":"CGVjaG8gZ3JpZF90cmFuc2NyaXB0","byte_offset":388}

id: 411
event: terminal.output
data: {"data":"XzE=","byte_offset":409}

id: 422
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":411}

id: 430
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":422}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVHF8WBEQVN0WC8MKNKY5","output_byte_start":430},"ts":1787289257448}

id: 449
event: terminal.output
data: {"data":"Z3JpZF90cmFuc2NyaXB0XzENCg==","byte_offset":430}

id: 553
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":449}

id: 563
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":553}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVHF8WBEQVN0WC8MKNKY5","duration_ms":0,"exit_code":0,"output_byte_end":563,"output_byte_start":430},"ts":1787289257448}

id: 620
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXBtdMTMzO0EH","byte_offset":563}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289257449}

id: 678
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0sbWz8yMDA0aA==","byte_offset":620}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":2,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":2,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % echo grid_transcript_1"}]},{"row":1,"runs":[{"t":"grid_transcript_1"}]},{"row":2,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289257939}

event: heartbeat
data: {"ts":1787289258940}


########## STAGE 2: styled runs — ANSI red, 256-color bold, truecolor, tab cell, CJK + emoji + combining mark ##########

id: 679
event: terminal.output
data: {"data":"cA==","byte_offset":678}

id: 693
event: terminal.output
data: {"data":"CHByaW50ZiAnXDAzM1s=","byte_offset":679}

id: 695
event: terminal.output
data: {"data":"MzE=","byte_offset":693}

id: 698
event: terminal.output
data: {"data":"bVJF","byte_offset":695}

id: 700
event: terminal.output
data: {"data":"RFw=","byte_offset":698}

id: 702
event: terminal.output
data: {"data":"MDM=","byte_offset":700}

id: 705
event: terminal.output
data: {"data":"M1sw","byte_offset":702}

id: 706
event: terminal.output
data: {"data":"bQ==","byte_offset":705}

id: 708
event: terminal.output
data: {"data":"IHA=","byte_offset":706}

id: 710
event: terminal.output
data: {"data":"bGE=","byte_offset":708}

id: 712
event: terminal.output
data: {"data":"aW4=","byte_offset":710}

id: 713
event: terminal.output
data: {"data":"IA==","byte_offset":712}

id: 715
event: terminal.output
data: {"data":"XDA=","byte_offset":713}

id: 716
event: terminal.output
data: {"data":"Mw==","byte_offset":715}

id: 718
event: terminal.output
data: {"data":"M1s=","byte_offset":716}

id: 720
event: terminal.output
data: {"data":"MTs=","byte_offset":718}

id: 722
event: terminal.output
data: {"data":"Mzg=","byte_offset":720}

id: 729
event: terminal.output
data: {"data":"OzU7NDJtQg==","byte_offset":722}

id: 730
event: terminal.output
data: {"data":"Tw==","byte_offset":729}

id: 736
event: terminal.output
data: {"data":"TCANG1tL","byte_offset":730}

id: 740
event: terminal.output
data: {"data":"RA1EMg==","byte_offset":736}

id: 741
event: terminal.output
data: {"data":"NQ==","byte_offset":740}

id: 742
event: terminal.output
data: {"data":"Ng==","byte_offset":741}

id: 744
event: terminal.output
data: {"data":"XDA=","byte_offset":742}

id: 745
event: terminal.output
data: {"data":"Mw==","byte_offset":744}

id: 746
event: terminal.output
data: {"data":"Mw==","byte_offset":745}

id: 748
event: terminal.output
data: {"data":"WzA=","byte_offset":746}

id: 749
event: terminal.output
data: {"data":"bQ==","byte_offset":748}

id: 750
event: terminal.output
data: {"data":"IA==","byte_offset":749}

id: 752
event: terminal.output
data: {"data":"XDA=","byte_offset":750}

id: 753
event: terminal.output
data: {"data":"Mw==","byte_offset":752}

id: 754
event: terminal.output
data: {"data":"Mw==","byte_offset":753}

id: 755
event: terminal.output
data: {"data":"Ww==","byte_offset":754}

id: 756
event: terminal.output
data: {"data":"Mw==","byte_offset":755}

id: 757
event: terminal.output
data: {"data":"OA==","byte_offset":756}

id: 759
event: terminal.output
data: {"data":"OzI=","byte_offset":757}

id: 760
event: terminal.output
data: {"data":"Ow==","byte_offset":759}

id: 761
event: terminal.output
data: {"data":"Mg==","byte_offset":760}

id: 762
event: terminal.output
data: {"data":"NQ==","byte_offset":761}

id: 763
event: terminal.output
data: {"data":"NQ==","byte_offset":762}

id: 764
event: terminal.output
data: {"data":"Ow==","byte_offset":763}

id: 766
event: terminal.output
data: {"data":"MTI=","byte_offset":764}

id: 767
event: terminal.output
data: {"data":"OA==","byte_offset":766}

id: 768
event: terminal.output
data: {"data":"Ow==","byte_offset":767}

id: 769
event: terminal.output
data: {"data":"MA==","byte_offset":768}

id: 770
event: terminal.output
data: {"data":"bQ==","byte_offset":769}

id: 771
event: terminal.output
data: {"data":"Ug==","byte_offset":770}

id: 772
event: terminal.output
data: {"data":"Rw==","byte_offset":771}

id: 774
event: terminal.output
data: {"data":"Qlw=","byte_offset":772}

id: 775
event: terminal.output
data: {"data":"MA==","byte_offset":774}

id: 776
event: terminal.output
data: {"data":"Mw==","byte_offset":775}

id: 778
event: terminal.output
data: {"data":"M1s=","byte_offset":776}

id: 779
event: terminal.output
data: {"data":"MA==","byte_offset":778}

id: 780
event: terminal.output
data: {"data":"bQ==","byte_offset":779}

id: 781
event: terminal.output
data: {"data":"XA==","byte_offset":780}

id: 782
event: terminal.output
data: {"data":"bg==","byte_offset":781}

id: 783
event: terminal.output
data: {"data":"Jw==","byte_offset":782}

id: 794
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":783}

id: 802
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":794}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVJYVT9EXH2B6KMPGYVHA","output_byte_start":802},"ts":1787289258971}

id: 871
event: terminal.output
data: {"data":"G1szMW1SRUQbWzBtIHBsYWluIBtbMTszODs1OzQybUJPTEQyNTYbWzBtIBtbMzg7MjsyNTU7MTI4OzBtUkdCG1swbQ0K","byte_offset":802}

id: 975
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":871}

id: 985
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":975}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVJYVT9EXH2B6KMPGYVHA","duration_ms":0,"exit_code":0,"output_byte_end":985,"output_byte_start":802},"ts":1787289258972}

id: 1034
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXA==","byte_offset":985}

id: 1042
event: terminal.output
data: {"data":"G10xMzM7QQc=","byte_offset":1034}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289258972}

id: 1100
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0sbWz8yMDA0aA==","byte_offset":1042}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":3,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":5,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":2,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % printf '\\033[31mRED\\033[0m plain \\033[1;38;5;42mBOL"}]},{"row":3,"runs":[{"t":"D256\\033[0m \\033[38;2;255;128;0mRGB\\033[0m\\n'"}]},{"row":4,"runs":[{"fg":1,"t":"RED"},{"t":" plain "},{"a":1,"fg":42,"t":"BOLD256"},{"t":" "},{"fg":[255,128,0],"t":"RGB"}]},{"row":5,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":2,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289259941}

id: 1101
event: terminal.output
data: {"data":"cA==","byte_offset":1100}

id: 1121
event: terminal.output
data: {"data":"CHByaW50ZiAndGFiYmVkOmFcdGI=","byte_offset":1101}

id: 1124
event: terminal.output
data: {"data":"XG4n","byte_offset":1121}

id: 1126
event: terminal.output
data: {"data":"OyA=","byte_offset":1124}

id: 1128
event: terminal.output
data: {"data":"ZWM=","byte_offset":1126}

id: 1130
event: terminal.output
data: {"data":"aG8=","byte_offset":1128}

id: 1132
event: terminal.output
data: {"data":"ICc=","byte_offset":1130}

id: 1135
event: terminal.output
data: {"data":"5pel","byte_offset":1132}

id: 1142
event: terminal.output
data: {"data":"5pys6KqeIA==","byte_offset":1135}

id: 1146
event: terminal.output
data: {"data":"8J+Zgg==","byte_offset":1142}

id: 1149
event: terminal.output
data: {"data":"IGNh","byte_offset":1146}

id: 1150
event: terminal.output
data: {"data":"Zg==","byte_offset":1149}

id: 1152
event: terminal.output
data: {"data":"w6k=","byte_offset":1150}

id: 1153
event: terminal.output
data: {"data":"IA==","byte_offset":1152}

id: 1155
event: terminal.output
data: {"data":"ZVw=","byte_offset":1153}

id: 1156
event: terminal.output
data: {"data":"dQ==","byte_offset":1155}

id: 1158
event: terminal.output
data: {"data":"MDM=","byte_offset":1156}

id: 1164
event: terminal.output
data: {"data":"MCANG1tL","byte_offset":1158}

id: 1165
event: terminal.output
data: {"data":"MQ==","byte_offset":1164}

id: 1168
event: terminal.output
data: {"data":"DTEn","byte_offset":1165}

id: 1179
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":1168}

id: 1187
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":1179}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVM4ZBKQ9YFBHPGPZ213J","output_byte_start":1187},"ts":1787289260191}

id: 1199
event: terminal.output
data: {"data":"dGFiYmVkOmEJYg0K","byte_offset":1187}

id: 1225
event: terminal.output
data: {"data":"5pel5pys6KqeIPCfmYIgY2Fmw6kgZcyBDQo=","byte_offset":1199}

id: 1329
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":1225}

id: 1339
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":1329}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVM4ZBKQ9YFBHPGPZ213J","duration_ms":0,"exit_code":0,"output_byte_end":1339,"output_byte_start":1187},"ts":1787289260192}

id: 1396
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXBtdMTMzO0EH","byte_offset":1339}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289260192}

id: 1454
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0sbWz8yMDA0aA==","byte_offset":1396}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":4,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":9,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":5,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % printf 'tabbed:a\\tb\\n'; echo '日本語 🙂 café e\\u030"}]},{"row":6,"runs":[{"t":"1'"}]},{"row":7,"runs":[{"t":"tabbed:a        b"}]},{"row":8,"runs":[{"t":"日本語 🙂 café é"}]},{"row":9,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":3,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289260942}


########## STAGE 3: paced scroll burst (expect row_shift frames + scrollback_push) ##########

id: 1455
event: terminal.output
data: {"data":"Zg==","byte_offset":1454}

id: 1475
event: terminal.output
data: {"data":"CGZvciBpIGluICQoc2VxIDEgMzA=","byte_offset":1455}

id: 1478
event: terminal.output
data: {"data":"KTsg","byte_offset":1475}

id: 1480
event: terminal.output
data: {"data":"ZG8=","byte_offset":1478}

id: 1482
event: terminal.output
data: {"data":"IGU=","byte_offset":1480}

id: 1484
event: terminal.output
data: {"data":"Y2g=","byte_offset":1482}

id: 1486
event: terminal.output
data: {"data":"byA=","byte_offset":1484}

id: 1488
event: terminal.output
data: {"data":"dGk=","byte_offset":1486}

id: 1489
event: terminal.output
data: {"data":"Yw==","byte_offset":1488}

id: 1491
event: terminal.output
data: {"data":"a18=","byte_offset":1489}

id: 1493
event: terminal.output
data: {"data":"JGk=","byte_offset":1491}

id: 1495
event: terminal.output
data: {"data":"OyA=","byte_offset":1493}

id: 1497
event: terminal.output
data: {"data":"c2w=","byte_offset":1495}

id: 1498
event: terminal.output
data: {"data":"ZQ==","byte_offset":1497}

id: 1500
event: terminal.output
data: {"data":"ZXA=","byte_offset":1498}

id: 1502
event: terminal.output
data: {"data":"IDA=","byte_offset":1500}

id: 1504
event: terminal.output
data: {"data":"LjA=","byte_offset":1502}

id: 1506
event: terminal.output
data: {"data":"Nzs=","byte_offset":1504}

id: 1512
event: terminal.output
data: {"data":"ICANG1tL","byte_offset":1506}

id: 1513
event: terminal.output
data: {"data":"ZA==","byte_offset":1512}

id: 1517
event: terminal.output
data: {"data":"DWRvbg==","byte_offset":1513}

id: 1518
event: terminal.output
data: {"data":"ZQ==","byte_offset":1517}

id: 1526
event: terminal.output
data: {"data":"G1s/MjAwNGw=","byte_offset":1518}

id: 1529
event: terminal.output
data: {"data":"DQ0K","byte_offset":1526}

id: 1537
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":1529}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVNMFJATJ7AFGQPYV8AKG","output_byte_start":1537},"ts":1787289261711}

id: 1545
event: terminal.output
data: {"data":"dGlja18xDQo=","byte_offset":1537}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":5,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":12,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":9,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % for i in $(seq 1 30); do echo tick_$i; sleep 0.07;"}]},{"row":10,"runs":[{"t":"done"}]},{"row":11,"runs":[{"t":"tick_1"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1553
event: terminal.output
data: {"data":"dGlja18yDQo=","byte_offset":1545}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":6,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":13,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":12,"runs":[{"t":"tick_2"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1561
event: terminal.output
data: {"data":"dGlja18zDQo=","byte_offset":1553}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":7,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":14,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":13,"runs":[{"t":"tick_3"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289261943}

id: 1569
event: terminal.output
data: {"data":"dGlja180DQo=","byte_offset":1561}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":8,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":15,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":14,"runs":[{"t":"tick_4"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1577
event: terminal.output
data: {"data":"dGlja181DQo=","byte_offset":1569}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":9,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":16,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":15,"runs":[{"t":"tick_5"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1585
event: terminal.output
data: {"data":"dGlja182DQo=","byte_offset":1577}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":10,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":17,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":16,"runs":[{"t":"tick_6"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1593
event: terminal.output
data: {"data":"dGlja183DQo=","byte_offset":1585}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":11,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":18,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":17,"runs":[{"t":"tick_7"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1601
event: terminal.output
data: {"data":"dGlja184DQo=","byte_offset":1593}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":12,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":19,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":18,"runs":[{"t":"tick_8"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1609
event: terminal.output
data: {"data":"dGlja185DQo=","byte_offset":1601}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":13,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":20,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":19,"runs":[{"t":"tick_9"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1618
event: terminal.output
data: {"data":"dGlja18xMA0K","byte_offset":1609}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":14,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":21,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":20,"runs":[{"t":"tick_10"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1627
event: terminal.output
data: {"data":"dGlja18xMQ0K","byte_offset":1618}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":15,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":22,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":21,"runs":[{"t":"tick_11"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1636
event: terminal.output
data: {"data":"dGlja18xMg0K","byte_offset":1627}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":16,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_12"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1645
event: terminal.output
data: {"data":"dGlja18xMw0K","byte_offset":1636}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":17,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_13"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"adam@Adams-MacBook-Pro-2 ~ % echo grid_transcript_1"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1654
event: terminal.output
data: {"data":"dGlja18xNA0K","byte_offset":1645}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":18,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_14"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"grid_transcript_1"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1663
event: terminal.output
data: {"data":"dGlja18xNQ0K","byte_offset":1654}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":19,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_15"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"adam@Adams-MacBook-Pro-2 ~ % printf '\\033[31mRED\\033[0m plain \\033[1;38;5;42mBOL"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1672
event: terminal.output
data: {"data":"dGlja18xNg0K","byte_offset":1663}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":20,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_16"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"D256\\033[0m \\033[38;2;255;128;0mRGB\\033[0m\\n'"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289262944}

id: 1681
event: terminal.output
data: {"data":"dGlja18xNw0K","byte_offset":1672}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":21,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_17"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"fg":1,"t":"RED"},{"t":" plain "},{"a":1,"fg":42,"t":"BOLD256"},{"t":" "},{"fg":[255,128,0],"t":"RGB"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1690
event: terminal.output
data: {"data":"dGlja18xOA0K","byte_offset":1681}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":22,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_18"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"adam@Adams-MacBook-Pro-2 ~ % printf 'tabbed:a\\tb\\n'; echo '日本語 🙂 café e\\u030"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1699
event: terminal.output
data: {"data":"dGlja18xOQ0K","byte_offset":1690}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":23,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_19"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"1'"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1708
event: terminal.output
data: {"data":"dGlja18yMA0K","byte_offset":1699}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":24,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_20"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tabbed:a        b"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1717
event: terminal.output
data: {"data":"dGlja18yMQ0K","byte_offset":1708}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":25,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_21"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"日本語 🙂 café é"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1726
event: terminal.output
data: {"data":"dGlja18yMg0K","byte_offset":1717}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":26,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_22"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"adam@Adams-MacBook-Pro-2 ~ % for i in $(seq 1 30); do echo tick_$i; sleep 0.07;"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1735
event: terminal.output
data: {"data":"dGlja18yMw0K","byte_offset":1726}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":27,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_23"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"done"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1744
event: terminal.output
data: {"data":"dGlja18yNA0K","byte_offset":1735}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":28,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_24"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_1"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1753
event: terminal.output
data: {"data":"dGlja18yNQ0K","byte_offset":1744}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":29,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_25"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_2"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1762
event: terminal.output
data: {"data":"dGlja18yNg0K","byte_offset":1753}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":30,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_26"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_3"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1771
event: terminal.output
data: {"data":"dGlja18yNw0K","byte_offset":1762}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":31,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_27"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_4"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1780
event: terminal.output
data: {"data":"dGlja18yOA0K","byte_offset":1771}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":32,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_28"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_5"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289263945}

id: 1789
event: terminal.output
data: {"data":"dGlja18yOQ0K","byte_offset":1780}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":33,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_29"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_6"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1798
event: terminal.output
data: {"data":"dGlja18zMA0K","byte_offset":1789}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":34,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"tick_30"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_7"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":4,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 1902
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":1798}

id: 1912
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":1902}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVNMFJATJ7AFGQPYV8AKG","duration_ms":2414,"exit_code":0,"output_byte_end":1912,"output_byte_start":1537},"ts":1787289264126}

id: 1961
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXA==","byte_offset":1912}

id: 1969
event: terminal.output
data: {"data":"G10xMzM7QQc=","byte_offset":1961}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289264126}

id: 2016
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSA=","byte_offset":1969}

id: 2027
event: terminal.output
data: {"data":"G1tLG1s/MjAwNGg=","byte_offset":2016}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":35,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":4,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289264946}

event: heartbeat
data: {"ts":1787289265947}


########## STAGE 4: alt screen + app cursor — open less (expect full frame with alt_screen:true, app_cursor:true), then quit ##########

id: 2028
event: terminal.output
data: {"data":"cw==","byte_offset":2027}

id: 2048
event: terminal.output
data: {"data":"CHNlcSAxIDEwMCA+IC90bXAvY2E=","byte_offset":2028}

id: 2051
event: terminal.output
data: {"data":"cC50","byte_offset":2048}

id: 2053
event: terminal.output
data: {"data":"eHQ=","byte_offset":2051}

id: 2055
event: terminal.output
data: {"data":"OyA=","byte_offset":2053}

id: 2057
event: terminal.output
data: {"data":"bGU=","byte_offset":2055}

id: 2059
event: terminal.output
data: {"data":"c3M=","byte_offset":2057}

id: 2061
event: terminal.output
data: {"data":"IC8=","byte_offset":2059}

id: 2062
event: terminal.output
data: {"data":"dA==","byte_offset":2061}

id: 2064
event: terminal.output
data: {"data":"bXA=","byte_offset":2062}

id: 2066
event: terminal.output
data: {"data":"L2M=","byte_offset":2064}

id: 2067
event: terminal.output
data: {"data":"YQ==","byte_offset":2066}

id: 2069
event: terminal.output
data: {"data":"cC4=","byte_offset":2067}

id: 2070
event: terminal.output
data: {"data":"dA==","byte_offset":2069}

id: 2072
event: terminal.output
data: {"data":"eHQ=","byte_offset":2070}

id: 2083
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":2072}

id: 2091
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":2083}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVTH8XX70CY1SMQNVR2VG","output_byte_start":2091},"ts":1787289266728}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":36,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_8"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":5,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

id: 2107
event: terminal.output
data: {"data":"G1s/MTA0OWgbWz8xaBs9DQ==","byte_offset":2091}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"mode_changed","data":{"integration":"osc133","mode":"tui"},"ts":1787289266739}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"interactive_started","data":{"command_id":"cmd_01M0HBVTH8XX70CY1SMQNVR2VG","signal":"alt_screen"},"ts":1787289266739}

id: 2214
event: terminal.output
data: {"data":"MQ0KMg0KMw0KNA0KNQ0KNg0KNw0KOA0KOQ0KMTANCjExDQoxMg0KMTMNCjE0DQoxNQ0KMTYNCjE3DQoxOA0KMTkNCjIwDQoyMQ0KMjINCjIzDQobWzdtL3RtcC9jYXAudHh0G1syN20bW0s=","byte_offset":2107}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":37,"full":true,"cols":80,"rows":24,"alt_screen":true,"cursor":{"row":23,"col":12,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"1"}]},{"row":1,"runs":[{"t":"2"}]},{"row":2,"runs":[{"t":"3"}]},{"row":3,"runs":[{"t":"4"}]},{"row":4,"runs":[{"t":"5"}]},{"row":5,"runs":[{"t":"6"}]},{"row":6,"runs":[{"t":"7"}]},{"row":7,"runs":[{"t":"8"}]},{"row":8,"runs":[{"t":"9"}]},{"row":9,"runs":[{"t":"10"}]},{"row":10,"runs":[{"t":"11"}]},{"row":11,"runs":[{"t":"12"}]},{"row":12,"runs":[{"t":"13"}]},{"row":13,"runs":[{"t":"14"}]},{"row":14,"runs":[{"t":"15"}]},{"row":15,"runs":[{"t":"16"}]},{"row":16,"runs":[{"t":"17"}]},{"row":17,"runs":[{"t":"18"}]},{"row":18,"runs":[{"t":"19"}]},{"row":19,"runs":[{"t":"20"}]},{"row":20,"runs":[{"t":"21"}]},{"row":21,"runs":[{"t":"22"}]},{"row":22,"runs":[{"t":"23"}]},{"row":23,"runs":[{"a":16,"t":"/tmp/cap.txt"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":5,"app_cursor":true,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289266949}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"settled","data":{"mode":"tui","quiet_ms":300},"ts":1787289267042}

event: heartbeat
data: {"ts":1787289267950}

id: 2233
event: terminal.output
data: {"data":"DRtbSxtbPzFsGz4bWz8xMDQ5bA==","byte_offset":2214}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"mode_changed","data":{"integration":"osc133","mode":"shell"},"ts":1787289268747}

id: 2337
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":2233}

id: 2347
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":2337}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVTH8XX70CY1SMQNVR2VG","duration_ms":2020,"exit_code":0,"output_byte_end":2347,"output_byte_start":2091},"ts":1787289268748}

id: 2404
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXBtdMTMzO0EH","byte_offset":2347}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289268748}

id: 2454
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0s=","byte_offset":2404}

id: 2462
event: terminal.output
data: {"data":"G1s/MjAwNGg=","byte_offset":2454}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":38,"full":true,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"tick_9"}]},{"row":1,"runs":[{"t":"tick_10"}]},{"row":2,"runs":[{"t":"tick_11"}]},{"row":3,"runs":[{"t":"tick_12"}]},{"row":4,"runs":[{"t":"tick_13"}]},{"row":5,"runs":[{"t":"tick_14"}]},{"row":6,"runs":[{"t":"tick_15"}]},{"row":7,"runs":[{"t":"tick_16"}]},{"row":8,"runs":[{"t":"tick_17"}]},{"row":9,"runs":[{"t":"tick_18"}]},{"row":10,"runs":[{"t":"tick_19"}]},{"row":11,"runs":[{"t":"tick_20"}]},{"row":12,"runs":[{"t":"tick_21"}]},{"row":13,"runs":[{"t":"tick_22"}]},{"row":14,"runs":[{"t":"tick_23"}]},{"row":15,"runs":[{"t":"tick_24"}]},{"row":16,"runs":[{"t":"tick_25"}]},{"row":17,"runs":[{"t":"tick_26"}]},{"row":18,"runs":[{"t":"tick_27"}]},{"row":19,"runs":[{"t":"tick_28"}]},{"row":20,"runs":[{"t":"tick_29"}]},{"row":21,"runs":[{"t":"tick_30"}]},{"row":22,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"}]},{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":6,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289268951}

event: heartbeat
data: {"ts":1787289269952}


########## STAGE 5: predict gate closes — read -s (silent password read; expect predict_ok:false frame) ##########

id: 2463
event: terminal.output
data: {"data":"cg==","byte_offset":2462}

id: 2493
event: terminal.output
data: {"data":"CHJlYWQgLXMgQ0FQX1NFQ1JFVBtbPzIwMDRsDQ0K","byte_offset":2463}

id: 2501
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":2493}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBVXZQ6QZVNF85M88CK7AA","output_byte_start":2501},"ts":1787289270263}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":39,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":0,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":22,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"}]},{"row":23,"runs":[]}],"scrollback_push":[[{"t":"tick_9"}]],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":7,"row_shift":1,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"settled","data":{"mode":"shell","quiet_ms":300},"ts":1787289270565}

event: heartbeat
data: {"ts":1787289270952}

id: 2605
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":2501}

id: 2615
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":2605}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBVXZQ6QZVNF85M88CK7AA","duration_ms":1514,"exit_code":0,"output_byte_end":2615,"output_byte_start":2501},"ts":1787289271777}

id: 2664
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXA==","byte_offset":2615}

id: 2672
event: terminal.output
data: {"data":"G10xMzM7QQc=","byte_offset":2664}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289271778}

id: 2722
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0s=","byte_offset":2672}

id: 2730
event: terminal.output
data: {"data":"G1s/MjAwNGg=","byte_offset":2722}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":40,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":false,"applied_input_seq":8,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":41,"full":true,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"tick_10"}]},{"row":1,"runs":[{"t":"tick_11"}]},{"row":2,"runs":[{"t":"tick_12"}]},{"row":3,"runs":[{"t":"tick_13"}]},{"row":4,"runs":[{"t":"tick_14"}]},{"row":5,"runs":[{"t":"tick_15"}]},{"row":6,"runs":[{"t":"tick_16"}]},{"row":7,"runs":[{"t":"tick_17"}]},{"row":8,"runs":[{"t":"tick_18"}]},{"row":9,"runs":[{"t":"tick_19"}]},{"row":10,"runs":[{"t":"tick_20"}]},{"row":11,"runs":[{"t":"tick_21"}]},{"row":12,"runs":[{"t":"tick_22"}]},{"row":13,"runs":[{"t":"tick_23"}]},{"row":14,"runs":[{"t":"tick_24"}]},{"row":15,"runs":[{"t":"tick_25"}]},{"row":16,"runs":[{"t":"tick_26"}]},{"row":17,"runs":[{"t":"tick_27"}]},{"row":18,"runs":[{"t":"tick_28"}]},{"row":19,"runs":[{"t":"tick_29"}]},{"row":20,"runs":[{"t":"tick_30"}]},{"row":21,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"}]},{"row":22,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"}]},{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":8,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289271953}

event: heartbeat
data: {"ts":1787289272954}


########## DISCONNECT A (client abort) ##########


########## CONNECT B (reconnect; state rebuilds from a fresh full — generation continues): GET /api/threads/646d8294-1f6c-4f3b-81f3-2f3fd14cf9c4/terminal/stream?grid=1 ##########

retry: 3000

event: heartbeat
data: {"ts":1787289273497,"grid":true}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":42,"full":true,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"tick_10"}]},{"row":1,"runs":[{"t":"tick_11"}]},{"row":2,"runs":[{"t":"tick_12"}]},{"row":3,"runs":[{"t":"tick_13"}]},{"row":4,"runs":[{"t":"tick_14"}]},{"row":5,"runs":[{"t":"tick_15"}]},{"row":6,"runs":[{"t":"tick_16"}]},{"row":7,"runs":[{"t":"tick_17"}]},{"row":8,"runs":[{"t":"tick_18"}]},{"row":9,"runs":[{"t":"tick_19"}]},{"row":10,"runs":[{"t":"tick_20"}]},{"row":11,"runs":[{"t":"tick_21"}]},{"row":12,"runs":[{"t":"tick_22"}]},{"row":13,"runs":[{"t":"tick_23"}]},{"row":14,"runs":[{"t":"tick_24"}]},{"row":15,"runs":[{"t":"tick_25"}]},{"row":16,"runs":[{"t":"tick_26"}]},{"row":17,"runs":[{"t":"tick_27"}]},{"row":18,"runs":[{"t":"tick_28"}]},{"row":19,"runs":[{"t":"tick_29"}]},{"row":20,"runs":[{"t":"tick_30"}]},{"row":21,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"}]},{"row":22,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"}]},{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":8,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289274498}

event: heartbeat
data: {"ts":1787289275498}


########## STAGE 6: daemon restart under connection B (expect bud_offline/bud_online, then a full frame with generation reset to 1) ##########

event: terminal.bud_offline
data: {"bud_id":"b_01M0HBSFZWS7XXTAY37PYXFSY6","reason":"disconnected"}

event: terminal.bud_online
data: {"bud_id":"b_01M0HBSFZWS7XXTAY37PYXFSY6"}

event: heartbeat
data: {"ts":1787289276500}

event: heartbeat
data: {"ts":1787289277501}

event: heartbeat
data: {"ts":1787289278502}

event: heartbeat
data: {"ts":1787289279503}

event: heartbeat
data: {"ts":1787289280503}

event: heartbeat
data: {"ts":1787289281504}

event: heartbeat
data: {"ts":1787289282504}

event: heartbeat
data: {"ts":1787289283504}

event: heartbeat
data: {"ts":1787289284506}


########## STAGE 7: prove the session survived the daemon restart (holder persistence) — echo survived_restart ##########

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"mode_changed","data":{"integration":"osc133","mode":"shell"},"ts":1787289285202}

id: 2734
event: terminal.output
data: {"data":"ZQhlYw==","byte_offset":2730}

id: 2753
event: terminal.output
data: {"data":"aG8gc3Vydml2ZWRfcmVzdGFydA==","byte_offset":2734}

id: 2764
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":2753}

id: 2772
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":2764}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBWCJKW4ZFQ662ZJG37WWV","output_byte_start":2772},"ts":1787289285203}

id: 2790
event: terminal.output
data: {"data":"c3Vydml2ZWRfcmVzdGFydA0K","byte_offset":2772}

id: 2894
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":2790}

id: 2904
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":2894}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBWCJKW4ZFQ662ZJG37WWV","duration_ms":0,"exit_code":0,"output_byte_end":2904,"output_byte_start":2772},"ts":1787289285203}

id: 2961
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXBtdMTMzO0EH","byte_offset":2904}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289285203}

id: 3019
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0sbWz8yMDA0aA==","byte_offset":2961}

event: heartbeat
data: {"ts":1787289285507}

event: heartbeat
data: {"ts":1787289286508}


########## END OF CAPTURE ##########


########## CONNECT C (client reconnects after bud_online — watch re-arms on the NEW daemon attachment; generation resets to 1) ##########

retry: 3000

event: heartbeat
data: {"ts":1787289346521,"grid":true}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":1,"full":true,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":0,"runs":[{"t":"tick_12"}]},{"row":1,"runs":[{"t":"tick_13"}]},{"row":2,"runs":[{"t":"tick_14"}]},{"row":3,"runs":[{"t":"tick_15"}]},{"row":4,"runs":[{"t":"tick_16"}]},{"row":5,"runs":[{"t":"tick_17"}]},{"row":6,"runs":[{"t":"tick_18"}]},{"row":7,"runs":[{"t":"tick_19"}]},{"row":8,"runs":[{"t":"tick_20"}]},{"row":9,"runs":[{"t":"tick_21"}]},{"row":10,"runs":[{"t":"tick_22"}]},{"row":11,"runs":[{"t":"tick_23"}]},{"row":12,"runs":[{"t":"tick_24"}]},{"row":13,"runs":[{"t":"tick_25"}]},{"row":14,"runs":[{"t":"tick_26"}]},{"row":15,"runs":[{"t":"tick_27"}]},{"row":16,"runs":[{"t":"tick_28"}]},{"row":17,"runs":[{"t":"tick_29"}]},{"row":18,"runs":[{"t":"tick_30"}]},{"row":19,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % seq 1 100 > /tmp/cap.txt; less /tmp/cap.txt"}]},{"row":20,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % read -s CAP_SECRET"}]},{"row":21,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % echo survived_restart"}]},{"row":22,"runs":[{"t":"survived_restart"}]},{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[[{"t":"tick_10"}],[{"t":"tick_11"}]],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":9,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289347522}

event: heartbeat
data: {"ts":1787289348523}

id: 3020
event: terminal.output
data: {"data":"ZQ==","byte_offset":3019}

id: 3049
event: terminal.output
data: {"data":"CGVjaG8gYWZ0ZXJfcmVzdGFydF9nZW5fcmVzZXQ=","byte_offset":3020}

id: 3060
event: terminal.output
data: {"data":"G1s/MjAwNGwNDQo=","byte_offset":3049}

id: 3068
event: terminal.output
data: {"data":"G10xMzM7Qwc=","byte_offset":3060}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_started","data":{"command_id":"cmd_01M0HBYAVGSZ4PWW0PQ2Z1N490","output_byte_start":3068},"ts":1787289348976}

id: 3093
event: terminal.output
data: {"data":"YWZ0ZXJfcmVzdGFydF9nZW5fcmVzZXQNCg==","byte_offset":3068}

id: 3197
event: terminal.output
data: {"data":"G1sxbRtbN20lG1syN20bWzFtG1swbSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICANIA0=","byte_offset":3093}

id: 3207
event: terminal.output
data: {"data":"G10xMzM7RDswBw==","byte_offset":3197}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"command_finished","data":{"command_id":"cmd_01M0HBYAVGSZ4PWW0PQ2Z1N490","duration_ms":0,"exit_code":0,"output_byte_end":3207,"output_byte_start":3068},"ts":1787289348976}

id: 3264
event: terminal.output
data: {"data":"G103O2ZpbGU6Ly9BZGFtcy1NYWNCb29rLVByby0yLmxvY2FsL1VzZXJzL2FkYW0bXBtdMTMzO0EH","byte_offset":3207}

event: terminal.event
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","event":"prompt_ready","data":{"cwd":"/Users/adam"},"ts":1787289348976}

id: 3322
event: terminal.output
data: {"data":"DRtbMG0bWzI3bRtbMjRtG1tKYWRhbUBBZGFtcy1NYWNCb29rLVByby0yIH4gJSAbW0sbWz8yMDA0aA==","byte_offset":3264}

event: terminal.grid
data: {"session_id":"sess_01M0HBSWPHMT0KJ4XF79TEDK46","generation":2,"full":false,"cols":80,"rows":24,"alt_screen":false,"cursor":{"row":23,"col":29,"visible":true,"shape":"block","blink":true},"dirty_rows":[{"row":21,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ % echo after_restart_gen_reset"}]},{"row":22,"runs":[{"t":"after_restart_gen_reset"}]},{"row":23,"runs":[{"t":"adam@Adams-MacBook-Pro-2 ~ %"}]}],"scrollback_push":[[{"t":"tick_12"}],[{"t":"tick_13"}]],"scrollback_dropped":0,"predict_ok":true,"applied_input_seq":9,"row_shift":2,"app_cursor":false,"mouse":{"report":"none","sgr":false,"alt_scroll":true}}

event: heartbeat
data: {"ts":1787289349523}

event: heartbeat
data: {"ts":1787289350524}

event: heartbeat
data: {"ts":1787289351525}

event: heartbeat
data: {"ts":1787289352526}


########## END ##########
````
