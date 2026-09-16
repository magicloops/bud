# Delivery phases: Bud-owned browser

Status: **Phase 0 closed; Phase 1 validated; Phase 2 implemented for development,
with broader signed-in acceptance pending; Phase 3a implemented locally** (2026-09-14).
Phase 0 established enough evidence to implement the real daemon/agent path.
Closing the experiment does not certify production readiness or mark deferred
checks as passed. See [findings](./phase-0-findings.md) and the
[Phase-1 implementation plan](./phase-1-agent-browser.md).
Contract and defaults: [README](./README.md).

## Phase 0 — risky vertical slice and decisions (closed)

The disposable Rust host, separate-socket relay, prototype viewer and injected
five-tool agent integration established launch, semantic interaction and private
handoff feasibility. A real-model fixture also passed. Chrome for Testing is the
accepted development runtime; further regular-Chrome concurrency investigation
is not a prerequisite.

**Closure decision:** stop extending the standalone prototype. Test the next
vertical slice with the actual agent, normal service composition and running Bud
daemon. Do not require users to start a separate host/relay or use a scripted
provider before continuing. Preserve useful automated regressions as selected
code moves into the runtime.

Deferred checks have explicit homes:

| Unfinished experiment/check | Delivery phase |
| --- | --- |
| Real-chat execution, daemon launch, authenticated device transport, owner isolation, reconnect and mixed-version behavior | Phase 1 |
| Durable parking/continuation, private input, takeover and bounded media scheduling | Phase 2 |
| Real signed-in web viewer, private login/return, edge/viewer grants and revocation | Phase 2; polished workbench/mobile integration in Phase 3 |
| iPhone input, OTP, composition, keyboard, background/reconnect and web/mobile switching | Phase 3 |
| Provider image serialization/ledger/replay | Before advertising agent screenshots; deferred from Phase 1's semantic tools |
| Broader Linux/browser/site compatibility, sustained load and resource measurements | Alongside the relevant implementation; supported-release matrix in Phase 4 |

See the findings for exact evidence and limitations. None of these deferrals
weakens authorization, mutation replay rules or process ownership in Phase 1.

## Phase 1 — resource, daemon lifecycle and control tools

Deliver the smallest useful agent browser through **normal chat**, before
production viewer streaming. The detailed sequence and acceptance checks are in
[phase-1-agent-browser.md](./phase-1-agent-browser.md).

Advertise only `browser_open`, `browser_observe`, `browser_act`, and
`browser_close`. The accepted fifth tool, `browser_request_handoff`, joins the
catalog in Phase 2 when durable parking and return work. Browser availability
must not depend on a prototype handoff callback.

- Add owned session records and migration, authorized repository and daemon command
  executor. Phase 1 uses ephemeral profiles and ordinary agent tools; browser
  inventory/control HTTP APIs join the viewer work in Phase 2.
- Add manager/adapter under `bud/src/browser/`; profile isolation, process
  cleanup, capability probe, session generations and tool timeouts.
- Define browser control envelope and error catalog; capability-gate dispatch
  across WS/gRPC. Preserve existing terminal/file/proxy messages and versions.
- Add canonical open/observe/act/close tools, safe snapshots, reference validation,
  environment availability and model capability handling.
- Add control epoch admission at the daemon now, before exposing human input.
  Integrate invocation fence/call IDs so duplicate/unknown mutations are not replayed.
- Reconcile transport reconnect; report daemon/browser restart as interrupted.
  Add `bud doctor` guidance and explicit resource limits.

Exit: the actual agent opens an external HTTP(S) page from ordinary chat without
a separately launched prototype; two threads operate isolated browsers; missing Chromium/old daemon produces
an actionable unsupported result; unauthorized users cannot discover/control a
session; cleanup and reconnect cannot attach the wrong instance.

## Phase 2 — usable private web handoff and bounded media relay

Deliver the complete actual-agent → human sign-in → agent-resume flow through
a minimal authenticated web viewer. A backend or test harness alone does not
complete this phase. See [the detailed Phase-2 plan](./phase-2-private-handoff.md).

- Add browser handoff waiting action and execution hooks. Use existing invocation
  claim/park/continuation patterns; keep browser repository separate from agent
  orchestration and avoid growing agent-service into the browser manager.
- Support both agent-requested and user-initiated takeover at valid execution
  boundaries. Persist all provider tool-call pairings before parking; test a
  multi-tool response and a request already in flight.
- Add view/control grants, subordinate daemon media tickets, epoch validation,
  one-controller leases, private observation fencing and explicit return.
- Add bounded image transport, frame metadata, per-viewer ack/backlog limits,
  zero-viewer capture shutdown, input validation and reset/close handling.
- Use revisioned metadata snapshots with small viewer/discovery polls; existing
  chat SSE announces handoffs. Do not emit frames or keystrokes into chat events.
- Extend shutdown/drain and revocation paths. Verify edge routes and the existing
  single-instance hosting constraint. Redact grants, input and page payloads at
  every logger/access-log boundary.
- Add a standalone first-party web viewer with live canvas display, remote target
  selection, basic pointer/scroll/text/key input, explicit takeover/return and
  visible paused/reconnecting states. Keep frame updates outside React/chat state.
- Add a minimal inline handoff message with Open browser and existing Stop
  semantics. Preserve tool pairing and Worked for behavior; waiting for human
  has no active-work spinner. This is the real web entry point, not a prototype.

Exit: a user opens the viewer from an actual agent handoff, enters credentials
privately and explicitly returns control so that the same invocation continues
in the same live browser. Disconnect and service restart leave automation safely paused; stale
commands/grants fail; slow viewers cannot grow memory or stall terminal/control;
private input is absent from transcript, ledger and logs.

## Phase 3 — polished web integration and iOS viewer

Deliver web first as [Phase 3a: automatic browser pane and viewport fitting](phase-3a-web-pane.md).
Phase 3a automated checks pass; signed-in pane acceptance remains pending.
Phase 3b then adds native iOS hosting and device-specific behavior. The standalone
viewer is user-confirmed working locally; broader Phase-2 acceptance remains tracked.

- Reuse the Phase-2 viewer, input and handoff components; add the workbench Browser
  surface alongside app preview and refine navigation, layout and accessibility.
  Preserve the existing canvas loop, control authority and stable message IDs.
- Add iOS-specific viewer store/container with scoped bootstrap grant, trusted
  origin bridge, background/release handling and fullscreen controls. Do not reuse
  proxy popup navigation to flatten real remote tabs.
- Extend validated web input for iPhone keyboard/composition and touch; add
  preserve-layout local zoom and explicit remote resize. Keep
  keyboard/safe-area changes local unless resize was requested.
- Test web/mobile switching: one session, separate viewers, explicit control
  transfer. Closing one client neither closes the browser nor resumes the agent.

Exit: real-device login/intervention/resume works through hosted service and edge;
existing app preview, mobile Back behavior, thread streaming/scrolling and terminal
input remain correct. Provide user-facing limitations for unsupported interactions.

## Phase 3d — agent observations and semantic targeting

Scoped in [phase-3d-agent-observations-and-targeting.md](phase-3d-agent-observations-and-targeting.md).
Deliver requested structured text snapshots and exact semantic actions, then
provider-visible on-demand screenshots and visible DOM. Agent observations are
independent of continuous human viewer media. Retain five tools; a REPL is deferred.
This phase owns the provider image serialization/ledger/replay gate previously
listed as a deferral. It can proceed independently of the iOS viewer. Implemented locally; normal-agent
text/visual acceptance and comparative performance measurement remain pending.
See the phase document for setup, limits and validation status.

## Phase 3e — inline browser waits and continuation cleanup

See [phase-3e-inline-browser-waits.md](phase-3e-inline-browser-waits.md).
Replace private-control tool rejection with durable invocation waiting and an
inline Return to agent action. Reuse existing authority and continuation machinery;
address multiple waiting turns, atomic parking/return races and truthful deferred
tool results before extending the UI. After return, observe and reconsider rather
than replay stale actions. Includes a focused technical-debt review and explicit
cleanup boundaries. Implemented locally; user testing confirmed waiting, inline
return and continuation. Compact action styling is user-validated. Broader restart,
concurrency and hosted acceptance remain in the phase validation checklist.

## Phase 3f — compact browser observations

Implemented locally; automated validation passed, actual-agent acceptance pending: [phase-3f-compact-browser-observations.md](phase-3f-compact-browser-observations.md).
Reduce duplicated snapshot representations, layout noise and reference overhead;
budget complete results and clarify scope/continuation versus viewport inspection.
Preserve observation authority and replay, with measured bytes/tokens and actual-agent
acceptance. Excludes history eviction, snapshot diffs and a new browser API.

## Phase 4 — release validation and cleanup

- Run the matrix below; record measured performance and revise tuning defaults.
- Implement [unchanged-frame suppression](#media-efficiency-follow-up) after the
  private-control lifecycle is validated; measure bandwidth and capture cost.
- Remove spike code, temporary debug logs and unused abstractions. Keep bounded
  operational metrics for frame age/drop count/bytes, input ACK latency, lease
  transitions and typed failures, without page contents.
- Document install/probe, supported versions, profiles, deletion, interrupted
  sessions, auth limitations and the trust model.
- Review all modified specs and cross-repo handoff docs. Include migration names,
  required daemon upgrade/mobile build and measured validation in PR descriptions.

Exit: the supported workflow is complete on web and mobile with no claim of
desktop control, arbitrary browser attachment or crash-preserved live page state.

### Media efficiency follow-up

Current capture sends complete JPEG frames on viewer demand, capped at ten per
second, including unchanged screens. Start by comparing captures on the daemon
and skipping identical image payloads; retain full frames for changed content.
This reduces transfer/decode work, but still incurs capture/comparison cost.
Measure that cost before adding event-driven capture or adaptive idle polling.

- Keep transport liveness, viewer credit and private-control renewal independent
  of image changes. A static page must remain connected and controllable; an
  unchanged result must release capture credit without accumulating requests.
- Track document, target, viewport and focus freshness independently of image
  equality. An unchanged screen must not make valid input appear stale or hide a
  metadata change. Retain authorization and epoch checks on every delivery.
- Send a complete initial frame to new/reconnected viewers and after target,
  viewport, generation or control-epoch changes. Never reuse private cached
  content across authorization boundaries; stop capture with no eligible viewers.
- Validate static pages beyond several lease intervals, typing/scroll/animation,
  navigation to visually identical pages, slow/new viewers and reconnect. Compare
  bytes/sec, CPU and input-to-visible-update latency against the current path.
- Capability-gate any new unchanged-result wire message; mixed versions keep the
  current full-frame behavior. Tile diffs, delta codecs and video transport are
  out of scope unless measurements justify them.

## Later phase — optional user browser

Prototype direct Chrome consent attachment versus an extension using the same
backend contract. Choose one based on repeat consent, tab scope, local interaction,
OS support and capture/input reliability. Implement explicit onboarding/revocation,
attachment-only teardown and capability-specific UI. Separately evaluate delegated
agent MCP integration through the broker. Neither is a prerequisite for phases 1–4.

## Acceptance matrix

| Area | Required cases |
| --- | --- |
| Ownership | Other user GET/list/WS/grant/control; forged thread/Bud/session; deleted thread; profile reuse across users; device unclaim |
| Sessions | Concurrent ensure; two threads; browser crash; daemon restart; persistent vs ephemeral close; orphan cleanup; offline deletion |
| Handoff | Agent request; user request mid-tool/mid-provider response; two takeover requests; delayed daemon ACK; unknown in-flight mutation; cancel while waiting; completed invocation |
| Privacy | Concurrent agent screenshot/DOM request during takeover; delayed prior-epoch observation; second viewer; credentials in logs, errors, telemetry, history and provider ledger |
| Recovery | Web reload; phone background for OTP; control loss; media-only loss; service restart; revoked/expired/replayed ticket; duplicate Return; new generation with old target IDs |
| Input | Pointer coordinates at different DPR/zoom; stale viewport/focus; cross-origin frame; popup close; held modifiers on disconnect; IME/Unicode; password/OTP paste; no replay after uncertain ACK |
| Agent | Tool schemas for each provider; text-only model; image-capable model; paired tool results after resume; unavailable model/Bud; no command under stale invocation fence |
| Performance | Busy page + terminal + file/proxy traffic; slow viewer beside fast viewer; no viewers; background; repeated open/close; 30-minute session and bounded memory |
| UI | Desktop/mobile web/iPhone; large text; keyboard-safe controls; screenshot stream not triggering transcript renders/scroll; initial opening versus reconnect; remote Back versus viewer navigation |
| Deployment | Service new/daemon old; daemon new/service old; both new; WS control; gRPC control + dedicated WS media; ngrok/Cloudflare upgrade and reconnect |

Performance targets are provisional implementation/release budgets, not current
measurements: interactive input-to-visible-update p95 under 500ms on a defined
representative network; control/terminal p95 latency increase under 50ms compared
with the same workload without capture; no accumulated old-frame playback after
reconnect; zero capture with no viewers; stable memory over a 30-minute soak.
Record network RTT/bandwidth, browser/device versions, CPU, encoded bytes/sec,
render/decode time and sample size so results are reproducible. Drop frame rate
or resolution before sacrificing control latency; WebRTC requires evidence.

## Files and specs to update during implementation

Read each full source/spec before editing. Proposed new modules are browser-only;
do not refactor surrounding systems unless needed for a concrete boundary.

| Area | Implementation touchpoints | Documentation |
| --- | --- | --- |
| Daemon | New `bud/src/browser/`; app dispatch/capabilities, config/doctor, protocol/codec, Cargo dependency | `bud/bud.spec.md`, `bud/src/src.spec.md`, new `browser.spec.md` |
| Wire | `proto/bud/v1/bud.proto`, Rust codec + gRPC adapters, service WS/proto/gRPC routing | `docs/proto.md`, service proto/WS/gRPC specs |
| Service browser | New `service/src/browser/`, routes, scoped resource/grant helpers, relay registry | New browser spec, service/routes/transport/runtime/auth specs as changed |
| Database | `service/src/db/schema.ts`, checked-in Drizzle migration and metadata | DB + migration specs; local `pnpm db:push`, generate and test deploy migration |
| Agent | Canonical definitions/contracts, browser executor, execution hooks, durable wait repository/worker, provider image path if required | Agent/LLM/provider specs and tool docs |
| Web | New viewer modules/route, thread discovery hook, workbench placement, handoff renderer | Web route/feature/workbench/message-renderer specs |
| Mobile | New browser viewer store/container/input bridge; ChatBackend client and inline handoff mapping | Mobile design and phase docs, PROGRESS.md; Xcode project entries if needed |
| Edge | Cloudflare route bindings and worker/deployment config only as required | Deployment runbook; localhost/ngrok setup notes |

Add the browser owner-isolation matrix to
`plan/init-auth/validation-checklist.md`. Update root `bud.spec.md` when the
architecture is implemented; this proposal does not describe existing runtime.

## Rollout

Schema changes need both local push and generated checked-in migrations; test
`db:migrate` against a pre-browser DB. Do not add empty browser rows for every
existing thread. Deploy additive service support before enabling the feature in
clients; new daemons advertise support only after local browser readiness checks.

| Pairing | Expected behavior |
| --- | --- |
| New service / old daemon | Browser tools unavailable; no new request shapes sent; existing work unaffected |
| Old service / new daemon | Ignore unknown capability; daemon does not open media or emit browser events without negotiated service support |
| Both new | Semantic tools and Phase-2 handoff/viewer after migrations 0039–0041 and a ready upgraded daemon; manual acceptance remains pending |
| Old mobile / new service | Existing app previews/chat work; generic tool summary remains intelligible, browser handoff offers first-party web viewer link |

Phase 1 needs a daemon release/upgrade, but no mobile rebuild or new viewer UI.
Phase 3 needs a mobile rebuild for the embedded viewer.
Use a versioned browser capability handshake for actual mixed-version deployment,
not a permanent compatibility mode or alternate browser implementation. Do not
relax session authorization or replay uncertain actions to keep a rollout green.

## Screenshot quality and future video

- [Phase 3c: sharper screenshots](phase-3c-screenshot-quality.md): negotiated PNG
  capture up to 2x density; existing screenshot relay remains the default.
- [Future phase 5: WebRTC media](phase-5-webrtc-media.md): measurement-gated media
  upgrade, preserving session ownership and private-control lifecycle. Not started.
