# Phase 0: five-tool agent integration

Status: closed experiment (2026-09-14). This document records the prototype's
five-tool integration, not normal server availability. The subsequent
[Phase-1 plan](./phase-1-agent-browser.md) supersedes its validation sequence:
four tools through the actual daemon now, durable handoff in Phase 2.

## Objective

Exercise the main agent's existing catalog, parser, execution, transcript and
provider-ledger paths against the disposable browser host. Use the five tools
accepted in [the plan](./README.md#agent-tool-surface-and-observations).

## Boundary

Add an explicitly injected browser integration to AgentService. Normal server
composition does not supply it, so deployed agents advertise no browser tools.
Keep the experimental transport in the spike; production code must not import
the spike or launch Chrome on the service machine.

The invocation supplies owner, Bud, thread, turn and cancellation. Every browser
operation rechecks that scope and host control authority. Model arguments cannot
select an owner, epoch, CDP endpoint or another thread. Revalidate authorization
after reads and withhold late results after cancellation or takeover.

Start with the actions the host actually supports (navigate, click, focus and
committed text), with target discovery through observations. Unsupported actions
must not be advertised. Screenshots remain disabled in agent tools until the
image executor/provider/ledger/replay path passes; human viewer capture remains.

## Handoff

Require an injected parking implementation to expose the five-tool catalog.
At handoff, checkpoint and record intent through the existing execution hooks,
then park before admitting trailing tools or another model request. The parking
contract receives call/client/ledger identity and trailing calls so continuation
can preserve every provider pairing. Publish waiting state only after parking
succeeds. Do not collect human secrets through tool arguments or questions.

The spike can validate this boundary with a fixture continuation. A durable
browser wait repository, worker recovery and production routes remain phase 2;
an in-memory fixture is not evidence of crash-safe handoff.

## Validation

- Schema/parser/replay for all five tools, including strict-provider nulls.
- No catalog or dispatch without injection; offline and unauthorized rejection.
- Real agent loop with browser actions, ledger/result pairing, owner stamping.
- Handoff stops trailing tools; failed parking and cancellation cannot resume.
- Real Rust host/relay smoke for the supported action subset, stale references,
  private takeover and fresh observation on return.
- Record separately which persistence/provider tests use fixtures and which use
  real services. Closure does not mark unperformed runtime/viewer checks as passed.

## Documentation and rollout

Update agent and spike specs and phase-0 findings. No database migration or
production BudEnvelope changes in this slice. Normal service/daemon pairings
remain unchanged; the experimental composition alone supplies browser tools.
No REPL, production flag, new UI or generic plugin registry.

## Result — 2026-09-14

Implemented the injected catalog/executor and spike bridge. Normal chat remains
unchanged; the fixture explicitly starts its browser before offering tools.

- Service `pnpm build`: passed.
- Agent regression selection (browser, contracts, model runner, loader, transcript
  writer, AgentService, personal-data tools): 62 passed, one real-browser test
  skipped without its executable variable.
- Browser agent and relay suites with Chrome for Testing enabled: 8 passed,
  no skips. The agent workflow uses real Chrome/CDP/relay and actual orchestration,
  with scripted provider responses and fixture database writes/continuation.
- `git diff --check`: passed.

At this checkpoint, the next planned checks were real-provider and real-auth/DB
validation through the first-party dev origin. The live-provider/SQL results
below supersede part of that checkpoint; the closure note above sets current scope. Durable browser waits, worker cancellation/recovery and automatic daemon
launch remain separate planned work. The accepted five-tool surface does not
imply these lifecycle features are complete.

## Next validation slice: live model

Reuse the real browser workflow with an explicitly opted-in live OpenAI provider.
Keep the actual AgentService/model-runner/transcript path, but isolate persistence
and viewer authentication as fixtures. Limit provider calls and output, expose
only the five browser tools, and assert the requested page state before and after
private input. Do not assert a particular model call count or tool batching.
The private credential is supplied only through the viewer, never in the prompt.
Report live-model evidence separately from real-auth/DB and edge validation.

Live validation permits corrected, definitively rejected argument errors; it
still fails on uncertain mutations, incorrect page state, missing handoff/close,
private-data leakage or exhausted call/time budgets. The scripted regression
requires every action to succeed. Report live validation-rejection counts rather
than claiming first-try schema reliability from a recovered workflow.

### Live-model and SQL result — 2026-09-14

Passed with GPT-5.6 Luna and Chrome for Testing: 13 provider calls, eight
successful tool results and three argument-validation rejections corrected by
the model. Form contents, private handoff, fresh return, resumed observation,
close, and absence of fake private input from requests/transcript writes passed.
The test took approximately 22.5 seconds; this is functional evidence only.

Added field applicability/null descriptions and actionable static validation
feedback after live testing revealed redundant target_id arguments. No invalid
command was dispatched and no host focus guard was relaxed. First-try tool
selection/argument reliability remains an area to evaluate across providers.

The SQL fixture found and fixed the missing soft-deletion predicate. Foreign
scope, Bud unclaim, and deletion before/during reads now pass against temporary
PostgreSQL tables. Final validation: service build, nine deterministic
browser/relay/SQL tests, and the opt-in live-provider workflow passed.
Real authenticated first-party/edge testing and durable continuation carry
forward to their runtime phases;
no normal server enablement, database migration or daemon deployment was done.
