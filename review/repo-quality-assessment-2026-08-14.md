# Repo Quality Assessment — 2026-08-14

Scope: full-repo review across the three tiers (`bud/` Rust daemon ~15.5k LOC, `service/` ~45k LOC + ~20k test LOC, `web/` ~15.6k LOC), with a dedicated deep dive on the tmux integration to answer the build-vs-replace question. Four independent review passes; findings verified with file:line citations.

---

## 1. The tmux question: should we build a PTY session manager?

**Short answer: yes, build it — as a second backend behind the existing `TerminalBackend` trait — but decide the restart-persistence question first, because that is the only thing tmux provides that is genuinely hard to replace.**

### 1.1 What the current integration actually is

The daemon does not use tmux control mode or any persistent client. Every operation shells out to the `tmux` binary as a fresh subprocess (`bud/src/terminal/tmux.rs`). Real-time output does not come from tmux at all: `pipe-pane` appends raw bytes to a log file via `cat >>`, and a Tokio task **stat-polls the file every 50ms** (`tmux.rs:263-335`). Screen state comes from repeatedly spawning `tmux capture-pane` and hashing/diffing the rendered text.

A single `terminal_send` with `wait_for:"changed"` spawns: 1 baseline capture + one capture per 100ms poll tick + 1–2 send-keys + 1 display-message subprocess.

### 1.2 The hacks inventory (what tmux "requires" of us)

Grouped by which are wrapper-inflicted vs. tmux-inherent:

**Wrapper-design pain (would also be fixed by tmux control mode):**
- Subprocess-per-operation; no stderr captured on failures — errors are opaque strings (`tmux.rs:94`)
- `pipe-pane` → shell `cat >> file` with hand-rolled single-quote escaping (`tmux.rs:460-483`)
- Disable/re-enable pipe toggle race: output between the two execs is lost from the log but present in capture-pane — the two views diverge (`tmux.rs:120-134`)
- 50ms stat-poll file tail; unbounded log growth (nothing rotates `terminal.log`)
- 10ms sleep between literal-text exec and Enter exec (`TMUX_TEXT_TO_ENTER_DELAY_MS`, `interaction.rs:66-71`) — pure exec-ordering race workaround; a single PTY write is atomic
- 30ms post-dispatch guard before quiescence sampling (`interaction.rs:356-362`) — send/observe race patched with a timer
- Two disagreeing sources of truth: quiescence watches log-byte growth, readiness/delta watch capture-pane text; spinners defeat one, silent cursor updates defeat the other. Constants (`150ms quiet`, `3 stable samples`, `300ms settled`) exist to paper over this.

**tmux-inherent pain (only a real PTY+emulator fixes):**
- `send-keys` escaping saga — the `-l --` fix shipped after markdown bullets (`- npm run dev`) parsed as tmux flags (`plan/fix-send-keys-parse/`)
- tmux key-name vocabulary leaks through the API; one key per gesture only, no chords (`interaction.rs:611-716`)
- capture-pane is lossy rendered text: no damage tracking, no alternate-screen flag, no cursor position — so `delta.rs` reimplements diffing by line-prefix/suffix heuristics, and readiness scrapes text
- User's `~/.tmux.conf` applies to Bud sessions (no `-f /dev/null` / private socket) — documented source of the Codex-in-tmux behavior divergence (`debug/codex-startup-latency-in-tmux-vs-local.md`); sessions also share the user's tmux server namespace
- No version gating: `probe_tmux` only checks `tmux -V` exits 0, but `new-session -e` needs ≥3.2 and `resize-window` ≥2.9 — older distro tmux fails at runtime with opaque errors
- `set-option history-limit` after session creation is likely a no-op for the already-created pane (`registry.rs:275`)

**Backend-independent (replacing tmux does NOT fix these):**
- The readiness heuristics are the worst code in the daemon and sit above the backend trait: prompt detection by last-line suffix (any line ending in `%` — e.g. `100%` — classifies as a shell prompt at 0.95 confidence), `looks_like_error` is literally `output.contains("error")`, progress detection is substring matching on "eta"/"%" (`readiness.rs:689-844`). Four overlapping wait strategies coexist (acknowledged debt in `src.spec.md:510`).

### 1.3 The crux: persistence across daemon restart

The daemon demonstrably relies on the tmux server outliving the daemon process:
- On disconnect, handles are dropped but sessions are never killed (`terminal/mod.rs:183-190`); next `terminal_ensure` reattaches by name (`registry.rs:254-282`).
- The service persists per-thread session IDs in Postgres and reuses them (`service/src/runtime/terminal/session-store.ts`), so reattach fires after daemon **restarts** — and the deployment model is a launchd/systemd service with installer-driven upgrades. Today, a daemon upgrade does not kill user shells.
- Human co-attach via `tmux attach` appears in no wire contract or design doc — it's an undocumented (but real) operator escape hatch.
- The reconciliation journal is vestigial: `save_journal` has no production callers, so `reconnect_report` is always empty. tmux + the service's DB are doing all the real persistence.

### 1.4 Replacement spec and effort

Everything above the 13-method `TerminalBackend` trait (`backend.rs`) — readiness, delta, observe, interaction, registry — was explicitly refactored to be backend-neutral ("future PTY or mosh-like backends", `bud.spec.md` §Why tmux?), and `FakeBackend` already tests that layer. A `PtyBackend` slots in with zero service/protocol changes.

| Component | Replaces | Effort |
|---|---|---|
| PTY spawn (`portable-pty`) | new/kill-session, pane_pid | Trivial |
| Async read loop on PTY master → chunk/seq directly | pipe-pane + log file + 50ms poller | Easy, strictly better (event-driven; quiescence = ms since last read) |
| Write bytes + key→escape-sequence table | send-keys paths, `-l --`, both sleep guards | Easy (~one screen of table); enables arbitrary chords |
| `TIOCSWINSZ` | resize-window | Trivial |
| VT emulator crate (`wezterm-term` / `alacritty_terminal` / `vt100`) | capture-pane + screen hashing + line-diff delta | Medium; adds damage tracking, alt-screen flag, cursor position — better readiness inputs for free |
| Scrollback ring buffer | history-limit + `capture-pane -S` | Easy (emulator-native) |
| cwd via `/proc/<pid>/cwd` / libproc | `#{pane_current_path}` | Small, platform-specific |
| **Persistence across daemon restart** | the tmux server process | **Hard — the only hard part** |

Persistence options: (a) a small detached session-holder process holding PTY + emulator state with local IPC — i.e., a minimal tmux server, weeks of work plus its own upgrade choreography; (b) accept the regression — sessions survive network disconnects (free, in-process) but die on daemon restart/upgrade; (c) keep tmux purely as a dumb persistence shell.

### 1.5 Recommendation

Three-way framing: **(a) status quo shell-out — worst of both worlds; (b) tmux control-mode rewrite — keeps persistence and attach, fixes the I/O architecture (event-driven `%output`, one persistent process), medium effort; (c) custom PTY manager — best I/O and screen model, must solve restart persistence.**

Recommended path: **build the `PtyBackend` (option c)**, because:
1. The seam exists, is tested, and was built for exactly this.
2. It removes the daemon's only external runtime dependency — an entire doctor check, installer preflight, and per-distro remediation flow exist just for tmux.
3. It eliminates the whole class of send/capture races, escaping bugs, config leakage, and version drift that keep generating debug notes.
4. A real VT emulator gives readiness detection the signals it's currently starving for (cursor position, alt-screen state) — that's the path to fixing the actual hardest product problem.

But make the persistence decision explicitly before starting. Pragmatic sequencing: ship `PtyBackend` accepting the die-on-restart regression initially (sessions still survive network disconnects, which is the property `bud.spec.md` actually names), keep `TmuxBackend` as a config-selectable fallback during rollout, and treat a session-holder process as a follow-up only if upgrade-survival proves user-visible enough to justify it. If restart-survival is judged non-negotiable now, do the control-mode rewrite instead — it buys ~70% of the wins at lower risk.

Independent of the backend choice: the readiness/quiescence layer needs its own consolidation effort (four wait strategies → one), and that work is worth more to product quality than the backend swap.

---

## 2. Cross-cutting theme

**The protocol contracts exist on paper but are not enforced end-to-end.** The wire protocol defines monotonic `seq`/byte offsets and resumable streams; AGENTS.md defines ownership re-resolution for every client-supplied id. In practice:
- The service routes daemon-supplied `session_id`s with no bud-ownership check (S-C1).
- The browser ignores the byte-offset resume protocol entirely and does destructive reset+snapshot (W-H1), while the service's own resume path drops bytes mid-chunk (S-H3).
- The daemon's reconnect-reconciliation journal is never written, so its reports are always empty (D-M2).
- Seq resets on reattach and 16KB chunks that split UTF-8 code points are silently tolerated or mishandled downstream.

The individual tiers are well-built; the seams between them are where the defects live — and those seams are exactly the untested code (daemon `app.rs` dispatch state machine, web stream hooks, gRPC gateways).

---

## 3. Findings by tier (top items)

### Service (most severe issues in the repo)

| ID | Sev | Finding |
|---|---|---|
| S-C1 | Critical | Terminal result frames routed by daemon-supplied `session_id` with no bud-ownership check — an authenticated bud can inject output into another user's terminal and resolve another bud's pending waits (`ws/bud-connection.ts:262-368`, gRPC mirrors). Fix: assert `session.budId === state.budId`. |
| S-C2 | Critical | Proxy/file/LLM/resolve result handlers run for **unauthenticated** sockets (no `connected` guard, unlike the terminal handlers) and look up global maps keyed only on daemon-supplied ids — pre-`hello` sockets can spoof responses into browsers (`bud-connection.ts:218-241`). |
| S-H1 | High | Nothing prevents concurrent agent turns on one thread — second `POST /messages` overwrites runtime state and orphans the first turn's cancel controller. `isThreadActive` exists but isn't called (`routes/threads/messages.ts:308`). |
| S-H2 | High | gRPC data-plane attach authenticated only by knowledge of plaintext ids (`createInsecure`, optional strongest field) (`grpc/data-gateway.ts:160-174`). |
| S-H3 | High | `tailOutput` drops bytes when `since_offset` falls inside a stored chunk; trimming branch is unreachable dead code; `limit(200)` truncates silently (`runtime/terminal/output-store.ts:54-100`). |
| S-H4 | High | `message` table lacks `(thread_id, created_at, message_id)` index — every page fetch and every agent-turn conversation load sorts the thread in memory. |
| S-M | Medium | Proxy viewer sessions survive logout for up to 7 days; no WS `maxPayload` or pre-`hello` timeout (unauth DoS); duplicate output chunks double-count stats; stuck push-outbox rows never recovered; bud-disconnect leaks proxy-WS sessions (`closeProxyWebSocketRuntimeSessionsForBud` is dead code). |
| S-note | — | `AGENT_MAX_STEPS` real default is **1000**, not the 30 the spec claims (`config.ts:298`) — a looping model gets 1000 tool calls/turn. |

Verified clean: route-level ownership/404 semantics, SSE pre-attach authorization, owner stamping, SQL hygiene, migration/schema parity, agent cancellation and compaction handling.

### Daemon (Rust)

| ID | Sev | Finding |
|---|---|---|
| D-H1 | High | Frame dispatch fully serialized: one `terminal_send` (up to 30s, server-controlled, uncapped) blocks heartbeats (→ service marks bud offline), `stream_credit` processing, and **every other thread's terminal** — contradicts the parallel-workstreams premise (`app.rs:938-949`, `1041-1061`). Proxy/file opens are correctly spawned; terminal handlers are not. |
| D-H2 | High | File-read workspace defaults to `$HOME` — path-escape validation is solid, but the root itself exposes `~/.bud/identity.json` (device secret), `~/.ssh`, `~/.aws` to anything that can drive the service (`config.rs:126-132`, `files/mod.rs`). No sensitive-path denylist, not even for the daemon's own base dir. |
| D-M1 | Medium | `ProtoReader` length arithmetic overflows on malformed input → slice panic → whole-daemon crash from one bad frame (`proto_wire.rs:2182-2194`). Use `checked_add`. |
| D-M2 | Medium | Journal never written; `reconnect_report` always empty; in-flight runs/streams silently lost on disconnect. |
| D-M | Medium | One malformed frame tears down the whole session (reconnect storm with fixed 5s no-backoff retry); server-controlled `max_bytes` for file reads uncapped with full buffering; gRPC data channel can spuriously kill streams or reorder `terminal_output` via control-channel fallback; identity file chmod'd after create (fd race). |

Good shape: HMAC challenge-response auth, transport-disconnect cleanup, proxy loopback/header/cookie policy, credit-based flow control, `local_llm` hardening. Test coverage is good for extracted policy logic, absent exactly where the risk is (`app.rs` state machine, gRPC gateways, claim/identity).

### Web

| ID | Sev | Finding |
|---|---|---|
| W-H1 | High | Terminal resync ignores `last_event_id`/byte offsets — reconnect does `term.reset()` + 128KB snapshot, and output listeners attach before `open`, so bytes arriving between snapshot build and reset are silently lost. No seq-gap detection on live chunks (`use-terminal-session.ts:459-512`, `727-742`, `840-869`). |
| W-M1 | Medium | Staleness threshold (5000ms) equals the prod heartbeat interval exactly — any jitter triggers a full spurious reconnect with overlay (`thread-stream-timing.ts:3`). Needs ≥2× heartbeat. |
| W-M2 | Medium | Fresh `TextDecoder` per SSE chunk without `{stream:true}` — 16KB chunk boundaries split UTF-8 code points into U+FFFD (`lib/terminal-data.ts:9-10`). |
| W-M3 | Medium | Bootstrap merge can leave a permanent, unfetchable gap if >100 messages landed while disconnected; typed terminal input silently dropped during reconnect windows; per-delta double full-transcript sort at token rates. |
| W-L | Low | Heartbeat-watchdog interval leaks (terminal `open` handler stacks watchdogs on native EventSource reconnect); `new.tsx` placeholder xterm leaks into detached DOM and could just be deleted; iframe sandbox `allow-same-origin`+`allow-scripts` nullifies itself if a grant URL is ever same-origin. |

Verified clean: no `dangerouslySetInnerHTML`/HTML injection surface anywhere; markdown via `skipHtml` + protocol filtering; cookie auth, no tokens in web storage; no global mutable stream state; disciplined xterm lifecycle in the main hook. Tests cover extracted pure helpers only — zero coverage of the stream hooks where all the above bugs live.

---

## 4. Overall implementation quality

**Verdict: a genuinely well-engineered prototype-to-product codebase with a strong architecture culture, whose remaining defects are concentrated at trust boundaries and reconnect seams rather than in day-to-day logic.**

Strengths worth naming:
- The spec-documentation system is real and mostly accurate (drift found was minor: stale token default, overstated journal claims, `AGENT_MAX_STEPS` 30-vs-1000).
- The daemon's backend-neutral terminal refactor was done properly and ahead of need — it's why the tmux replacement is a contained project instead of a rewrite.
- Authorization at the browser-facing route layer follows the AGENTS.md contracts faithfully (SQL-level owner filtering, 404 semantics, pre-attach SSE auth). The violations found are on the **daemon-facing** side, which the contracts also cover but reviews evidently haven't.
- Pure-helper extraction for testability (web recovery classifiers, daemon policy modules, service transcript logic) is consistent and pays off.
- Security posture on the hairy adapters (proxy loopback policy, local-LLM hardening, cookie/header allowlists) is deliberate and tested.

Weaknesses, in priority order:
1. **Daemon-facing trust boundary** (S-C1, S-C2, S-H2, D-H2) — the "never trust raw ids" rule is enforced for browsers but not for buds. Ship-blocking for any multi-user deployment.
2. **Reconnect/resume story is fictional end-to-end** — every tier independently fails to honor it (W-H1, S-H3, D-M2, seq resets). Users see this as lost terminal output and duplicated/missing chat after network blips.
3. **Serialized daemon dispatch** (D-H1) — undermines the product's core parallel-threads premise and causes false offline states.
4. **Readiness heuristics** — the hardest product-quality problem; backend-independent; needs consolidation regardless of the tmux decision.
5. **Integration-layer test coverage** — the untested 20% (dispatch state machines, stream hooks, gateways) contains ~80% of the findings.

### Suggested sequencing

1. **Now (days):** S-C1, S-C2 guards; `isThreadActive` check (S-H1); `checked_add` in ProtoReader (D-M1); message index (S-H4); web stale-threshold constant (W-M1); streaming TextDecoder (W-M2); carve `~/.bud` + credential dirs out of file scope (D-H2).
2. **Next (1–2 weeks):** spawn terminal handlers off the daemon dispatch loop (D-H1); fix `tailOutput` chunk-boundary resume (S-H3) and make the web actually use `last_event_id` (W-H1) — do these together, they're one feature; WS `maxPayload` + handshake timeout.
3. **Then (the project):** `PtyBackend` behind the existing trait per §1.5, with the persistence decision made up front; readiness consolidation as its own track.
