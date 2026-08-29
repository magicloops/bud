# Debug: launching a TUI then sending to it — input lost (codex)

## Environment
- Daemon v0.1.14, service main (knobless `terminal.wait` #83), agent
  gpt-5.6-luna. Codex CLI 0.150.0 on Ubuntu (inline TUI: bracketed paste
  on, no alt screen; ~3 s startup incl. a network update check).

## Repro (from the 2026-08-29 06:58Z run)
1. `terminal.run` `cd ~/doner-compare && codex` → returned in **267 ms**
   with `status:"interactive"` (`interactive_started`, signal
   `bracketed_paste`). Nothing had painted yet.
2. ~3 s later (model latency) `terminal.send raw_text:"Build the same
   website…"` (submit) → dispatched; settled after 1260 ms. The send's
   OWN delta contains codex's startup banner and an EMPTY input box
   (`› Ask Codex to do anything`): the text was typed before codex had
   initialized its input and was discarded (raw-mode enable flushes
   pending tty input) — never submitted.
3. `terminal.wait` → nothing ever happened; user canceled after 84 s.

## Root causes
1. **`interactive_started` resolves too early.** The daemon resolves a
   command-await at the FIRST interactive signal (bracketed-paste enable /
   alt-screen entry). Codex enables ?2004 within ~250 ms of exec but paints
   its UI seconds later. "Interactive" ≠ "ready": the program must have
   painted and gone quiet before the agent can drive it.
2. **No input gating.** `terminal.send`/`run` write bytes immediately,
   even when the foreground program has produced no output since it
   started or the screen is still changing. Bytes typed into an
   uninitialized TUI are lost (or land in the wrong widget).
3. **Two tools with a declared-intent split.** `terminal.run` is refused
   while a command is open; `terminal.send` is "for programs". The model
   must classify terminal state before every call — exactly the decision
   the user wants the daemon to own. In the tmux era one send waited until
   the screen was visually quiet, so launch→drive sequences worked.

## Expected
Launching a program returns when the program is READY (painted + quiet);
any subsequent input is delivered only when the program can accept it;
one tool sends input and the daemon chooses the wait.

## Fix
See `plan/terminal-input-unification.md`: Phase 1 (daemon readiness +
input gating, no contract change) fixes this repro; Phase 2 unifies the
tools.

## Spec files affected
- `bud/src/terminal/terminal.spec.md`, `docs/proto.md` §6.7
- `service/src/agent/agent.spec.md`, tool definitions + system prompt
- `web/src/components/message-renderers/*.spec.md` (Phase 2)

## Resolution (2026-08-29)

Shipped as `feat/terminal-send-unified`:
- Daemon: `await:"auto"` (prompt → command boundary, program → settled);
  readiness = screen changed since `command_started` (`Event::CommandStarted`
  now carries the baseline screen) AND damage-quiet; `interactive_started`
  is held until ready (cap `PROGRAM_READY_CAP` 10 s → `ready:false`);
  every send into an open command is gated on readiness (`gated_ms`,
  `program_ready`); the `command_in_flight` refusal is gone. Byte counts
  were tried first and rejected: the `?2004h` enable and the Enter echo are
  bytes but not a UI.
- Service: `terminal.send { text | key, submit? }` is the only input tool;
  two result shapes by daemon decision. System prompt, contracts, renderers,
  loaders updated; `terminal.run` retired outright.
- Daemon regressions (scripted codex-shaped TUI): launch holds until paint,
  early send is gated and delivered, ready-cap path, prompt commands
  unchanged, input into an open program delivered after it yields.
