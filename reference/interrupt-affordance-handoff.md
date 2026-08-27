# Interrupt Affordance Handoff — fact-gated Ctrl+C for the mobile client

The always-visible Interrupt button is a tmux-era artifact: the client
couldn't know whether anything was running, so the button had to be
unconditional. Post-stem, the stream carries typed facts that say exactly
when an interrupt is meaningful. Web now ships a contextual version
(branch `feat/contextual-interrupt`), live-verified against a real stack —
this doc is the pattern, the exact gate, and the pitfall the browser probe
caught, so mobile can port it without rediscovering any of it.

Companion docs: `reference/mobile-grid-contract-pack.md` (frame/field
schemas this gate reads), `design/mobile-terminal-events-handoff.md`
(the `terminal.event` fact vocabulary).

## 1. The gate

All inputs are things the mobile client already consumes. Precedence
matters — evaluate in this order:

```
show_interrupt =
  connected
  AND NOT full_screen          # alt_screen (grid fact) — or mode == "tui" when no grid frames
  AND (command_open            # command_started seen, no command_finished yet
       OR (grid_seeded AND NOT predict_ok))
```

| Input | Source |
|---|---|
| `command_open` | `terminal.event`: `command_started` → open, `command_finished` → closed, `child_exited` → cleared (the command-chip reducer mobile already has) |
| `alt_screen` | latest `terminal.grid` frame |
| `predict_ok` | latest `terminal.grid` frame (§6.8.3 gate: true exactly at an interactive prompt — mode ∈ shell/repl, no open command, primary screen, not a silent password read) |
| `mode` | `terminal.event` `mode_changed` fact (fallback full-screen signal when grid frames aren't flowing) |

What each state yields:

| Session state | Interrupt |
|---|---|
| Idle prompt (shell or REPL) | **Hidden** — Ctrl+C only clears the input line; keep it reachable in the keyboard accessory row instead |
| Command running (`sleep`, builds, …) | **Shown** — place it on/next to the running-command chip so it reads as "stop *this*" |
| Busy REPL, `unknown` mode, password prompt (`read -s`) | **Shown** — `predict_ok:false` on the primary screen covers all three; `unknown` mode keeps it visible permanently, which is the correct honest fallback |
| Alt screen / `tui` mode (vim, less, htop) | **Hidden** — even mid-command (see §2). Ctrl+C belongs in the key accessory row there |
| Disconnected / bud offline | **Hidden** |

**Degradation**: pre-phase-3 daemons omit `predict_ok`; default it to
`false` and the button is simply always visible outside the alt screen —
i.e. today's behavior. No version check needed.

## 2. The pitfall the probe caught (don't skip this)

First implementation checked `command_open` before the alt screen, and the
live probe failed on `less /tmp/file`: **a TUI launched as a command keeps
the command open for its entire run** (`command_finished` only fires on
exit, with `interactive_started` in between), so the button stayed visible
inside the pager. Full-screen suppression must **outrank** the
open-command signal. If your first port shows Interrupt inside vim, this
is why.

## 3. Endpoint semantics to wire into the UX

- `POST /api/threads/:thread_id/terminal/interrupt` → `{ ok, session_id,
  submitted, rejected_pending_requests }`. It is **dispatch-only** (^C
  through the normal send path): `submitted: true` means delivered, not
  "the process died". Drive UI transitions from the facts that follow
  (`command_finished` with exit ~130, `prompt_ready`) — never from the
  POST response.
- The button hides itself through the same gate: the `command_finished` /
  `predict_ok:true` frame that follows a successful interrupt flips it
  off. No optimistic hiding needed (and none wanted — a program that traps
  SIGINT legitimately keeps running, and the button honestly stays).
- If the **agent** is mid-`terminal.run` when a human interrupts, the tool
  await resolves normally with the real exit code as an ordinary tool
  result — no error state to handle.
- Missing session → `404 { "error": "no_terminal_session" }`.

## 4. Web reference implementation

- `web/src/features/threads/terminal-interrupt.ts` — the gate as a pure
  function (`showTerminalInterrupt`), ~20 lines; port this directly.
- `web/src/features/threads/terminal-interrupt.test.ts` — the unit matrix
  (connection states, TUI-as-command precedence, busy/idle/password,
  bytes-renderer fallback); port the cases as-is.
- `web/src/components/workbench/thread-terminal-pane.tsx` — render site:
  the button sits in the terminal status bar next to the mode/command
  chips, styled as a destructive-tinted pill. Web keeps an unconditional
  Interrupt in the terminal overflow menu as the escape hatch — the mobile
  analogue is Ctrl+C in the keyboard accessory row, which should remain
  always available.

## 5. Verification checklist (what web's 9/9 live probe asserts)

1. Idle prompt → hidden.
2. `sleep 30` → appears; tapping it → `^C` echoes, chip shows `exit 130`,
   button hides at the next prompt.
3. `less <file>` (launched as a command) → hidden while the pager is open.
4. `read -s X` → appears (silent password read); tapping it cancels the
   read and the button hides.
5. Terminal stays fully live after every interrupt.

Run the same five on device — they exercise every branch of the gate.
