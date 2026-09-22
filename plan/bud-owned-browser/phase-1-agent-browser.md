# Phase 1: browser tools in the actual Bud agent

Status: implemented and validated through normal local chat (2026-09-14).
Development scope: ephemeral Chrome for Testing; release limitations listed below.
Started 2026-09-14 after [Phase 0 closed](./phase-0-findings.md#closure-and-carry-forward--2026-09-14).

## Objective

From an ordinary signed-in chat, the main agent can start its thread's browser
on the selected Bud, open an external HTTP(S) page, inspect and interact with it,
and use the same session on a later turn. No standalone spike relay, manually
launched browser host, fixture provider or prototype viewer is required.

The target five-tool design remains. This phase exposes **four** tools:
`browser_open`, `browser_observe`, `browser_act`, `browser_close`.
`browser_request_handoff` is unavailable until Phase 2 implements durable human
handoff. Web and mobile can initiate these ordinary agent turns through their
existing chat interfaces; neither needs a browser viewer for this phase.

Related context:

- [Overall design](./README.md) and [delivery phases](./phases.md)
- [Daemon](../../bud/bud.spec.md) and [daemon source](../../bud/src/src.spec.md)
- [Agent](../../service/src/agent/agent.spec.md)
- [Transport](../../service/src/transport/transport.spec.md),
  [WebSocket](../../service/src/ws/ws.spec.md),
  [gRPC](../../service/src/grpc/grpc.spec.md)
- [Database](../../service/src/db/db.spec.md) and [wire contract](../../docs/proto.md)

## Starting point and missing connection

The existing injected `BrowserToolExecutor` validates arguments and owner/Bud/
thread scope, including soft deletion, before and after operations. Canonical
parsing, transcript and replay paths recognize the browser tools. Fixture tests
exercise the real agent loop and a live model.

At the start of this phase, `service/src/server.ts` did not supply an executor.
It now supplies the production broker. The separate prototype host/parking
callback remains only in opt-in Phase-0 tests.

The implemented runtime path is:

```text
normal chat -> AgentService -> BrowserToolExecutor -> service browser broker
  -> authenticated daemon control carrier -> daemon browser manager -> CDP
```

Chrome runs on the Bud machine. The service never launches a local browser for a
remote Bud, accepts an arbitrary CDP URL, or imports `spikes/bud-browser`.

## Implementation sequence

### 1. Resource and wire contract

Keep browser ownership separate from terminal and proxied-site resources.
Add the owned `browser_session` record described in the parent design, with a
transactional one-active-default-per-thread constraint. Store identity, desired
lifecycle, generation and control revision; do not store live DOM or CDP URLs.
Handoff records and viewer grants belong to Phase 2.

The acting agent identity comes from the invocation's owner, Bud and thread,
not tool arguments. Before dispatch, join session/thread/Bud ownership and check
soft deletion and device claim. Recheck before delivering page data. Any session
routes use `requireViewer` and scoped SQL: signed-out requests get 401 and other
owners' resources get 404. Stamp owner/tenant fields when creating records.

Define versioned browser request/result payloads inside the existing
`BudEnvelope`, with `snake_case` fields. Carry request ID, session/generation,
control epoch and invocation fence identity; page/element IDs remain opaque.
Bind result correlation to the authenticated device session as well as request
identity so a stale socket cannot complete new work.

Use the transport-neutral router and implement both WS and gRPC dispatch. Check
the active carrier's browser capability, not a stale persisted capability alone.
Do not let generic cross-carrier fallback replay an action that may have been
accepted. The browser broker owns the pending request and uncertain outcome.

Before coding payload fields, reconcile them with the existing invocation fence
and device-session contracts. Reuse their authority rather than introducing an
independent browser invocation scheduler.

### 2. Daemon lifecycle and narrow adapter

Move selected launch/CDP/semantic operations into `bud/src/browser/`. Keep
`app.rs` responsible for wiring and dispatch. Keep the adapter concrete and
small; preserve a capability/ownership boundary for a future attached browser
without building an extension or plugin registry.

Use an explicitly configured Chrome for Testing executable for development.
No tool-time download or fallback to a personal Chrome profile. Retain sandboxing,
private discovery metadata, startup readiness checks and owned-child cleanup.
Surface missing/unsupported runtime through capability diagnostics and
`bud doctor` guidance.

Serialize work per session with bounded admission, not on the main heartbeat
loop. Two threads have separate profiles, targets and element references. Start
with two active sessions per Bud and bounded operation deadlines; reject excess
work rather than accumulating unbounded tasks.

The first launch increment may use an explicitly ephemeral profile. Before
claiming the parent plan's persistent-profile default, implement profile ownership,
secure credential storage policy and deletion. Mock/basic credential settings
from fake-credential fixtures must not silently become the persistent policy.
Report profile mode honestly in session results. This is an implementation
sequence, not a promise that the fixture's temporary directory is durable.

A completed turn or control transport disconnect does not close the browser.
Disconnect stops further command admission and invalidates outstanding authority;
reconnect reconciles the live generation before new work. Interrupted requests
are not replayed. A daemon/browser restart reports interruption and requires
explicit reopen; never attach a different process by a reused PID or debug port.
Explicit close and thread deletion clean up only Bud-owned resources. Offline
cleanup intent must survive until the daemon reconnects.

### 3. Normal agent composition

Supply the real broker-backed executor in `server.ts`. Split basic browser
availability from handoff availability: a daemon capable of the four control
tools must not require a `park` callback, and the catalog must not expose the
handoff tool merely because ordinary browsing works.

Keep initially supported actions aligned with the proven adapter: navigation,
observation, focus, committed text and click. Report navigation as requested
until a subsequent observation confirms page state. Do not advertise scrolling,
keys, dialogs, screenshots or complex editor support until implemented.

Use normal canonical schemas, execution hooks, cancellation, tool/result pairing,
owner-stamped transcripts and replay. No direct path around invocation fencing.
A stale/hallucinated handoff call gets a paired unsupported result; it must not
create a generic questions form or hang the turn. Tool descriptions must explain
that private sign-in handoff is unavailable during this phase.

If the browser is missing or the daemon is old/offline, omit unsupported tools
and supply actionable environment information. If availability changes after
catalog creation, return a definitive unavailable result when nothing was sent,
or an unknown outcome when execution may have happened.

### 4. Real-chat validation and cleanup

Build and run the updated service and actual daemon with Chrome for Testing.
Use a normal authenticated chat and real provider to browse an external public
page, follow a link and report observed content. Also use a controlled page to
verify input/click behavior without unintended external writes.

Keep deterministic tests for authorization, stale references, request correlation,
cancellation and reconnect. They support the real-chat test; they do not replace
it. Retain the spike as evidence until selected operations have runtime coverage,
then remove duplicate implementation during the planned cleanup.

## Failure and edge-case contract

| Case | Required behavior |
| --- | --- |
| Concurrent open in one thread | One service session and one owned browser; do not race profile locks |
| Two threads on one Bud | Separate sessions/profiles; no implicit reuse of another thread's active target |
| Another owner, deleted thread or unclaimed Bud | Reject before dispatch; withhold late page data; reconcile owned cleanup |
| Navigation or dynamic DOM changes | Reject stale references/focus; require a new observation |
| Timeout/cancel after possible mutation | Unknown outcome; no automatic replay or invented success |
| Duplicate request | Same live request cannot apply twice; expired correlation is not permission to redispatch |
| Superseded invocation/control epoch | Daemon rejects stale queued work before applying it |
| Control disconnect/reconnect | Preserve live browser, fence commands, reconcile generation; never replay pending clicks/text |
| Browser or daemon restart | Report interruption; explicit reopen creates a new generation and invalidates old references |
| Service restart | Recover owned identity/desired lifecycle, reconcile host state before new dispatch |
| Session/resource limit | Bounded, actionable rejection; other threads and terminal traffic remain responsive |
| Unsupported page interaction | Honest limitation; no fabricated interaction or silently enabled screenshot/JS tool |

## Explicit won't-dos

- No more Phase-0 prototype gates, manual relay setup as the product test, or
  fixture-only declaration of readiness.
- No handoff, private input UI, viewer grants, continuous media, web workbench
  browser surface or iPhone viewer in Phase 1.
- No REPL, raw CDP/JavaScript passthrough, personal-browser attachment or extension.
- No general transport/session refactor, second browser runtime, universal browser
  compatibility claim or retry framework for uncertain mutations.
- No changes to the loopback-only app-preview contract. `web_view_*` still
  publishes local apps; the new browser tools navigate external HTTP(S) sites.

## Acceptance checklist

- [x] Normal service composition exposes exactly the four supported tools for a capable Bud.
- [x] Actual chat opens, observes and interacts using a daemon-launched browser.
- [x] Later turns reuse the live thread session; another thread is isolated.
- [x] Real ownership queries and device-session checks reject foreign/deleted scope.
- [x] Close, cancellation, interrupted-session recovery, reconnect and duplicate admission are tested. Hard-kill orphan scavenging remains release work below.
- [x] Browser work does not block terminal dispatch or daemon heartbeats.
- [x] Missing runtime and old daemon are actionable, without breaking existing work.
- [x] WS and gRPC contracts and mixed-version cases are tested.
- [x] Additive schema applied locally; generated migration tested in isolated PostgreSQL. Full db:push was canceled on unrelated dedupe work (details below).
- [x] Relevant specs, protocol, ownership checklist and runtime instructions are updated.

## Rollout and documentation

New service / old daemon: no browser commands sent; existing tools continue.
Old service / new daemon: additional capability is ignored; no unsolicited browser
frames or media connections. Both new: normal four-tool browsing after readiness.
A daemon build/upgrade is required. No mobile rebuild is required for existing
chat to invoke these tools; the later embedded viewer does require one.

Update daemon source/browser/config/doctor specs; service browser, agent, DB,
migrations, transport, WS/gRPC and proto specs; root architecture; and
`plan/init-auth/validation-checklist.md`. Browser protocol additions must be
recorded in `docs/proto.md`. Add a spec for each new source folder.

Phase 1 is complete only after the normal agent path works and the acceptance
checks above pass. Phase-0 closure alone does not make `browser_open` available.

## Implemented evidence — 2026-09-14

User validation confirmed that the actual agent successfully navigated to a login
page through chat. Login-page navigation is confirmed; completing sign-in,
private credential entry and user handoff were not validated by this check and
remain later-phase work.

The real authenticated HTTP chat path used the ordinary service worker and
GPT-5.6 Luna, not an injected provider or a spike host. Local thread
`706ec85e-44c1-45b2-b163-ecb7069dfd54` on Bud `b_01KM54M7SYPC7GZX0SWBKFE5YP`:

1. Agent opened example.com, observed Example Domain, followed Learn more, then
   observed Example Domains at `https://www.iana.org/help/example-domains`.
2. A later turn reused the same session/target, navigated to a disposable local
   form, focused Name, inserted `Bud validation`, submitted, observed
   `Validation passed`, and explicitly closed the browser.
3. One malformed click argument set was rejected with static schema guidance;
   the model corrected it and continued. No uncertain mutation was retried.

A separate actual daemon/authenticated gRPC gateway smoke passed open, observe
and close. The normal real-model test used WS; the gRPC smoke exercised the
production gateway and transport, without a second paid model loop.

Validation:
- `cargo test --lib`: 123 pass; two live Chrome tests require an explicit runtime.
- `BUD_BROWSER_EXECUTABLE=... cargo test browser --lib`: 4 pass, including actual
  concurrent launch/profile isolation, fresh references, reconnect, rejected
  duplicate commands, cancellation of a stalled local navigation, poisoned
  connection rejection and explicit close/reopen recovery.
- Service browser/agent/ownership tests: 13 pass, one optional Phase-0 relay test
  skipped. PostgreSQL repository test additionally covers fresh repository
  recovery and daemon boot/generation replacement.
- Combined final browser/SQL/worker/WS/gRPC gateway/codec run: 59 pass, one optional
  Phase-0 relay test skipped. The unknown protobuf-tag fixture uses 192 now that
  190/191 are assigned to browser control.
- Service TypeScript build and browser-module ESLint pass. `pnpm db:generate`
  reports no further schema changes after generating `0039_tiny_loners.sql`.

The local migration was applied transactionally to verified localhost PostgreSQL.
`pnpm db:push` was attempted but canceled because it proposed unrelated invocation
dedupe changes and possible truncation. Only reviewed migration 0039 was applied;
no production data or schema changed. See [debug record](../../debug/bud-browser-phase-1.md).

## Development setup and recovery

Set `BUD_BROWSER_EXECUTABLE` in the **daemon** environment to the full installed
Chrome for Testing executable path (on macOS, the executable inside the app's
`Contents/MacOS/` directory), then run `bud doctor` and restart that daemon. There
is no service-side Chrome path or browser download in a tool call. The optional
probe reports unavailable without breaking terminal capability.

Deploy migration `0039_tiny_loners.sql` before starting the updated service. Upgrade
the daemon for browser tools; no web/mobile build is required to issue normal chat
requests. Ask the selected Bud to open a public page, inspect it and follow a link.
A turn ending preserves the session; `browser_close` discards its ephemeral profile.
After an interrupted browser, close then open and observe fresh state; do not
repeat a possibly completed form submission merely because its reply was lost.

## Explicit remaining release work

- SIGINT/SIGTERM and explicit close clean up owned children; hard SIGKILL or power
  loss can leave an orphan process/profile. Add identity-safe scavenging before
  broader release; never kill or attach by a reused PID/port. Browser restart
  continuity is not promised. This does not block the accepted dev runtime.
- Persistent profiles, protected credentials, private handoff and viewer UI are
  intentionally absent. Mock/basic credential storage is restricted to the
  ephemeral development profile; revisit it before persistent authenticated use.
- Repeat live two-account OAuth/unclaim races, supported OS/browser matrix and
  sustained browser-plus-terminal load measurements during release validation.
  Focused SQL/transport tests are not a claim that those device/UI passes ran.
- Retain the Phase-0 spike until handoff operations have production coverage;
  remove duplicated experiment implementation in Phase 4 cleanup.
