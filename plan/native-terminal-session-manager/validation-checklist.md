# Validation Checklist: Native Terminal Session Manager

Manual end-to-end verification. §A runs before the Phase 2 branch merges; §A + §B run again at the end of Phase 3. Each item on both macOS (launchd) and Linux (systemd user service) unless marked.

## §A — Core (Phase 2 gate)

> **Run notes (2026-08-17, live macOS run):** happy path verified from the web UI
> (agent `terminal.run` commands, exit codes). Three findings, all diagnosed and
> fixed same-day:
> 1. **Enter inserted a newline in codex** — the browser keydown map sent LF
>    (`\n`); raw-mode TUIs need CR. Fixed in `web/src/lib/terminal-input.ts`.
> 2. **vim modal contents missing / codex misrendered until manual resize** —
>    PTY dimensions came from the stored DB row at ensure, and browser resizes
>    sent before the session existed were dropped. Fixed: the browser re-asserts
>    its dimensions whenever `terminal.status` reports ready/active.
> 3. **codex classified `shell` and never settled** — codex is an inline
>    (non-alt-screen) TUI, so `shell` classification is intentional-honest, but
>    `settled` was suppressed in Shell mode, which would hang agent
>    `terminal.send` awaits. Fixed in `stem::session`: damage-quiet now emits
>    `Settled` while a command is mid-flight even in Shell mode (regression test
>    `mid_command_shell_settles_for_inline_tuis`).
>
> Re-test vim modal + codex rendering after the fixes; if rendering is still
> wrong at correct dimensions, next suspect is the browser xterm's
> `convertEol: true` (rewrites bare LF as CRLF, which corrupts raw-mode apps
> that disable ONLCR).
>
> **Follow-up finding (same run):** stray zsh PROMPT_SP `%` artifacts at the
> prompt. Cause: the dims re-assert (fix 2 above) fired on EVERY ready/active
> status event, and `stem::pty::resize` sent an explicit SIGWINCH even for
> same-size resizes — each signal makes zsh reprint its prompt mid-line,
> rendering the normally-invisible partial-line mark. Fixed both layers:
> no-op resizes are now fully silent in stem (TIOCGWINSZ pre-check, no ioctl,
> no signal), and the browser asserts dimensions once per SSE connection.
> Verified live that geometry converges (holder spawned at the 200×50
> fallback, PTY measured at the browser's 109×57 afterwards).
>
> **Third pass (same day):** artifacts persisted intermittently, live-view
> only (page refresh rendered the same history cleanly). Full forensics:
> ring bytes byte-identical per cycle and correct; DB chunks contiguous (no
> overlap/gap); headless xterm renders the exact bytes perfectly at matched
> width under ANY chunking — but any narrower width, or a resize across live
> writes (reflow), reproduces the artifacts. Conclusion: the defect class is
> client grid-size drift vs PTY size (fit ran only on window-resize/panel
> events). Mitigation shipped: ResizeObserver-driven continuous convergence.
> The structural fix is scoped in
> `design/terminal-grid-sync-and-predictive-echo.md` (server-grid sync makes
> size-mismatch rendering impossible by construction).
>
> **KNOWN LIMITATION (accepted 2026-08-17):** history tail replay can render
> very few visible lines after TUI-heavy sessions. The 128 KiB byte window is
> faithful (verified byte-perfect against the store), but alt-screen +
> cursor-addressed TUI traffic produces no scrollback lines — in the observed
> case the window was 99.8% vim/codex bytes with 320 bytes / 0 newlines after
> the last alt-screen exit, so "3 lines of history" was the correct render of
> those bytes. Bytes ≠ lines. The "Earlier output truncated" banner remains
> honest. Resolution deferred to Phase 3 / grid-sync: serve line-oriented
> scrollback from stem's emulator (which tracks scrollback lines across TUI
> sessions) instead of raw byte tails —
> `design/terminal-grid-sync-and-predictive-echo.md` §3.2/open-q 3. A window
> starting mid-alt-screen also replays TUI paints onto the main screen
> (unmatched `?1049l` detectable if hygiene trimming is ever wanted).
>
> **Fourth pass — ROOT CAUSE:** artifacts persisted after the convergence
> fixes. Actual cause: the service gateways dispatch daemon frames
> concurrently (`void handleIncoming`), and each terminal_output handler
> awaits a DB read + insert — so back-to-back frames from one zsh write burst
> could emit SSE in **completion order, not byte order**. Storage is
> offset-keyed (hence DB contiguous and refresh clean); live rendering is
> order-sensitive (hence `%` marks painted mid-line whenever the `\r\r\n`
> chunk lost the race). Fixed: per-session ingest serialization in
> `TerminalSessionManager` (promise-chain queue wrapping
> status/output/event/send_result/observe_result — also guarantees the proto
> §6.4 rule that event byte references never outrun emitted output), with an
> ordering regression test that models the concurrent-dispatch race.

**Sessions & lifecycle**
- [ ] Fresh thread → session created without tmux installed on the machine; `terminal_status` reaches `ready`
- [x] Two threads on one bud run commands concurrently; a long `terminal.run` (e.g. `sleep 20 && echo done`) in thread A does not delay sends, observes, or heartbeats for thread B — *2026-08-17 live: `terminal_command` rows show A's 20.03s command with five 10–20ms thread-B commands completing entirely inside its window; browser stayed responsive throughout*
- [ ] Session close (thread close) kills the holder; registry dir GC'd

**Deterministic shell path (OSC 133)**
- [ ] `terminal.run` returns exit code 0 / 1 / 130 (Ctrl-C'd) correctly, with plausible `duration_ms`
- [ ] Command output in the result matches the transcript bytes (byte-range slice, no scraping artifacts)
- [ ] Leading-dash literal (`- npm run dev` as raw text) and multi-line paste arrive intact (the old send-keys regressions)
- [ ] zsh, bash, and fish sessions all reach `Shell:AtPrompt` with markers; shell with `BUD_NO_SHELL_INTEGRATION=1` degrades to `mode: unknown` + sentinel fallback still yields an exit code via `terminal.run`
- [ ] A shell whose rc file execs another shell degrades gracefully (no hang; `integration: none` reported)

**TUI & REPL**
- [ ] `vim`: mode flips to `tui` on entry, `settled` fires after paint quiet, mode returns to `shell` on `:q`
- [ ] `codex` (or another heavy TUI): startup renders without the historic 2s dead-air artifacts; interaction round-trips
- [x] `python` REPL: prompt-pattern mode; sends resolve on prompt reappearance; `exit()` returns to shell mode — *2026-08-17 live: chip flipped repl→shell correctly; human path clean. Agent path surfaced two fixed bugs: (1) daemon reset the grid-diff delta baseline at the END of every awaited send, making the send-plus-proof observe structurally empty ("no visible change" for input that visibly echoed) — baseline is now owned solely by observe; (2) `terminal.send raw_text` never pressed Enter, forcing two tool calls per REPL entry — raw_text now submits by default (`submit:false` opts out), with `submitted` surfaced in results*
- [x] Pager (`git log`): usable via `terminal.send` keys; no false "command finished" — *2026-08-17 live: navigation + clean `q` exit to prompt*

**Persistence (the headline feature)**
- [x] `kill -9` the daemon mid-`vim`; daemon restarts; session reattaches; vim screen state correct (allowing one repaint nudge); no duplicate or lost output in the browser — *2026-08-17 live: daemon SIGKILLed with unsaved nvim buffer; holder/shell/nvim all survived (verified at process level), PTY winsize intact, browser reattached with buffer and input working*
- [ ] Simulated upgrade: replace `bud` binary with a rebuilt one, restart service; old holder (previous binary) accepted via IPC handshake; session usable
- [ ] Service-manager restart (`launchctl kickstart -k` / `systemctl --user restart`) — same result
- [x] Output produced *while the daemon was down* (a running `while true; do date; sleep 1; done`) appears in the transcript after reattach (ring backfill), exactly once — *2026-08-17 live: numbered tick loop, daemon SIGKILLed ~20s (ring verified growing +9 B/s with zero daemon processes), restart backfilled a continuous duplicate-free tick sequence in the browser*
- [x] Ring overflow: flood output past the cap, restart daemon → gap is reported (truncation notice), not silently skipped — *2026-08-17 live: `yes` flood ran the ring to 12.5 GB lifetime offset (holder sustained ~GB/min with no daemon attached); reattach produced honest offset-chain gaps in the store (3 gaps incl. a ~10.7 GB ring eviction and two service-downtime windows) plus `terminal.event` SSE emissions. **Found and fixed two real bugs**: (1) the store's 100 MiB soft cap was a LIFETIME cap that permanently muted the session's storage+SSE once crossed — replaced with retention pruning (service-side ring semantics, regression-tested); (2) daemon attach race — concurrent ensure/lazy-reattach spawned two event pumps, duplicating every output frame (visible as doubled byte_offsets in service logs) — fixed with per-session attach locks + displaced-entry abort*
- [x] Holder crash (`kill -9` the holder): daemon reports session closed; next ensure provisions a fresh session cleanly — *2026-08-17 live: initially FAILED, exposing a four-bug chain, all fixed with regression tests: (1) daemon pump ended silently on holder death (no closed status) — now announces; (2) dead session entry stayed in the daemon map (endless Broken-pipe gestures) — pump end now self-removes (ptr-eq guarded); (3) service never stamped `closedAt` on daemon-announced closure, pinning the thread to the dead session — now stamped; (4) the crashed turn's orphaned function_call poisoned the thread permanently at the provider ("No tool output found") — conversation loader now injects interrupted-results for orphaned calls (provider-agnostic). Re-test: fresh session provisioned automatically, command exit 0. Polish: sentinel trailer no longer echoes on the first command of fresh integrated sessions (bounded first-prompt grace before the wrap decision)*

**Wire/service integrity**
- [ ] Terminal events from bud A cannot touch a session owned by bud B (cross-bud rejection test, can be automated)
- [ ] `terminal_command` rows: owner-stamped, exit codes correct, byte ranges slice the right output
- [ ] Migration applied via checked-in Drizzle migration on a staging-style `db:migrate` run (not just `db:push`)

## §B — Clients & install (Phase 3 gate)

**Web**
- [ ] Kill the SSE connection mid-stream (dev proxy drop): browser resumes from offset — no visible reset, no lost or duplicated lines (verify against a numbered `seq 1 10000` output)
- [ ] Multi-byte/emoji output across chunk boundaries renders without U+FFFD
- [ ] No spurious "Reconnecting…" overlay during 10 minutes of idle session with heartbeats
- [ ] Command chips show running → exit-code states from `terminal.event`; TUI mode indicator appears in vim
- [ ] Input typed during a brief disconnect is queued-with-indicator or visibly rejected — never silently dropped

**Install & doctor**
- [ ] Clean machine (no tmux): installer → claim → working session; installer output mentions no tmux
- [ ] `bud doctor`: passes on healthy install; detects missing supervision directives; `--cleanup-tmux` removes orphaned `s_*` sessions on a machine upgraded from the tmux era and is a no-op elsewhere
- [ ] Uninstall leaves no holders running and no registry litter

**Mobile contract**
- [ ] Handoff doc reviewed against a captured SSE transcript (shapes match `docs/proto.md`)

## Regression sentinels (quick greps, automatable)

- [ ] `grep -r "tmux" bud/src` → only `doctor --cleanup-tmux`
- [ ] `grep -rn "wait_for\|looks_like_prompt\|confidence" service/src/agent docs/proto.md` → no live references to the retired vocabulary
- [ ] No `sleep`-based coordination in `bud/src/terminal/` (the 10ms/30ms guards must not reappear)
