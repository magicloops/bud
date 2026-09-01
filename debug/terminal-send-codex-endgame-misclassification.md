# Debug: terminal.send misroutes into codex at the end of a long run

## Environment
- Service + daemon current (`terminal_send_auto` in play).
- Agent driving a codex TUI (`gpt-5.6-sol`) through a ~45m repo review.
- Codex is a **primary-screen** raw-mode TUI (no alt-screen): it draws its
  chat UI on the normal screen, reads keys in raw mode, never sends
  `?1049h`.

## Repro shape (from the provided trace)
It worked for the whole review, then at the very end:
- `terminal.send /ps` → result `kind:"command"`, `mode:"shell"`,
  `Still running 120.0s`.
- `terminal.send /stop` → same: `command`, `shell`, `Still running 120.0s`.
- Codex's own screen shows the pasted line as:
  `› /stop; printf '\033]133;D;%s\a' "$?"/ps; printf '\033]133;D;%s\a' "$?"`
  and codex logs `Unrecognized command '/ps;'` / `Unrecognized command
  '/stop;'`.
- Several earlier sends ran 30s–2m with no visible output.

## Observed vs expected
- **Observed:** each `terminal.send` was treated as a **shell command**:
  the daemon appended the OSC-133 **sentinel trailer**
  `; printf '\033]133;D;%s\a' "$?"` to the text and awaited a
  `command_finished` that never comes. Codex received the whole string as
  chat input, so `/ps` / `/stop` became `/ps;` / `/stop;` — rejected. The
  send then sat until the **2-minute** service budget
  (`TERMINAL_AWAITED_SEND_TIMEOUT_MS`) expired and reported still-running.
- **Expected:** while codex owns the terminal, a send is an interactive
  gesture: deliver the keys **raw** (no sentinel), `await:"settled"`, return
  a grid delta. `ctrl+c` / a slash command should reach codex verbatim.

## Root cause (confirmed in code)

One decision drives both symptoms — the daemon believed the session was a
**shell sitting at a prompt** when codex was actually the foreground
program.

`await:"auto"` resolution (`bud/src/terminal/manager.rs`
`effective_await`):

```rust
let at_prompt = facts.open_command.is_none()
    && matches!(facts.mode, Mode::Shell | Mode::Unknown);
if submit && at_prompt { Command } else { Settled }
```

- `Command` await then (a) **sentinel-wraps** the text
  (`SENTINEL_TRAILER`, only when `!genuine_osc133`) and (b) waits for a
  `command_finished`.

So the whole failure reduces to: **why is `open_command == None` and
`mode == Shell` while codex is live?**

1. **Mode never became `Tui`.** stem classifies `Tui` **only on
   `AltScreenEnter`** (`bud/stem/src/modes.rs`). Codex is a primary-screen
   TUI, so it never trips that. Its mode is whatever the shell last set —
   `Shell` (the launch went through the OSC-133 shim).

2. **`open_command` is a single slot that any 133;A / 133;D clears**
   (`bud/stem/src/session.rs`): `PromptStart` (`133;A`, emitted by our
   shim's `precmd` on **every** prompt) sets `open_command = None`;
   `CommandEnd` (`133;D`) does `open_command.take()`. codex was launched via
   the integrated shell, so `133;C` set `open_command` at launch (sends
   correctly went `settled` — this is the "worked for most of the run"
   phase). The moment a `133;A`/`133;D` is seen again, the slot clears and
   the session reads as "shell at prompt" even though codex is still the
   foreground process — and every subsequent send flips to `command` +
   sentinel. This is the "falls over at the end" transition.

3. **Feedback loop.** Once misrouted, each sentinel-wrapped send is pasted
   into codex, and the daemon's own injected `133;D` (`SENTINEL_TRAILER`)
   is a `CommandEnd` → `classify_shell_from_marker()` re-asserts
   `Mode::Shell` and clears `open_command` again, so the state is sticky:
   the session cannot climb back out to "codex owns the terminal" on its
   own.

### Two symptoms, one cause
- **Can't stop/exit codex** — `/stop`, `/ps`, and by extension `ctrl+c`-as-
  text get the sentinel trailer appended, so codex sees malformed slash
  commands. (Note: `key:"ctrl+c"` is dispatched as a keypress and is NOT
  sentinel-wrapped — only submitted `text` is. Worth confirming the agent
  used a semantic `key` for interrupts; if it sent `"/stop"` as text
  expecting it to work, the wrap is what broke it.)
- **30s–2m "no output" sends** — a `command` await on a program that never
  emits `133;A`/`133;D` just burns the 2-minute
  `TERMINAL_AWAITED_SEND_TIMEOUT_MS` and reports still-running. The static
  screen never mattered because `command` await (unlike `terminal.wait`'s
  `WAIT_STATIC_CAP=10s`) has no static-screen cede.

## Why the existing `input_absorbed` backstop didn't save it
`await_outcome`'s `expect_start_marker` path resolves `input_absorbed` when
a submitted command on a **genuine-OSC133** shell produces no start marker.
But it is explicitly **excluded for sentinel sessions** ("their start is
synthesized at `D`"), and here the send is on the sentinel path
(`!genuine_osc133` at that moment), so the backstop is off — the await runs
to the full budget instead.

## What is NOT the problem
- Not the `terminal.wait` active-hold change (v0.1.17): these long holds are
  `command` awaits, a different code path with no static cap.
- Not the launch-proof / trust-screen incident
  (`terminal-send-interactive-launch-blind-screen.md`): that was about the
  *first* gesture into a fresh program. This is the opposite end — a program
  that has been correctly interactive for 45 minutes and then gets
  reclassified as a shell.

## Hypotheses to confirm with instrumentation (before any fix)
- **H1 (primary):** capture `mode` + `open_command` + `genuine_osc133` on
  every `terminal.send` across a codex run; expect a clean flip from
  (`shell`, open) to (`shell`, none) at the point sends start getting
  sentinel-wrapped. **Which marker fires the flip** — a stray `133;A`
  (prompt redraw) or a nested `133;D` — is the open question; the trace
  can't tell us which without daemon logs.
  - Candidate sources of that marker while codex is foreground: codex
    running an approved command that reaches the integrated shell; a
    `precmd` firing because codex briefly backgrounds/foregrounds the
    shell (the codex footer literally says "1 background terminal
    running"); or our own sentinel `D` from the first mis-sent gesture
    kicking off loop #3.
- **H2:** confirm codex takes no alt-screen (so `Tui` classification is
  genuinely unreachable for it) — a quick `alt_screen` sample during the
  run.

## Direction (NOT implemented — options to weigh once H1 lands)
Recorded for the follow-up design doc, cheapest first:
1. **Primary-screen interactive detection.** `Tui` keys off alt-screen
   only; codex-class apps (raw mode, bracketed paste enabled, no
   alt-screen) are invisible to it. A "raw-mode foreground app on the
   primary screen" signal (termios raw + `?2004h` bracketed-paste, which
   the daemon already tracks for prediction gating) could suppress the
   `command`/sentinel path independent of the flaky `open_command` slot.
2. **Don't let a nested/echoed `133;D` clear a long-lived foreground app.**
   Reconsider the single-slot `open_command` model, or ignore `133;A`
   prompt markers while a bracketed-paste-interactive app is up.
3. **Static-screen cede for `command` awaits** (mirror `terminal.wait`'s
   `WAIT_STATIC_CAP`): even if misclassified, a `command` await on a
   screen that hasn't changed for ~10s should cede instead of burning 2
   minutes — bounds the blast radius without fixing classification.

## Spec / docs affected (when a fix lands)
- `bud/src/terminal/terminal.spec.md` (await-auto + sentinel decision)
- `bud/stem/src/*.spec.md` (mode classification)
- `docs/proto.md` §6.7.4 if the auto-resolution contract changes
- `AGENTS.md` §4.7 rollout story (daemon-side change ⇒ order-independence)

## UPDATE 2026-08-31 — root cause revised: reattach amnesia, not a stray marker

Full implementation review (manager.rs attach path, stem replay, pump facts)
shows the "which marker cleared the slot" question was the wrong frame:

- `SessionFacts.open_command` / `open_command_screen` / `genuine_osc133` are
  **attachment-local** — `attach()` seeds them `None`/`false` on every
  (re)attach.
- stem's ring replay restores its own internal `open_command`, but events
  below `resume_from_offset` are emit-suppressed, so the pump never
  repopulates the facts from history.
- Therefore any reattach mid-codex (service deploy → reconnect → re-ensure,
  daemon restart, lazy `entry_or_attach`) leaves `mode: shell` (replay
  classification from the launch-era markers) + `open_command: None` +
  `genuine_osc133: false` → `await:"auto"` ⇒ `command` + sentinel trailer.
  Service deploys happened during the incident run (PR merges auto-deploy).
- Sticky exactly as observed: codex emits no markers, so nothing heals the
  facts. (The earlier "our own injected D re-asserts Shell" loop was wrong:
  the trailer is literal text codex swallows — the printf never executes.)
- Related latent hole: TUIs launched from a **sentinel** shell never set
  `open_command` at all (no `C`), so those sessions misroute from the first
  gesture even without a reattach.

Fix package implemented per
[plan/terminal-send-codex-misroute-fix.md](../plan/terminal-send-codex-misroute-fix.md):
service `await:"settled"` override from durable `terminal_command` rows
(fleet-wide), daemon attach-time fact seeding from replay, an
`interactive_foreground` fact from mid-session bracketed-paste enables,
fast `input_absorbed` for sentinel command-awaits under bracketed paste,
decision instrumentation, screen proof on `still_running`, and key-gesture
interrupt guidance in the tool description.
