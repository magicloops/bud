# Review: `feat/bud-owned-browser` merge readiness

Reviewed 2026-09-21 against `main` (merge base `90248c4`, branch head `df6268c`).
Static read of the branch plus local test/lint/typecheck runs on macOS. No
hosted deployment, iOS build, Ubuntu host, or real-agent browsing session was
exercised. Mobile repo was not reviewed.

## Verdict

**Not ready to merge as-is, but close.** The feature is a coherent, well-specified
vertical slice (daemon browser manager, service resource/control/media layer,
agent tools, web viewer) with substantial test coverage and ownership-aware
routes. Two service tests fail on the branch, both stale fixtures rather than
product bugs, and several cleanup items from the plan's own Phase 4 list are
still open. The blockers below are each small; the larger "remaining items" are
acceptance and packaging work that the plan already defers past merge.

Three confirmed defects sit between "blocker" and "follow-up" and need an
explicit call: daemon H1 (corrupt recovery hints make Close impossible), daemon
H2 (a stale Chrome `SingletonLock` blocks Reset, the documented recovery
action), and service M1 (hydrated screenshots bypass context accounting). None
affects ownership or data integrity, and all three are bounded to the browser
feature, so merging with them tracked is defensible. Fixing H1 and H2 before
merge is recommended because they turn a routine crash into a manual
file-system repair on the Bud host.

## Branch shape

| Item | Value |
| --- | --- |
| Commits ahead of `main` | 10 (2026-09-15 → 2026-09-21) |
| Files changed | 306 |
| Raw diff | +127,902 / -786 |
| Code-only (excl. tests, docs, specs, config, lockfiles, generated, `spikes/`) | +11,367 / -545 (net +10,822) across 102 files |
| Test code | +5,407 / -192 across 47 files |
| Drizzle meta snapshots (generated) | ~95,600 lines across 0039–0046 |
| `spikes/bud-browser` prototype | ~1,300 non-test lines plus a 1,224-line `Cargo.lock` |
| Plan/debug/design/reference/review docs | ~9,700 lines |

Largest new modules: `bud/src/browser/manager.rs` (2,385 lines),
`bud/src/browser/adapter.rs` (1,540), `web/src/features/browser/viewer.tsx`
(860), `service/src/browser/control.ts` (548), `service/src/browser/media.ts` (409).

## Verification performed

| Check | Result |
| --- | --- |
| `cargo test` (bud) | 147 lib + 32 integration pass; **6 browser tests ignored** (need `BUD_BROWSER_EXECUTABLE` and installed helper); 8 more manager tests silently `return` early without it |
| `cargo clippy --all-targets` (bud) | 8 warnings, all in `browser/manager.rs` and `browser/media.rs` (unnecessary `u64` casts ×6, 10-arg function, collapsible `if`, `match` → `if let`) |
| `cargo fmt --check` | clean |
| `pnpm test` (service) | **721 pass, 2 fail, 30 skipped** at review time (see blockers; both fixed the same day, suite green afterwards). The 30 skips are Postgres-backed tests gated on `BUD_DATA_DB_TEST=1`; with the flag set, `browser/resource-repository.test.ts` also failed at HEAD (`column "accent_color" does not exist`: its stub `bud` table predates Phase 3n colour sync). Fixed during Phase 3q. Two further DB-gated failures are outside this branch: `personal-data/automation-delete.test.ts` fails identically at HEAD and on untouched files, and `personal-data/contact-processor.test.ts` passes alone but failed once in the full run (order-dependent) |
| `pnpm exec tsc --noEmit` (service) | clean |
| `pnpm lint` (service) | 7 errors / 200 warnings, all in files **untouched** by this branch (`personal-data/*`) |
| `pnpm test` + `pnpm test:render` (web) | 225 + 36 pass |
| `pnpm exec tsc -b --noEmit` (web) | clean |
| `pnpm lint` (web) | 9 errors in untouched files; 1 new warning from this branch (`routes/$budId/$threadId.tsx:582` missing `browserPane` dep) |
| CI | No workflow runs tests (`.github/workflows` has release/promotion only), so failing tests do not block a merge mechanically |

## Merge blockers

Blockers 1–4 were resolved on 2026-09-21 after this review was written; they
are kept below for the record. Blocker 5 (PR description) is refreshed as the
branch changes.

1. ~~**Stale regression test: `service/src/agent/context-tool-catalog.test.ts`.**~~
   **Resolved:** fixture now advertises `profile_mode: "persistent"`; test passes.
   Original finding: **Stale regression test.**
   The fixture advertises `profile_mode: "ephemeral"` but
   `service/src/browser/transport.ts:19` now requires `z.literal("persistent")`
   (Phase 3k), so `browser_open` never enters the catalog and the assertion at
   line 33 fails. This is the very regression test added in `cec9e1b` to guard
   the browser-catalog bug described in
   [agent-tools-and-context-building.md](./agent-tools-and-context-building.md);
   as written it no longer proves anything. Fix: update the fixture (and consider
   asserting on the exported capability schema instead of a literal).
2. ~~**Stale wire test: `service/src/ws/bud-connection.test.ts:208`.**~~
   **Resolved:** test now uses field 192 like `wire.test.ts`; passes.
   Original finding: uses
   protobuf field 190 as "unknown payload", but `proto/bud/v1/bud.proto` now
   assigns 190/191 to `browser_command`/`browser_result`. `wire.test.ts` was
   bumped to 192; this file was not. Expected `UNSUPPORTED_PAYLOAD`, gets
   `PROTO_VERSION_MISMATCH`. Passes on `main`.
3. ~~**Committed prototype `spikes/bud-browser/`**~~ **Resolved:** the spike and
   the env-gated "real browser host" test in `browser-tools.test.ts` that
   spawned its binary are removed; `spikes/spikes.spec.md` and
   `phase-0-findings.md` point at git history. Original finding: (~3,460 lines incl. a Rust
   crate with its own `Cargo.lock`, `target/` present locally). Phase 4 in
   `plan/bud-owned-browser/phases.md` explicitly lists "remove spike code";
   `spikes/spikes.spec.md` exists but the plan's Phase 0 is closed and nothing
   in `bud/` or `service/` references it. Delete or move to a retired note.
4. ~~**Migration chain 0039–0046 should be collapsed before deploy.**~~
   **Resolved 2026-09-21 (Phase 3q).** Production was confirmed at 0038, the
   eight migrations were replaced by `0039_bud_browser.sql` (generated) and
   `0040_browser_claim_retirement.sql` (custom trigger), and the three tests
   that load migration SQL were repointed. See
   [phase-3q-migration-squash.md](../plan/bud-owned-browser/phase-3q-migration-squash.md).
   The original finding: eight sequential migrations created `browser_session`
   with `profile_mode='ephemeral'`, added control columns, then 0046 dropped
   five of them, rewrote CHECKs, and added a hand-written trigger.
5. **PR description prerequisites (AGENTS.md §3.8/§4.7):** code-only line
   counts (above), migration filenames, required daemon/mobile versions and
   deploy order, and the new env vars a deployed daemon needs
   (`BUD_BROWSER_EXECUTABLE`, `BUD_BROWSER_HELPER`, `BUD_BROWSER_NODE`,
   `BUD_BROWSER_HEADED`).

## Findings by tier

### Daemon (`bud/src/browser`, `bud/browser-helper`)

Overall solid: lock ordering is consistent across execute/lifecycle/shutdown/
media, untrusted wire input goes through `deny_unknown_fields` plus action
validation, all buffers and channels are bounded, and shutdown drains the page
lock, saves recovery hints, and escalates Chrome close to SIGKILL. Findings:

**Correctness (ranked)**

- **H1 CONFIRMED — corrupt recovery hints make workspace Close impossible.**
  `adapter.rs:1374` calls `recovery.save(workspace, None)?` before closing any
  tab. If `bud-pages.json` failed validation at load, `recovery.rs:44-48` sets
  `writable=false` for the process lifetime and `save` bails
  `browser_recovery_unavailable`, which is in the manager's `REJECTED` list
  (`manager.rs:840-843`), so `closed_at` is never set. Hint removal on close
  should be best-effort (warn), or gated on `available()`.
- **H2 CONFIRMED — stale `SingletonLock` disables the browser, including Reset.**
  `profile.rs:61-63` refuses to acquire the profile whenever `SingletonLock`
  exists ("never remove ... even if stale", by design). Chrome only removes it on
  clean exit; `Browser::close` escalates to SIGKILL (`adapter.rs:1362`) and a
  daemon crash leaves it too. `lifecycle(reset)` goes through `Profile::acquire`
  (`manager.rs:902-910`), so the documented recovery action is blocked by exactly
  the condition it should recover from. Chrome itself validates the
  `hostname-pid` symlink target; the daemon could do the same after confirmed
  child exit. Until then, recovery is a manual file deletion on the host.
- **M1 CONFIRMED — CDP session caches never evict.** `adapter.rs:583-587` and
  `:849-853` cap `sessions`/screenshot sessions at 32 but only clear on channel
  repair; closed targets are never pruned and `Target.detachFromTarget` is never
  sent. A long-lived persistent workspace that cycles through more than 32
  targets gets `browser_target_limit` on every call until a channel repair.
- **M2 PLAUSIBLE — private typing fails on `type=email|number|date` inputs.**
  `adapter.rs:759` and `:1177` bail on `selectionStart === null`, which Chrome
  returns for those input types. Login forms commonly use `type=email`.
- **L1** macOS headed inventory (`adapter.rs:383-438`) issues window-bounds
  calls and polls inside `targets()`, which every read path calls, so one
  `browser_window_unconfirmed` fails all operations until the target is cached.
- **L2** `disconnect()` reaches the shared authority through `entries`
  (`manager.rs:310-315`); with zero live entries a disconnect during
  `HumanPrivate` does not pause (15 s lease expiry covers it).
- **L3** Close does not pause authority (`manager.rs:1022-1040`), contrary to
  `browser.spec.md` ("admitted close pauses authority before closing Chrome").

**Lifecycle / resources**

- The root `Browser` spawns a Node/Playwright helper (`adapter.rs:270`) that is
  never used for observation, plus the startup probe spawns another: one idle
  Node process (128 MiB heap cap) per daemon.
- `recovery.rs:98-102` does two synchronous `sync_all` calls (file + dir) from
  `save_pages`, which runs after most successful agent operations; `profile.rs`
  does sync FS I/O under `perform`. Neither is offloaded to `spawn_blocking`.
- `slot.media` busy flag is only reset when the media task ends normally
  (`media.rs:290`); a panic in that task leaves the slot `browser_media_busy`.
- Media 10 s demand timeout also applies in operation-driven mode
  (`media.rs:82`); the service must keep pinging under 10 s. Not stated in proto docs.

**Platform**

- Linux is disabled outright: `profile.rs:222-227` bails
  `browser_secure_storage_unsupported` and `configured_for` nulls the executable.
  `bud doctor` uses `configured()` without the keychain check (`doctor.rs:129`)
  so doctor can say OK where the daemon reports unavailable. `doctor.rs:128`
  still prints "ephemeral profile mode".
- `adapter.rs:183-184` `env_clear()` drops `DISPLAY`/`DBUS_*`/`XDG_RUNTIME_DIR`;
  headed Linux under Xvfb (Phase 3o) will need explicit passthrough.
- `profile.rs`/`recovery.rs` use `libc::flock`/`O_NOFOLLOW` unconditionally; the
  crate no longer builds on Windows.

**Tests**

- Pure unit tests without Chrome: `control.rs` ×4, `recovery.rs` ×3,
  `profile.rs` ×5, `media.rs` ×1, `manager.rs` ×2, helper `compact` ×5.
- Live-Chrome tests (`manager.rs` ×6, `viewer_tests.rs` ×3, helper `engine` ×6)
  use `let Some(..) else { return }` and **pass vacuously** when
  `BUD_BROWSER_EXECUTABLE` is unset; they should be `#[ignore]` so a green run
  is honest.
- Untested: `cdp.rs` timeout/poison/close paths, `semantic.rs` helper
  timeout/kill/output limits, `capture.rs`, `app.rs` `browser_command` dispatch,
  and the H1/H2/M1 scenarios.

**Debt / size**

- `manager.rs` is 2,385 lines of which ~1,064 are tests; `execute()` alone is
  ~555 lines (`319-873`) with authority checks duplicated pre/post lock
  (`581-612` vs `677-707`). `Browser` struct init duplicated (`adapter.rs:293-320`
  vs `1416-1435`); `Profile::acquire(...)` appears three times in manager;
  attach logic duplicated between `session()` and `screenshot()`.
- Legacy `Observation`/`Element` adapter (`adapter.rs:663-724`) is kept for
  old-service compatibility, against the AGENTS.md "no legacy paths" default.
  Needs an explicit keep/remove decision.
- `#[allow]` ×1, `unsafe` ×2 (flock, Security.framework), TODO ×0.

**Spec drift**

- `browser.spec.md` says compact observations have an "8 KiB complete helper
  budget"; code and `browser-helper.spec.md` say 32 KiB (`compact.mjs:2`).
- `browser.spec.md` "admitted close pauses authority" is not implemented (L3).
- `src.spec.md` contradicts itself on whether `main.rs` cancels browser cleanup
  on SIGINT/SIGTERM. `bud.spec.md` says profile persistence "remains a later
  phase" directly above the paragraph saying 3k implemented it.

**Spike dependency (resolved).** `spikes/bud-browser` was not dead at review
time: `browser-tools.test.ts` imported its `relay.mjs` and spawned its prebuilt
binary (env-gated). Both the spike and that test have since been removed.

### Service (`service/src/browser`, `service/src/agent`, DB)

**Authorization / ownership: CONFIRMED sound.** Every browser route in
`service/src/browser/routes.ts` resolves the viewer through `requireViewer`
plus a live-session check, then reaches data only via owner-scoped SQL
(`getAuthorizedBud` for `/api/buds/:bud_id/browser*`, `getAuthorizedThread` for
`/api/threads/:id/browser-*`, and `repository.get(owner, id)` joined to
thread+bud for `/api/browser/sessions/:id*`). Foreign resources map to 404
through `BrowserError` (`routes.ts:171-187`). The viewer media WebSocket
authorizes in `preValidation` before upgrade (`routes.ts:315-322`), re-checks
after the first message, and re-checks on every idle sweep. The daemon media
socket uses one-use 32-byte tickets bound to group and carrier
(`media.ts:284-290`). Agent captures re-verify owner/thread/bud/invocation/
epoch before and after body validation (`agent-capture.ts:24,31`). Row
stamping (`created_by_user_id`, `tenant_id` from the thread,
`requested_by_user_id`, `returned_by_user_id`) is present on `browser_resource`,
`browser_session`, and `browser_handoff`. Lock order
bud → resource → thread → invocation → session/handoff is consistent across
`prepare`, `requestAgent`, `withLocked`, `acknowledgeReturn`,
`acknowledgeLifecycle`, `claim`, and cancel; no cycle found.

Two small deviations: `control.renew()` checks the in-memory controller
before `repository.get` (`control.ts:444`), so a foreign session id yields
`409 browser_control_expired` rather than 404 (no existence disclosure, but
inconsistent with `resizeViewport`). Bearer/mobile viewers get 401 on every
browser route because `alive()` requires a cookie session (`routes.ts:94-95`);
documented as Phase 3b work. `plan/init-auth/validation-checklist.md` gained
~12 browser sections, but every "real two-account cookie/Origin" item is still
unchecked.

**Correctness (ranked)**

- **M1 CONFIRMED — screenshot tokens are invisible to compaction.**
  `hydrateBrowserImages` runs in `model-runner.ts:357` after the budget
  decision, and `context-accounting.ts:56-57` abandons the provider usage
  anchor whenever an `image_artifact` reference is present, falling back to the
  heuristic that only counts the small JSON reference. Up to eight images
  (`image-artifacts.ts:61`) reach a vision provider with zero tokens counted.
  Not an overflow by itself at typical per-image token costs, but the context
  meter and compaction trigger are wrong whenever screenshots are in play.
- **M2 PLAUSIBLE — heartbeat vs raw-pg park window.** `repository.ts:158-164`
  commits `fence+1, worker_id=null` and throws `BrowserToolWait`;
  `browserWaitParked()` marks the worker ended only after the throw propagates.
  A 15 s heartbeat firing in that window fails `lockedLease` and aborts the
  controller (`invocation-worker.ts:73-76`). Other park paths renew and mark
  ended before the DB write.
- **L1** `repository.ts:122-124` commits, throws
  `browser_interrupted_reopen_required`, then the catch issues `rollback`
  (`:216-217`), and the action receipt is stamped `browser_dispatched:true`
  although nothing was dispatched.
- **L2** Per-frame DB re-auth: `media.ts:391` awaits `checkViewer` (two DB
  round-trips) per viewer per frame while `group.processing` blocks further
  frames. Roughly 60 queries/s per group at 10 fps with three viewers.
- **L3** Image artifact cap is global (128 per service, `image-artifacts.ts:35`)
  not per owner, and the directory defaults to CWD-relative, which is
  ephemeral on Render. One thread can starve every other user's screenshots.
- **L4** `routes.ts:327` uses `once("message")`; anything the viewer sends
  between its first message and `attachViewer` registering its listener is
  dropped silently.
- **L5** All control authority is process-local (`pending`, `controllers`,
  `tickets` maps). Render's overlapping deploy runs two instances briefly;
  boot `recover()` pauses any live private controller. Documented, but a real
  operational constraint.
- **L6** The route error handler maps every non-Browser/non-Zod error,
  including DB failures, to `409 browser_unavailable` (`routes.ts:171-187`),
  hiding genuine 500s.

**Schema / migrations.** All eight migrations together cover every
`schema.ts` change (`browser_session` 0039/0040/0044/0046, `browser_handoff`
0040/0042, `browser_resource` 0044/0045, `agent_invocation` timing 0043);
journal entries are monotonic and tags match. 0046 is destructive (closes
unlinked sessions, drops five columns and two checks) and adds a plpgsql
trigger on `bud` (`retire_bud_browser_claim`) that Drizzle cannot express, so
`db:push` will neither create nor drop it; `db.spec.md` documents this. No FK
from `browser_resource.created_by_user_id` / `requested_by_user_id` /
`browser_handoff.returned_by_user_id` to `auth_user`, unlike sibling columns
such as `run.canceled_by_user_id`.

**Protocol.** `docs/proto.md` documents envelope tags 190/191, every
`browser_command` variant, capability flags, media messages, and the HTTP
additions; code in `transport.ts`, `media.ts`, and `routes.ts` matches. Wire
fields are snake_case. Drift: proto.md:2803 still says `browser_request_handoff`
"is not advertised" (it is, when `browserHandoff` is true); relay demand is
documented as `{target_id?}` but sent as `target_id: null` (`media.ts:181`);
the compact envelope guard is 12 KiB in proto.md:3236 and `browser.spec.md:271`
but 36 KiB in code (`browser-tool-executor.ts:113`) and `agent.spec.md`.

**Tests.** Strong at the unit/integration level: `transport`, `control`
(20 cases), `media`/`media-idle` (loopback sockets), `repository`,
`resource-repository`, `continuation` (isolated Postgres), `recovery-ticket`,
`color`, `image-artifacts`, `agent-capture`, `broker`, plus agent-side
`browser-tools`, `browser-ownership`, `browser-observation-budget`,
`browser-reference-input`, `invocation-timing`, `context-accounting`. Gaps: no
HTTP-level tests for `routes.ts` (401/Origin/404-foreign/400 body limits/error
mapping), the image GET route, `lifecycle.reconcile`, or `hydrateBrowserImages`
through `model-runner`.

**Debt.** No `any`, `eslint-disable`, `@ts-ignore`, or TODO markers in the new
code. But: 35 lines over 200 chars and stretches of unformatted code
(`if(!handoff)return null;` style in `invocation-repository.ts`,
`routes.ts:220,233,288`); `service/` has no Prettier config. Unused
`BrowserHandoffContext.llmCallId/startedAt/remainingCalls`
(`browser-tool-executor.ts:26-28`); duplicate `Session` vs `BrowserSession` row
types (`repository.ts:19-34` vs `control-repository.ts:10-29`); `BrowserCommand`
carries both `control_epoch` and `browser_epoch` (`transport.ts:52-56`). Legacy
(non-compact) observe results have no truncation short of the 128 KiB transport
limit and can land in the transcript at that size.

**Spec drift.** `routes.spec.md` has no entries for the new
`/api/buds/:bud_id/browser*`, `/api/browser/*`, or `/api/threads/:id/browser-*`
routes (only `threads.spec.md` was updated). `agent.spec.md` says "provider
image serialization remains deferred" then documents hydration. `browser.spec.md`
"Private viewer contract" lists five control operations; later sections add
four more. `db.spec.md` and `migrations.spec.md` match code.

### Web (`web/src/features/browser`, routes)

No confirmed crash or leak. Effect cleanups are sound (media client nulled
before `close()`, wheel listener removed, poll/renew/retry timers cleared,
unmount release skips setState). `media.ts` is a WebSocket + canvas class; no
WebRTC exists (Phase 5 deferred). Frames never enter React state and the canvas
lives in a per-mount ref, satisfying "no global mutable state for streams".

**Correctness (ranked)**

- **M1 PLAUSIBLE — `resizeBlocked` can stick and silently swallow input.**
  Set at `viewer.tsx:420` when a fit starts; cleared only on a matching frame,
  passive path, passive failure, media `empty`, or the "Reconnect view" button.
  If a resize is aborted by a media drop and the user re-takes control with Fit
  off or `can_resize_viewport` false, no fitter runs, `send()` returns early at
  `:484` with no error, and the chat Return action no-ops (`:343`). The textarea
  `disabled` state does not reflect it, so the UI looks live.
- **L1** `control` closes over `session` and the first poll can invoke a
  pre-session closure via `latestControl.current` (`:162`), delaying recovery by
  one 3 s tick.
- **Dead code**: `takeoverPending` auto-acquire (`:322-325`) is unreachable
  because service `acquire` either transitions to `human_private` or throws;
  `pausedSessionId` (`pane.tsx:19,57`) is computed and never consumed.
- Input forwarding is intentionally narrow: `click`, `scroll`, `back`, `text`,
  and eight keys (`:682-692`). No drag, right/double click, hover, arrow
  up/down, Escape, modifiers, or touch. `design/browser-keyboard-files-and-
  clipboard.md` scopes the follow-up.
- Private handoff races are well fenced (`changingControl`, version-checked
  poll loss, release-on-late-ack after unmount, compound return releases on
  failure).

**Auth / exposure (client).** `browser.$sessionId.tsx` mounts the viewer only
with a current user, otherwise renders bare "Sign in to open this browser."
text with no redirect (other routes use a loader redirect). Foreign/missing
sessions get "Browser session unavailable". Media WebSocket uses cookie auth;
the only query value is a per-mount random `viewer_id`; recovery tickets travel
in POST bodies only; dev-only `console.info` logs no URLs or tickets.

**`web/src/lib` removals.** `computeAgentWorkDurationMs` and its tests were
removed; the sole consumer now uses service-supplied `turn_timings`. No dangling
imports. This work-duration/context-meter change is unrelated to the browser
and rides along in the branch.

**Size.** `viewer.tsx` is one 860-line component with ~35 state/ref hooks,
11 effects, a 145-line `control` callback handling nine operations, and two
full layouts in a 285-line JSX body. It violates "small components" and should
be split (control state machine, media/fit hooks, ended screen, menu panel).

**Accessibility.** Keyboard-only users cannot interact: the canvas has no
`tabIndex` and the textarea is `tabIndex={-1}`, focused only by canvas click
(`:640`). `Tab` is captured and forwarded (`:684`) with no Escape, so the
textarea is a focus trap. The hover-only "Take control" overlay is unreachable
on touch (menu path works). `BrowserLifecycle` polls every 3 s while mounted
even with the menu hidden (`:854`).

**Tests.** `viewer.test.tsx` has nine mounted scenarios covering fit fencing,
handoff, restart, recovery tickets, native window, orphaned lease, and chat
return; `media.test.ts` covers sizing, credit ACK, and empty/revoked. Gaps:
wheel/click coordinate mapping through the viewer, keyboard/composition/paste,
target select, `back`, `media.ts` rejection paths, the `browser.$sessionId`
route, `useBrowserPane` seeding from initial messages, and the stuck
`resizeBlocked` scenario.

**Spec drift.** `browser.spec.md:37,134` still describe "Close browser and stop
run"; the UI says "Close this thread's tabs" and a test asserts the old label
is absent. `browser.spec.md:110-113` and `budId.spec.md:402-409` describe a
"browser-actions-paused notice" that does not exist. `browser.spec.md:16`
"Replaces session-link" refers to a file that never existed. The test summary
at `browser.spec.md:20-21` covers three of nine tests.

## Remaining items (from the plan's own status table)

`plan/bud-owned-browser/phases.md` is honest that most phases are "implemented
locally" with acceptance pending. Items still open after merge:

- **3g focused agent reliability** — argument/freshness/viewport/reading-coverage
  issues observed in live runs; listed as "next", not started.
- **3p / 3n / 3h / 3j actual-agent acceptance** — automated checks pass; no
  real-agent run has confirmed empty-workspace recovery, colour sync, or
  operation-driven viewing end to end.
- **3k / 3l host acceptance** — native secure-store and broader recovery matrix;
  Back/Forward and unsaved form state are explicitly *not* restored.
- **3o Ubuntu headed browser** — scoped only; `native_window` is gated to
  `cfg!(target_os = "macos")` in `manager.rs:300`. Linux is unsupported for the
  persistent headed browser today.
- **3b iOS viewer** — not started; the shared viewer is web-only.
- **Phase 4 release validation** — packaging, hosted/device matrix, sustained
  performance, unchanged-frame suppression, spike cleanup (blocker 3).
- **Chrome distribution** — Chrome for Testing is the accepted dev runtime, but
  there is no discovery: `manager.rs:244` requires `BUD_BROWSER_EXECUTABLE`, and
  the daemon warns and reports the browser unavailable otherwise.
- **Helper packaging** — `semantic.rs:30` falls back to a path baked in at
  compile time (`CARGO_MANIFEST_DIR/browser-helper/main.mjs`) and shells out to
  `node` (22+, Playwright Core pinned). A released daemon binary on another
  machine cannot find the helper without `BUD_BROWSER_HELPER`, and needs Node
  installed. `DAEMON_INSTALLER_FOLLOW_UP_HANDOFF.md` (untracked) does not cover this.
- **Security posture before real accounts** — `TODO.md` now records: revisit
  browser distribution/updates, persistent-profile credential protection, and
  don't carry fixture mock/basic-credential settings into persistent profiles.
- **Orphan scavenging** — cleanup covers explicit close and graceful shutdown;
  identity-safe scavenging after hard daemon termination is a listed follow-up.

## Technical debt (consolidated)

Ordered by how much it will cost later if left.

1. **Oversized modules**: `bud/src/browser/manager.rs::execute()` (~555 lines,
   duplicated authority checks), `web/src/features/browser/viewer.tsx` (860),
   `service/src/browser/control.ts` (548) and `media.ts` (409) as dense
   single-class modules.
2. **Vacuous env-gated Rust tests** that pass without Chrome instead of being
   `#[ignore]`; CI-less repo means nobody notices.
3. **Migration chain** 0039–0046 with create-then-drop churn and a hand-written
   trigger outside Drizzle's model.
4. **Prototype residue**: `spikes/bud-browser` plus the service test that
   spawns its binary; legacy `Observation`/`Element` adapter in `adapter.rs`;
   dead `takeoverPending`/`pausedSessionId` paths in web; unused handoff
   context fields in the service executor.
5. **Append-only spec/proto docs** that now contradict themselves (handoff
   advertisement, 8/12/36 KiB budgets, ephemeral vs persistent, "close pauses
   authority", paused-notice UI, main.rs shutdown cancel).
6. **Formatting**: no Prettier in `service/`; 35 lines over 200 chars and
   minified-style stretches in new files. 8 clippy warnings in the daemon.
7. **Duplicated types/logic**: `Session` vs `BrowserSession` rows, dual
   `control_epoch`/`browser_epoch` on `BrowserCommand`, `Browser` struct init
   and `Profile::acquire` repeated in the daemon.
8. **Unrelated changes riding along**: service-owned work-duration timing
   (`a180e62`, migration 0043, `web/src/lib` removals) and context-accounting
   changes (`cec9e1b`) are in this branch but independent of the browser. They
   are reviewed and pass, but they widen the blast radius of a revert.
9. **Process overhead**: one idle Node helper per daemon from the root
   `Browser`; synchronous fsync on the Tokio runtime after most agent ops.

## Major gaps

These are not defects in what was built; they are what the feature still lacks
to be a product surface rather than a local development capability.

- **No Linux support** for the persistent headed browser (secure storage,
  virtual display, env passthrough). Phase 3o is scoped only.
- **No iOS viewer** (Phase 3b) and bearer viewers are rejected on every browser
  route, so mobile users cannot see or take over the browser at all.
- **No packaging story**: Chrome for Testing is not discovered or installed;
  the Node helper path is compile-time; Node 22+ and Playwright Core must be
  present on the host. The release-flow handoff notes do not cover this.
- **No self-healing after hard termination**: stale `SingletonLock` blocks
  Reset (H2), corrupt hints block Close (H1), no orphan scavenging.
- **Single-instance authority**: control leases, tickets, and pending commands
  are in-process; overlapping deploys on Render pause live private control.
- **No HTTP-level authorization tests** for the new routes and every
  two-account manual check in the auth checklist is unchecked; ownership is
  correct by inspection but not proven by an integration run.
- **Keyboard accessibility and input breadth** in the viewer are below the bar
  for a general browsing surface; scoped in the keyboard/files/clipboard design.
- **Screenshot accounting** is blind to hydrated images, so the context meter
  and compaction are wrong during visual work.
- **Security posture for real accounts** is explicitly unreviewed (browser
  update channel, profile credential protection, fixture credential settings).

## Working tree hygiene

Untracked files at the branch tip that are not part of the browser feature and
should not ride along in the merge: `DAEMON_INSTALLER_FOLLOW_UP_HANDOFF.md`,
`RELEASE_FLOW_TESTING_NEXT_STEPS.md`, `git_loc_breakdown.py`,
`test_git_loc_breakdown.py`, `test`, `test2`, nine `reference/*.md` handoff
notes, and two `debug/*.md` notes about ingestion/Render. Either commit them on
their own branch or leave them out.

## Recommended pre-merge sequence

1. ~~Fix the two stale tests (blockers 1–2)~~ Done.
2. ~~Remove `spikes/bud-browser`~~ Done, together with its service test.
3. ~~Regenerate migrations 0039–0046~~ Done (Phase 3q).
4. Address the CONFIRMED correctness items in the tier sections below.
5. Clear the 8 clippy warnings and the one new web lint warning.
6. Write the PR description with code counts, migration names, env vars, and
   the daemon-then-service deploy order.
