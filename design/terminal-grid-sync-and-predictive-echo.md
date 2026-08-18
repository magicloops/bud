# Design: Terminal Grid Sync + Predictive Echo (the "right way" for live terminal UX)

Status: **accepted — implementation planned** (2026-08-18). Owning plan:
[plan/terminal-grid-sync/](../plan/terminal-grid-sync/terminal-grid-sync.spec.md)
(phases 0–3; open questions §6 resolved there). Originally the
plan/native-terminal-session-manager Phase 4 slot.

Related: [design/native-terminal-session-manager.md](./native-terminal-session-manager.md)
(D5 emulator, D8 output model, D15 contracts),
[design/network-upgrade-quic-transport.md](./network-upgrade-quic-transport.md),
validation findings in
[plan/native-terminal-session-manager/validation-checklist.md](../plan/native-terminal-session-manager/validation-checklist.md).

## 1. Problems this solves

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

## 2. The core insight

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

## 3. Scoped components

### 3.1 Grid-sync protocol (daemon → service → client)

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

### 3.2 Client grid renderer

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

### 3.3 Predictive local echo (the mosh-like part)

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

### 3.4 Transport evolution (independent axis)

SSE works for grid deltas initially. The QUIC/WebTransport design
(network-upgrade docs) slots in later for loss-tolerant low-latency delivery;
grid-sync's skip-ahead semantics are what make lossy transport *useful*
(mosh's datagram insight). Don't couple the two initially.

### 3.5 Revisit under grid-sync: single adaptive terminal tool

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

## 4. What this is NOT

- Not a replacement for `terminal_output` byte storage, command byte ranges,
  or offset resume — the durable/audit path is untouched.
- Not multi-viewer session sharing (still out of scope per AGENTS.md).
- Not a commitment to drop xterm.js on day one — it runs behind a flag until
  the grid renderer passes the same fixture corpus.

## 5. Rough effort

| Piece | Size |
|---|---|
| stem cell-damage export + termios facts | S–M |
| grid-delta frames daemon→service→SSE | M |
| web canvas grid renderer (cells, cursor, selection, scrollback splice) | M–L |
| predictive echo + reconciliation | M |
| native-client renderer (libghostty) | later, unblocked by protocol |

## 6. Open questions

1. Cell attr fidelity floor for v1 (truecolor + basic attrs; hyperlinks/images later?).
2. Selection/copy UX on a grid renderer (needs logical-line metadata from emu reflow info).
3. Scrollback: server-side emu history vs client splice of byte-derived history (lean: emu scrollback lines over the same delta channel, capped). Note: byte-derived history is now a DOCUMENTED §A limitation — a raw byte tail after TUI-heavy use renders ~zero lines (alt-screen bytes leave no scrollback), so emu-line scrollback is the accepted resolution, not just a preference.
4. Where the flag lives during coexistence (per-user? per-session?).
