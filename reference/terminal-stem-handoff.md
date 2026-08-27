# Terminal Handoff — the tmux → stem swap and what clients build on now

Companion to `reference/mobile-team-handoff.md`, which covered models/LLM,
lifecycle, and responsive-web changes but only gestured at the terminal work.
This doc is the terminal story on its own: what replaced tmux, what the wire
contract is now, and what a client (native app first, but any consumer)
renders and must respect.

Wire source of truth: [`docs/proto.md`](../docs/proto.md) §6 (Bud ⇄ Service
terminal protocol, proto `0.3`) and §7.2 (terminal SSE). The events/offsets/
snapshot contract already has a detailed client handoff in
[`design/mobile-terminal-events-handoff.md`](../design/mobile-terminal-events-handoff.md)
— this doc summarizes it and adds everything that shipped after it
(grid sync, predictive echo, the default-renderer flip).

---

## 1. tmux is gone — `stem` owns terminal sessions

Merged as PR #51 ("Replace tmux with stem + grid-sync renderer"). tmux is no
longer a dependency anywhere in the stack.

**What stem is** (`bud/stem/`, design authority
`design/native-terminal-session-manager.md`): a native terminal session
manager built into the `bud` binary.

- Each session is a **detached holder process** (`bud term-hold`, a hidden
  re-exec of the same single binary — nothing extra to install). The holder
  owns one PTY and a capped file-backed ring of raw output.
- Holders are deliberately dumb; all intelligence — VT emulation
  (alacritty_terminal), OSC 133 / OSC 7 / alt-screen scanning, mode
  classification, key encoding — runs daemon-side and **upgrades with every
  release** while holders keep running.
- **Survival**: sessions survive network disconnects, daemon restarts, AND
  daemon upgrades (`bud upgrade` restarts only the daemon; holders persist —
  systemd units use `KillMode=process` specifically for this). Reattach
  replays the ring through a fresh emulator, so state is exact.
- The daemon⇄holder IPC is a frozen, versioned, additive-only contract:
  a new daemon must keep talking to holders started by an old one.

**Client-visible consequences:**

- Session ids are service-owned ULIDs (`sess_<ULID>`), thread-scoped: one
  terminal per thread.
- Output byte offsets are **absolute and monotonic forever** — they never
  reset across reconnects or daemon restarts. `(session_id, byte_offset)` is
  the idempotency key for everything.
- Legacy tmux-era sessions (`s_*` names) are dead weight on old machines;
  `bud doctor --cleanup-tmux` is the one-shot cleanup (silent no-op when no
  tmux binary exists).

## 2. Typed terminal facts replaced readiness guessing

The retired 0.2 vocabulary (`terminal_ready`, `confidence`, `hints`,
`wait_for`) is gone. Clients render **facts** from `terminal.event`
(proto §6.4), never infer activity from elapsed time:

- Sessions carry a **mode** — `shell` (OSC 133-integrated, exact command
  lifecycle) | `tui` (alt screen: vim, htop) | `repl` | `unknown` (honest
  fallback) — and an **integration** level: `osc133` (shell hooks) |
  `sentinel` (daemon-wrapped commands still yield real exit codes) | `none`.
- Commands have real lifecycle: `command_started` / `command_finished` with
  **real exit codes**, durations, and output byte ranges (rows in
  `terminal_command` service-side). `exit_code` is *omitted*, never null,
  when unknown.
- `settled { mode, quiet_ms }` means "output went damage-quiet" in
  tui/repl/unknown — it is **not** "command done" and must never render as
  done.
- `output_gap { from_offset, resume_offset }` means the holder's ring
  discarded bytes: hard reset (snapshot + resume), never splice.
- Unknown `event` values must be ignored — the vocabulary is additive.

Full event table, resume rules (`Last-Event-ID` = end offset, `from_offset`
query param, higher-cursor-wins), and the render-ready snapshot endpoint
(`GET /api/threads/:threadId/terminal/snapshot?lines=N`) are in
`design/mobile-terminal-events-handoff.md` §§1–4 — that contract is
unchanged and still accurate.

## 3. Grid sync — the live rendering transport (new since that handoff)

The biggest post-cutover addition (proto §6.8; design
`design/terminal-grid-sync-and-predictive-echo.md`). The daemon already runs
the authoritative emulator per session, so clients no longer need to parse VT
bytes to render live: they opt into **server-authoritative grid frames** and
draw cells. This is now the **default web renderer**, not an experiment; the
raw byte stream remains the durable transcript and resume substrate, but it
stopped being the live rendering path.

**Opt-in**: `GET /api/threads/:thread_id/terminal/stream?grid=1` registers
the SSE connection as a grid viewer (refcounted; every join re-arms the
daemon watch and yields a fresh `full` frame; last leave disarms). Grid
connections attach live-only — no replay; state rebuilds from the full frame.

**`terminal.grid` frames** (forwarded verbatim from the daemon, never
stored):

- Rows arrive as **styled runs**: `{ t, fg?, bg?, a? }` — palette index or
  `[r,g,b]`, attr bitfield (bold/dim/italic/underline/inverse/strikeout).
  Trailing default blanks are trimmed (clear the rest of the row). One rule
  with teeth: **a tab is exported as a single space in one cell — never
  re-expand `\t`** (pre-formatted rendering that re-expands tabs misaligns
  columns, e.g. BSD `ls`).
- **`generation`** is monotonic per daemon attachment, starting at 1.
  Anything other than `last + 1` (SSE drop, daemon restart) → the grid is
  untrustworthy; reconnect and take the fresh full. Correctness never
  depends on trusting a delta.
- **`scrollback_push`** carries lines that scrolled off (exact even at
  history-cap saturation); nonzero `scrollback_dropped` means your
  accumulated scrollback has a seam.
- **`row_shift`** (scroll-hint delta, §6.8.5): shift viewport content by `n`
  rows, then apply `dirty_rows`. Pure WAN optimization — any ambiguity
  degrades to a true full. Measured ~50 shift frames per full at ~5× fewer
  bytes.
- **Input-mode facts** ride the frames so clients encode input correctly:
  `mouse { report, sgr, alt_scroll }` (encode mouse/wheel only while
  `report != none`; Shift bypasses to native selection), `app_cursor`
  (DECCKM → SS3 arrows; `less` ignores CSI arrows), and
  `cursor.shape`/`cursor.blink` (DECSCUSR, vi-mode aware; default is a
  blinking block, reset at each prompt so exited full-screen apps can't
  permanently steady the cursor).
- Cadence is daemon-owned (~8 ms coalesce, ~60 fps cap) — slow consumers
  skip intermediate states by construction, mosh-style. Clients own no
  timers.

**Predictive echo** (§6.8.3) — optional, additive, what makes typing feel
local on high-RTT links: the client mints a monotonic `input_seq` per input
post, renders ghost text for printable bursts/backspace, and retires ghosts
when frames report `applied_input_seq >= seq`. The daemon computes the
**`predict_ok` gate** (interactive prompt in shell/repl, no open command,
primary screen, not the silent-canonical password state via real termios
facts from the holder) — clients predict only while the gate is open and
clear all ghosts on Enter, control keys, gate closure, or reconnect.

**Keyboard/IME rule** (client-side, applies to any grid renderer): route
focus through a hidden text input at the cursor so IME composition, dead
keys, and emoji-picker insertions commit as ordinary text; never translate
mid-composition keydowns (keyCode 229).

**Geometry rule** (refined 2026-08-21 after the native client shipped
mobile-only sessions): ownership is per-client policy, and the binding
invariant is **never reshape the PTY under other concurrent viewers**. A
sole-viewer client (native mobile-only sessions) may own geometry — send
`terminal_resize`, converge-once, accept last-resize-wins if another
viewer joins. A client sharing the session with desktop viewers (mobile
web below 768px) stays an observer: render frames at whatever size they
arrive, pan/scroll locally, never resize.

## 4. Agent tool surface (for tool chips)

The model-facing tools were rebuilt with the swap (proto §6.7); `shell.run`,
`terminal.exec`, and `wait_for` no longer exist. What appears in
`agent.tool_call` events:

- `terminal.run { command }` — deterministic command execution; result
  carries the **real** `exit_code`, `duration_ms`, `command_id`, byte-exact
  sliced `output`, `mode`, `integration`, `cwd`. Non-zero exit is a normal
  result; a long command reports still-running, never a fabricated failure.
- `terminal.send { raw_text | key, submit? }` — exactly one interactive
  gesture (raw text submits by default; semantic keys like `ctrl+c`, `up`);
  resolves on damage-quiet settling with a grid delta as proof.
- `terminal.observe { view: delta|screen|history, lines? }` — explicit
  screen inspection.

The tools are substitutable outside one guarded state: wrong tool choice
degrades to a different result emphasis, except the busy-state refusal
(`command_in_flight`) that protects against typing into a foreground
program. Transport failures arrive as structured tool results
(`code: "BUD_DISCONNECTED"`, `retryable: true`), not stream errors.

## 5. Suggested client adoption path

1. **Facts + offsets first** (already documented): snapshot → offset resume →
   typed events for chips and mode indicators. Works today, no grid needed.
2. **Grid renderer** when live terminal viewing matters: `?grid=1`, draw
   runs, honor generation contiguity, tabs-as-spaces, and the observer
   geometry rule. This is exactly the substrate a native renderer
   (libghostty or custom) was designed to consume — no protocol changes
   needed.
3. **Predictive echo** last, only after grid rendering is solid — it has no
   substrate without it.

The web implementation is a working reference for all three
(`web/src/components/workbench/thread-terminal-grid-pane.tsx` and the grid
store behind it), including the parity/validation drills in
`plan/terminal-grid-sync/` and the client checklist in
`design/mobile-terminal-events-handoff.md` §6.

## 6. Pointers

- `docs/proto.md` §6 / §7.2 — wire truth (incl. changelog §12).
- `design/native-terminal-session-manager.md` — why stem, decisions D1–D15.
- `design/terminal-grid-sync-and-predictive-echo.md` — grid/predict design +
  the 2026-08-20 geometry-observer amendment.
- `design/mobile-terminal-events-handoff.md` — the detailed events/offsets/
  snapshot client contract (checked in, still current).
- `bud/stem/stem.spec.md` — crate internals, holder survival matrix, IPC
  versioning policy.
