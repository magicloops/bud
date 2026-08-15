# Design: Native Terminal Session Manager (tmux replacement)

Status: **draft for discussion, rev 2** — enumerates the approaches and decisions; each decision lists options, trade-offs, and a recommendation to react to.

> **Rev 2 constraint update:** Bud is pre-release, and compatibility with the existing daemon internals, Bud↔service wire contract, SSE shapes, agent tools, and web/mobile API is **not required** — all tiers may change where it reduces long-term tech debt. This flips D10 and D14 from compatibility-preserving to clean-cutover, and adds D15 (end-to-end contract redesign). The `stem` package shape and separation of concerns (§2) are confirmed direction.

Related:
- [review/repo-quality-assessment-2026-08-14.md](../review/repo-quality-assessment-2026-08-14.md) §1 (tmux deep dive, hacks inventory, replacement effort table)
- [design/backend-neutral-terminal-wire-contract.md](./backend-neutral-terminal-wire-contract.md) (the wire contract this must preserve)
- `bud/src/terminal/backend.rs` (the `TerminalBackend` trait seam)
- `plan/refactor-daemon/` (the refactor that created the seam, anticipating "future PTY or mosh-like backends")

---

## 1. Problem and goals

Bud currently multiplexes terminals through tmux via a shell-out wrapper: subprocess per operation, output via `pipe-pane` to a log file stat-polled every 50ms, screen state via repeated `capture-pane` scraping. This forces the polling/heuristic readiness machinery onto *every* command, leaks tmux vocabulary and user tmux config into sessions, requires users to install tmux alongside Bud, and still provides no command-lifecycle semantics (no exit codes, no "command done" event).

**Goals** (in priority order):

1. **Session management** — thread-scoped sessions with the current lifecycle (`pending → creating → ready ↔ active → idle → closed`). The Bud↔service wire contract is free to evolve (D15); what must be preserved is the *model*: service-owned session IDs, reattach-by-id, ordered raw output streaming.
2. **Survives daemon restarts** — sessions (running processes, screen state, scrollback) outlive daemon crashes and installer-driven upgrades, matching what the tmux server provides today.
3. **OSC 133 shell integration** — deterministic command lifecycle for shell commands: prompt-start / command-start / output-start / command-done(**exit code**) as *events*, eliminating polling for the standard-command path.
4. **Efficient TUI handling** — alternate-screen detection as the mode switch; "settled" derived from emulator damage tracking + cursor stability instead of capture-pane hashing.
5. **Line-based REPL handling** — a scoped prompt-pattern path for REPLs (python, psql, node, …) that use neither OSC 133 nor the alt screen.
6. **Single-artifact install** — ships inside the Bud binary; `install.sh` installs Bud, period. No tmux preflight, no remediation docs, no external runtime dependency.
7. **Separate package** — a library crate with no Bud-specific types, usable and testable independently of the daemon.

**Non-goals (v1):** windows/panes, session sharing between humans, mosh-style roaming transport, Windows/ConPTY (see D12), migrating live tmux sessions (see D14).

---

## 2. Proposed shape (summary)

A new Rust library crate — working name **`stem`** (sessions grow on it; alternatives: `budterm`, `holdfast`) — plus a tiny per-session **holder process** that is the *same shipped binary* re-invoked as a subcommand. The daemon becomes a thin client of holders over Unix domain sockets.

```
bud daemon ──UDS──▶ holder (bud term-hold, 1/session)
                      ├─ PTY master ⇄ shell/TUI (child)
                      ├─ raw output ring buffer (capped)
                      └─ minimal framed IPC: write / resize / subscribe / snapshot / kill
bud daemon (in-process, per attached session):
                      ├─ VT emulator (grid, damage, alt-screen, cursor)  ← replayed from ring on attach
                      ├─ OSC 133 / mode state machine (Shell / TUI / REPL / Unknown)
                      └─ daemon terminal runtime rebuilt directly on stem's event API (no compat adapter — D10)
```

The load-bearing idea: **the holder is deliberately dumb** — a PTY pump plus a ring buffer. All intelligence (emulation, OSC 133, readiness) lives daemon-side where it upgrades with every release. The holder is the only code that must stay compatible across upgrade skew, so it should be small enough to essentially never change.

---

## 3. Decision register

### D1. Packaging and shipping

**Options:**
- (a) New crates in a Cargo workspace at `bud/` (convert the current single-package `bud/Cargo.toml` into a workspace: `bud` bin + `stem` lib), holder as a hidden subcommand of the `bud` binary (`bud term-hold --session <id>`).
- (b) Separate repo / published crate from day one.
- (c) Second shipped binary (`stem-hold`) alongside `bud` in the archive.

**Recommendation: (a).** Workspace keeps iteration speed while enforcing the dependency direction (`stem` must not import daemon types); extraction to its own repo stays cheap later. The subcommand re-exec trick is how the single-install goal is met — one binary, no second artifact for the installer/manifest to track. Guardrails: `stem` gets its own spec file, no `crate::` imports from `bud`, and the holder entry point lives in `stem` (the `bud` bin just forwards argv).

**Consequence to accept:** the holder that keeps running after an upgrade is the *old* binary version (see D3 version skew).

### D2. Persistence model — the crux

**Options:**
- (a) **In-process only.** PTYs owned by the daemon; sessions survive network disconnects (free) but die on daemon restart/upgrade.
- (b) **Holder process per session** (proposed). Detached process owns the PTY + ring buffer; daemon reattaches via socket.
- (c) **Single holder server** for all sessions (a mini tmux server). One process, one socket.
- (d) Keep tmux purely as a dumb persistence shell, drive it better (control mode).

**Recommendation: (b).** Rationale:
- (a) regresses the upgrade flow: today `launchd`/`systemd`-driven daemon upgrades do not kill user shells, and the service reuses per-thread session IDs from Postgres expecting reattach. Restart-survival was named as a requirement.
- (c) recreates tmux's blast radius — one holder crash kills every session on the machine — and makes the long-lived compatibility surface *larger* (session table, multiplexed protocol) instead of smaller.
- (b) isolates failure per session, keeps the skew-sensitive code tiny, and maps 1:1 onto the existing `session_exists`/reattach flow.
- (d) is the fallback if (b)'s supervision problems (D3) prove nasty on macOS — it keeps persistence but retains the tmux install requirement, failing goal 6.

**Crash semantics to accept (same as tmux today):** holder crash = session lost; daemon reports `terminal_status: closed` and the service creates a fresh session on next ensure.

### D3. Holder lifecycle, supervision, and upgrade skew

Sub-decisions:

**3a. Detachment.** Holder must survive the daemon's exit *and* the service manager's teardown of the daemon. `setsid()` + double-fork (or `Command` with `pre_exec` setsid), stdio to a per-session log. **Known risk:** launchd may kill spawned children with the job unless the daemon's plist sets `AbandonProcessGroup=true`; systemd user services kill the cgroup unless `KillMode=process` is set. **The installer/service templates in `plan/daemon-readiness` must change in lockstep with this design** — this is the single most likely place for the design to get dirty, and needs a spike before anything else is built (see §6 Phase 0).

> **SPIKE RESULT — macOS (2026-08-15, `spikes/holder-survival/findings.md`): GO, 8/8 PASS.** The double-fork + `setsid` detached holder survived natural job exit, daemon `kill -9`, `launchctl kickstart -k`, and a binary-replace upgrade — with reattach proven (holder pid unchanged) — under **both** `AbandonProcessGroup=true` and `false`. The plist directive is not load-bearing on macOS; the daemonization mechanics alone suffice. Keep `AbandonProcessGroup=true` in templates as defense-in-depth. **Linux systemd matrix still pending** — the D2(d) fallback trigger now rests solely on the Linux result.

**3b. Discovery/registry.** `~/.bud/term/<session_id>/` containing `holder.sock` (UDS, dir mode 0700), `meta.json` (holder pid, binary version, IPC protocol version, created_at, shell, initial cwd), and `ring.log` if D8 chooses file-backed. `session_exists` = socket connect + version handshake succeeds; stale dirs (dead pid) are garbage-collected on daemon start. This registry replaces both `has-session` and the currently-vestigial journal for terminal state.

**3c. IPC protocol.** Length-prefixed frames over UDS; postcard/bincode with an explicit `proto_version` in the handshake. Command set (deliberately closed, ~8 ops): `Hello`, `Write(bytes)`, `Resize(cols,rows)`, `Subscribe(from_ring_offset)` → server-push `Output(offset, bytes)` + `ChildExited(status)`, `RingSnapshot`, `Stat` (child pid, ring extent), `Kill`, `Shutdown`. No screen-state ops — the holder doesn't have screen state.

**3d. Version skew policy.** New daemon must speak to old holders. Policy: the IPC protocol is versioned and additive-only; a daemon may refuse a holder *newer* than itself (shouldn't occur) but must support holders ≥ N-2 releases old. Because the holder is a dumb pump, the realistic change rate is near zero; if a breaking change is ever needed, the escape hatch is "old sessions keep old behavior until closed."

**3e. Runaway protection.** Holder self-terminates when: child exits and ring has been drained by a client (or after a grace TTL with no client, e.g. 24h configurable), or on `Kill`. Prevents orphan accumulation that tmux handles via its server.

### D4. PTY layer

**Options:** `portable-pty` (wezterm project) vs. raw `nix`/`rustix` `openpty` + fork.

**Recommendation: `portable-pty`.** Maintained, handles the fiddly parts (controlling terminal, `TIOCSWINSZ`, process group), and keeps a future ConPTY door open. The `nix` crate is already a dependency if we prefer zero new deps, but hand-rolling PTY setup is where subtle bugs live. Holder-side only — this dependency never touches the daemon's hot path.

### D5. VT emulator

Requirements: damage/dirty tracking, scrollback, alt-screen state, cursor position, hook for unrecognized OSC (needed for 133 unless we pre-parse), active maintenance, compatible license.

**Options:**
- (a) `wezterm-term` — most complete/battle-tested; heavier; MIT.
- (b) `alacritty_terminal` — fast, damage tracking exists (built for a renderer); scrollback native; Apache-2.0; API churn between releases is the known cost.
- (c) `vt100` crate — small, simple; no damage tracking (screen-diff only), stagnant.
- (d) Custom on `vte` parser — full control, most work.

**Recommendation: (a) `wezterm-term`, with (b) as the benchmark alternative** — decide via a 1-day spike rendering the existing capture fixtures (`bud/src/terminal/test_support.rs` corpus) through both. (c) is disqualified by no damage tracking — damage is the mechanism that replaces capture-hashing for TUI settling. Note: the emulator runs **daemon-side** (D2), so upgrading it is a normal release, never a skew problem.

> **DECIDED (2026-08-14, Phase 0 bake-off — `spikes/emulator-bakeoff/findings.md`): `alacritty_terminal` 0.26.x**, reversing the initial lean. Grid fidelity was a dead tie across the six-fixture corpus (real recorded vim alt-screen, DECSTBM scroll regions, wide/ZWJ/combining UTF-8 including a codepoint split at the 16,384-byte chunk boundary); the deciding factors were packaging and weight: `wezterm-term` is **not published on crates.io** (git-pin-forever dependency, 252 transitive deps vs 39) while alacritty_terminal is a normal semver dep, and it parses 4.4× faster (191 vs 44 MB/s — relevant to ring replay). wezterm's genuine advantages are neutralized: native OSC 133 semantic zones don't matter because D6a already commits to emulator-agnostic pre-parsing (`termwiz` 0.23 offers a typed FinalTerm parser if wanted), and alacritty's damage quirk (`damage()` always includes the cursor cell, `Full` on viewport scroll) is a small cursor-filter in `stem::emu` — which must ship with a dedicated regression test. Pin the minor version and confine the API to the one adapter module (known churn between alacritty minors). Flip conditions: fidelity failure on future htop/codex fixtures, or a hard requirement for multi-observer damage / native semantic zones.

### D6. Semantic events: OSC 133 pipeline and shell hook injection

**6a. Where 133 is parsed.** Pre-parse the raw stream with a small scanner *before* feeding the emulator, rather than relying on emulator OSC callbacks — keeps the semantic layer emulator-agnostic (survives a D5 change) and works identically in ring-replay on reattach.

**6b. Hook injection.** Bud spawns the session shell, so it can bootstrap integration without touching user dotfiles:
- zsh: `ZDOTDIR` shim that sources the user's real zdotdir then adds precmd/preexec emitters.
- bash: `--rcfile` shim (interactive) sourcing the user's rc then hooks (bash-preexec technique).
- fish: emits OSC 133 natively (≥3.6); no shim.
- Anything else / user opt-out (`BUD_NO_SHELL_INTEGRATION=1`): no markers; session runs in fallback mode (D7).

**Decision needed:** shim vs. asking users to install hooks. **Recommendation: shim, always, silently** — it's the difference between "works out of the box" and a setup doc. Risk: user rc files that exec a different shell or clobber hooks; detection is trivial (no `A` marker within N seconds of session start → mark session `integration: none` and fall back), so the failure mode is graceful degradation, not breakage.

**6c. Sentinel fallback.** When integration is absent and the agent runtime knows it is at a shell, `terminal.send` may wrap commands with an invisible trailer (`; printf '\033]133;D;%s\007' $?`) so the same `CommandEnd(exit)` event fires. This is a *daemon policy* decision layered above `stem`; the package just reports markers wherever they come from. (This also means the deterministic path can be validated against the current tmux backend via the pipe-pane log before `stem` ships — cheap de-risking.)

**6d. What the exit code changes upstream.** Command lifecycle (start / finish / exit code / duration) becomes a first-class typed event on the wire and in the agent tool results — the agent stops inferring success from scraped text entirely. The full contract redesign this enables is D15.

### D7. Mode model and readiness (replaces the four wait strategies)

Per-session state machine, driven entirely by stream events:

| Mode | Entered by | "Done/settled" signal | Polling? |
|---|---|---|---|
| `Shell:AtPrompt` | OSC 133 `A` | — (already settled) | none |
| `Shell:Running` | OSC 133 `C` (or `B`→bytes) | OSC 133 `D` + exit code | none |
| `Tui` | alt-screen enter (`?1049h`/`?47h`) | damage-quiet ≥ N ms + cursor stable (emulator-driven, event-based timer — not capture polling) | timer only |
| `Repl` | prompt-pattern registry match at cursor line, outside alt-screen, no 133 | pattern reappears after input, else damage-quiet fallback | timer only |
| `Unknown` | integration absent / nothing matched | today's heuristics, demoted to fallback | legacy |

**Decision: where does this live?** Options: inside `stem` vs. in the daemon's readiness layer.
**Recommendation: split.** `stem` emits *facts* (mode transitions, 133 events, damage-quiet notifications, cursor, alt-screen flag); the daemon's readiness module maps facts to the wire contract's readiness/confidence/hints vocabulary and owns the REPL pattern registry (it's product policy and will churn). `readiness.rs` shrinks to that mapping plus the `Unknown` fallback; `delta.rs` is replaced by emulator damage regions; the 10ms/30ms sleep guards and quiescence samplers are deleted (writes are ordered; output is push).

### D8. Output model: ring buffer, replay, and the wire contract

- **Ring:** holder keeps a capped raw-byte ring (default 8 MiB/session, configurable) with absolute byte offsets from session start. **Sub-decision:** memory-only vs file-backed (`ring.log` with head pointer). **Recommendation: file-backed** — it makes holder restarts-of-the-daemon trivially resumable and keeps holder RSS tiny; it is *not* unbounded like today's `terminal.log` (fixed cap, in-place wrap).
- **Streaming:** daemon subscribes from its last acked offset; chunking to ≤16 KB offset-addressed frames happens daemon-side. Bytes produced while the daemon was down are still in the ring, so post-restart streaming backfills from the service's committed offset instead of silently skipping — this is half of the offset-resume protocol in D15a.
- **Reattach screen state:** daemon replays the ring tail through a fresh emulator. If the ring wrapped mid-alt-screen-app, state may be approximate → follow with a `SIGWINCH` wiggle (resize ±1 col and back) to force a TUI repaint, the standard trick. Enumerated as accepted imperfection.
- **UTF-8:** chunk boundaries remain byte-based per the wire contract; splitting codepoints stays legal on the wire (consumers already must handle it — the web currently doesn't, tracked separately in the quality assessment).

### D9. Input model

- Literal text = raw bytes written to the PTY master. Atomic ordering kills the text-then-Enter race by construction.
- Semantic keys → escape-sequence table, **mode-aware** via the emulator (DECCKM application cursor keys, keypad mode), which fixes a latent tmux-path bug class and unlocks chords (`M-x`, `S-Tab`, function keys) that `send-keys` single-key dispatch can't express today.
- **Bracketed paste** for multi-line literal text when the application has enabled it (emulator knows) — this is the correct fix for the newline/Enter-splitting contortions in `interaction.rs`.
- The temporary `keys` wire alias (backend-neutral contract rollout) dies with this backend.

### D10. API surface: replace the `TerminalBackend` trait, don't implement it

The current trait is tmux-shaped (`log_path`, `reset_pipe`, `set_history_limit`, `spawn_output_watcher(log_path, …)` all assume a tailed log file), and with compatibility off the table there is no reason to keep it or the tmux backend behind it.

**Options:** (a) implement the trait as-is with shims for drop-in rollout, retire it later; (b) delete the trait and the tmux backend; the daemon's terminal runtime is rebuilt directly on `stem`'s native API.

**Recommendation: (b).** The adapter/dual-backend path (previous rev's recommendation) existed solely to de-risk a production rollout that doesn't exist yet. Building shims for `reset_pipe`-shaped methods is pure throwaway work, and worse, it would preserve the log-tailing *mental model* in the runtime layer that stem exists to kill. Consequences: `tmux.rs` and the trait are deleted rather than deprecated; git history is the fallback; the readiness/interaction/delta layers are rewritten against events in the same stroke rather than in a later phase. Whether `stem` should still define a small backend abstraction *internally* for its own tests (FakeSession) is a package-internal detail, not a daemon seam.

`stem`'s native API is session-handle-based: `create/attach → handle{ write, resize, kill, events() → stream<Event>, screen() → Grid+damage, ring_read(range) }` where `Event = Output | ModeChanged | CommandStart | CommandEnd{exit} | PromptStart | DamageQuiet | ChildExited | Resized`.

### D11. cwd / pid / foreground-process introspection

Replaces `#{pane_pid}` / `#{pane_current_path}`: child pid is known at spawn (holder `Stat`); cwd via `/proc/<pid>/cwd` (Linux) and `libproc` `PROC_PIDVNODEPATHINFO` (macOS); foreground process via `tcgetpgrp` on the PTY (feeds the file-viewer cwd-resolution path that today shells out to tmux per send). Small platform-specific module in `stem`. Note OSC 133 shells usually also emit OSC 7 (cwd URL) — parse it when present; it's fresher and cheaper than proc inspection.

### D12. Platform scope

v1: macOS + Linux (current install targets). Windows: excluded — but D4's `portable-pty` choice and the holder abstraction are the two places where ConPTY would land, so no door is closed. BSDs: untested-but-probably-fine tier.

### D13. Human escape hatch (replaces `tmux attach`)

Losing `tmux attach` removes the undocumented operator hatch. **Options:** (a) drop it; (b) `bud term attach <session>` CLI that speaks the holder IPC and puts the invoking TTY in raw mode. **Recommendation: (b), deferred until after rollout** — it's ~a day of work on top of the holder protocol and is worth having for support/debugging, but it is not on the critical path. Enumerate read-only (`bud term peek`) vs read-write attach as a sub-decision when picked up.

### D14. Cutover and migration

Pre-release status makes this a hard cutover, not a rollout:

- One long-lived branch; tmux backend, trait, and the readiness/wait-strategy zoo deleted in the same change set that lands the stem runtime. No config-flag dual-backend period, no bake against production traffic (there isn't any). Validation burden shifts to the fixture corpus and the Phase 0 spike instead of a canary.
- No migration of existing tmux sessions: after cutover, previously created tmux-named sessions are simply not found → the service provisions fresh sessions. A one-shot `bud doctor --cleanup-tmux` kills orphaned `s_*` sessions rather than silently leaving them.
- Doctor: tmux checks deleted; new checks added (registry dir writable, holder spawn/detach smoke test, launchd/systemd survival probe).
- Installer: tmux preflight/remediation removed (`plan/daemon-readiness` phase-4 docs updated).
- Spec/docs: `docs/proto.md` gets a versioned terminal-contract revision (D15); `bud/src/src.spec.md` and `bud.spec.md` §Why tmux? rewritten.

### D15. End-to-end contract redesign (unlocked by pre-release status)

With all tiers changeable, the terminal contract should be redesigned around `stem`'s typed events rather than retrofitting them into the readiness-confidence vocabulary. This is where most of the long-term debt reduction lives.

**15a. Bud↔service wire (`docs/proto.md`, new proto rev).**
- **Keep** raw output streaming as byte-offset-addressed ≤16KB chunks — that design is sound. **Drop `seq` for terminal output**: `byte_offset` already provides ordering and dedup; carrying both invites the reset-mismatch bugs we have today. (Frame-level `message_id` stays per the envelope contract.)
- **Resume done properly:** `terminal_ensure` carries the service's last committed `byte_offset`; the daemon backfills from the holder's ring from that offset. Offsets are absolute from session start and never reset on reattach. This closes today's end-to-end resume failure (daemon offset-jump on reattach, service `tailOutput` mid-chunk loss, browser reset+snapshot) with one coherent mechanism.
- **New `terminal_event` frame** replacing readiness confidence/hints as the primary signal: `prompt_ready`, `command_started{command_id}`, `command_finished{command_id, exit_code, duration_ms}`, `mode_changed{shell|tui|repl|unknown}`, `settled`, `child_exited`. Heuristic-fallback sessions surface honestly as `mode: unknown` + coarse `settled` events instead of fabricated 0.95 confidence scores. `terminal_send_result` shrinks to a transport ack plus (when awaited) the terminating event.

**15b. Agent tool surface.** With real exit-code authority, the conclusion of [reconsidering-terminal-exec-vs-terminal-send.md](./reconsidering-terminal-exec-vs-terminal-send.md) inverts — its blocker ("no real exit-code authority") is gone:
- **`terminal.run`** — shell-mode command execution: dispatch, await `command_finished`, return `{exit_code, duration, output}`. The deterministic, zero-polling path for the large majority of agent actions.
- **`terminal.send`** — raw input/keys for TUIs and REPLs; returns after mode-appropriate settling with a damage-based delta.
- **`terminal.observe`** — unchanged role; screen from the emulator grid.
- Deleted from the model's world: `wait_for` strategy selection, readiness-confidence thresholds, and the prompt guidance explaining them (AGENTS.md §4.3–4.4 and the system prompt shrink accordingly — smaller prompts, fewer misjudged waits).

**15c. Service and DB.**
- Runtime forwards `terminal_event` to SSE; session state machine keys off typed events instead of inferred activity.
- New `terminal_command` table (`command_id` ULID, session/thread/bud FKs + owner stamping per AGENTS.md §4.6, `started_at`, `finished_at`, `exit_code`, byte-offset range into `terminal_session_output`). This gives the agent cheap structured recall ("last command exited 1 in 2.3s") and is the substrate for command-block UX. Command *text* is already in the input log; store offsets, not duplicate text.
- `terminal_session_output` store fixed to serve offset-range reads correctly (subsumes the `tailOutput` mid-chunk bug).

**15d. Web and mobile.**
- Terminal status UI driven by events: running/exit-code chips, mode indicator, honest "waiting on TUI" state — replacing heuristic staleness inference.
- Browser resume switches to the same offset-based protocol (send last applied offset, receive backfill) instead of reset+snapshot.
- Command-block rendering (Warp-style grouping of command + output via `terminal_command` ranges) becomes *possible*; explicitly optional product work, not part of this project.

**15e. Scope decision.** Options: (a) minimal core — events, `terminal.run`, offset-resume, `terminal_command` table; UI adopts events but no new product surface; (b) full command-block product experience in the same project. **Recommendation: (a).** The contract is the long-term-debt lever; command-block UX is a product feature that can land any time after the substrate exists.

---

## 4. What this deletes (the payoff, concretely)

From the hacks inventory in the quality assessment: subprocess-per-operation; pipe-pane + `cat >>` quoting + unbounded `terminal.log`; the 50ms stat-poller; the pipe-toggle output race; the 10ms text→Enter and 30ms post-dispatch sleeps; `send-keys -l --` escaping and the one-key-per-gesture limit; capture-pane whole-screen hashing; the line-diff `delta.rs` heuristics; log-vs-screen dual-source quiescence; user tmux.conf leakage; the shared tmux server namespace; tmux version drift; the tmux install requirement, its doctor check, and its installer remediation flow.

From the contracts (via D15): the readiness-confidence/hints vocabulary and its prompt guidance; `wait_for` strategy selection; the `seq`-plus-offset dual bookkeeping and its reset semantics; the reset+snapshot browser resync; the `keys` compatibility alias; the `TerminalBackend` trait and `tmux.rs` themselves. The `Unknown`-mode heuristics remain, demoted to fallback behind honest `mode: unknown` reporting.

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Holder survival under launchd/systemd is fiddly (process-group kills) | **High — gates the whole design** | Phase-0 spike on both platforms before any other work; fallback is D2(d) control-mode-on-tmux. *Update 2026-08-15: macOS passed 8/8 (see D3a); risk now confined to the pending Linux systemd matrix* |
| Emulator fidelity gaps vs. tmux's battle-tested parser (obscure TUIs) | Medium | Fixture corpus + side-by-side capture diffing during bake; wezterm-term is itself battle-tested |
| Shell-integration shim breaks exotic user shell setups | Medium | Detection + graceful fallback to `Unknown` mode; opt-out env var |
| Version-skew bug between new daemon and old holder | Medium | Dumb-holder principle; versioned additive IPC; skew test in CI (build holder at N-1, daemon at N) |
| Ring replay yields imperfect TUI state after wrap | Low | SIGWINCH repaint nudge; document as known |
| Scope creep toward "we built tmux" | Medium | The holder command set is closed at ~8 ops; anything needing holder intelligence is redesigned daemon-side |
| Cutover blast radius: daemon + wire + service + web + mobile change together (D14/D15) | Medium | Contract-first: write the proto revision before code; land in stages behind the new proto version (daemon+service first, clients follow); pre-release means no live-data migration, and the raw output stream — the riskiest data path — changes addressing only, not shape |

## 6. Suggested phasing

- **Phase 0 (spike, gates everything):** holder detach/survival on macOS launchd + Linux systemd user service, incl. daemon-upgrade simulation. D5 emulator bake-off against capture fixtures. Draft the D15a proto revision in `docs/proto.md` so Phases 1–3 build against a written contract.
- **Phase 1:** `stem` crate — PTY + holder + IPC + ring + reattach + OSC 133 scanner + mode state machine; workspace conversion; unit/skew/fixture tests. Independently testable before the daemon touches it.
- **Phase 2 (the cutover):** daemon terminal runtime rebuilt on `stem` (emulator, event mapping, shell-integration shims, REPL registry); tmux backend, trait, and wait-strategy zoo deleted; new wire contract implemented daemon-side and service-side (runtime, SSE forwarding, `terminal_command` table, offset-resume in the output store); `terminal.run`/`terminal.send`/`terminal.observe` tool surface + prompt updates.
- **Phase 3:** web + mobile adoption — event-driven terminal status, offset-based browser resume; doctor/installer tmux removal; spec/docs sweep.
- **Phase 4 (optional):** `bud term attach`; command-block UX on the `terminal_command` substrate.

## 7. Open questions

1. Ring cap default (8 MiB?) and whether it's per-session config from the service.
2. Does the agent contract expose mode (`shell/tui/repl`) to the model as a hint? (Likely yes — cheap and high-value — but it's an agent-prompt decision.)
3. Holder TTL after child exit with no client attached (proposed 24h) — product call.
4. Crate name. `stem` is proposed; needs a conflict check on crates.io if ever published.
5. D15a proto rev: does the service commit consumed offsets transactionally with `terminal_session_output` writes (exactly-once backfill), or tolerate at-least-once with offset-keyed idempotent inserts? (The store's PK on `(session_id, byte_offset)` suggests the latter is nearly free.)
6. Phase 2 is large — decide whether service-side adoption lands in the same change set as the daemon cutover or trails by one PR behind the drafted proto rev (two-sided lockstep vs. brief contract-only gap).
