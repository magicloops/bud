# Validation Checklist: Native Terminal Session Manager

Manual end-to-end verification. §A runs before the Phase 2 branch merges; §A + §B run again at the end of Phase 3. Each item on both macOS (launchd) and Linux (systemd user service) unless marked.

## §A — Core (Phase 2 gate)

**Sessions & lifecycle**
- [ ] Fresh thread → session created without tmux installed on the machine; `terminal_status` reaches `ready`
- [ ] Two threads on one bud run commands concurrently; a long `terminal.run` (e.g. `sleep 20 && echo done`) in thread A does not delay sends, observes, or heartbeats for thread B
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
- [ ] `python` REPL: prompt-pattern mode; sends resolve on prompt reappearance; `exit()` returns to shell mode
- [ ] Pager (`git log`): usable via `terminal.send` keys; no false "command finished"

**Persistence (the headline feature)**
- [ ] `kill -9` the daemon mid-`vim`; daemon restarts; session reattaches; vim screen state correct (allowing one repaint nudge); no duplicate or lost output in the browser
- [ ] Simulated upgrade: replace `bud` binary with a rebuilt one, restart service; old holder (previous binary) accepted via IPC handshake; session usable
- [ ] Service-manager restart (`launchctl kickstart -k` / `systemctl --user restart`) — same result
- [ ] Output produced *while the daemon was down* (a running `while true; do date; sleep 1; done`) appears in the transcript after reattach (ring backfill), exactly once
- [ ] Ring overflow: flood output past the cap, restart daemon → gap is reported (truncation notice), not silently skipped
- [ ] Holder crash (`kill -9` the holder): daemon reports session closed; next ensure provisions a fresh session cleanly

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
