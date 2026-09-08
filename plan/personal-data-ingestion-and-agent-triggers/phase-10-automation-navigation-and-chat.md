# Phase 10: Automation navigation and chat integration

Status: implementation in progress; independent settings navigation and control cleanup implemented, attribution and inventory refinements pending. Dependencies: phases 5–6. Parent: [implementation spec](implementation-spec.md).

## Shared automation destination

Expose Automations independently of Contacts/Data sources on both mobile and web.
Use the same owner-scoped rules, revisions, pending proposals and run history;
this is one product surface with native renderers, not two automation systems.
Preserve existing `/automations` links and rule IDs. Choose the exact primary
navigation placement to fit each app shell during UI design.

List trigger summary, Bud/model, enabled/paused/draft state, last run and any
attention needed. Details contain instructions, trigger/source, target, data
access and activity. Move deadlines, source identifiers and execution limits
under advanced controls while retaining effective values in approval review.
Distinguish a saved draft from enabled standing work unmistakably. Pause affects
future starts; canceling an individual run is a separate action.

The current schema only supports `contact.added` and mandates Contacts scope.
Make the presentation and trigger descriptors extensible, but do not expose
schedule/health/geographic triggers before their implementations exist. A future
trigger adapter must define evidence, matching/cutover/dedupe, consent and required
scopes; do not build a generic workflow engine in this phase. Any schema evolution
must keep existing contact rules/revisions executable and tolerate unknown types
as unavailable rather than coercing them into contact rules.

## Transcript attribution

Replace the prominent automation input presentation with compact per-invocation
attribution: “Triggered by New contact”, observation time, and links to the rule
and event/run details. Expand to see the approved instruction, revision and
evidence provenance. Keep canonical system-origin input and structured metadata
for model replay, compaction and audit; do not disguise it as a human message or
remove it from the provider's context. Imported contact content remains untrusted.

Existing-thread automations may occur anywhere in history; attribution belongs
to each invocation, not only the thread header. Historical details refer to the
executed revision even when a rule changes or is later removed.

## One execution control surface

Integrate durable state into existing composer/activity behavior. Running work
has one Stop control; completed work has its final answer and normal completed
work disclosure, without a permanent Completed bar. Waiting, expired, failed and
needs-review outcomes remain visible and actionable. Preserve distinct terminal
interrupt semantics and acknowledgment of uncertain side effects. Pausing a rule
must not imply that an already dispatched terminal command stopped.

Audit whether duplicate Completed/Stop UI comes from conflicting state selection
or merely duplicated presentation. Bind controls to the same invocation/turn and
withhold cancellation after terminal status. Reconcile with mobile
[stream-expanded work](../../../bud-mobile/plan/agent-work-collapse-ui/phase-11-stream-expanded-agent-work.md)
and the existing composer policy; do not reintroduce older superseded live-work
headers or disruptive streaming layout changes.

## Acceptance, ownership and rollout

- [ ] Both clients find/manage automations without entering Contacts settings.
- [ ] Rule edits and activity are shared; stale versions do not overwrite changes.
- [ ] Trigger attribution works for new/existing threads, multiple triggers, replay and compaction.
- [ ] Running has one Stop; completed has none; waiting/review recovery stays accessible.
- [ ] Old transcripts render acceptably when newer attribution metadata is absent.
- [ ] Cross-owner rule, run, thread and event links return no foreign data.

Reuse owner-scoped APIs and viewer-keyed client state. Add auth-checklist entries
for any new detail/read/stream surface. Update web route/components specs, mobile
chat/UI plans and protocol docs only for actual new wire fields. No daemon change
is anticipated. Validation: UX4–UX6 plus A4/A9/T5/T7.

## Current implementation

Both clients expose Automations directly from Settings. Successful invocations no
longer leave a Completed strip; duplicate status-strip Stop controls are hidden
when the existing composer already supplies one. Mobile retains the strip action
when a structured prompt hides the composer; web retains it for idle/waiting-user
states including offline queued work. Review acknowledgement and canonical input
are unchanged. Per-invocation attribution, advanced editor organization and live
recovery/visual acceptance remain open.

Validation: mobile simulator app/test build and two existing composer-policy
regressions passed (`/tmp/bud-single-composer-control-tests.log`), and web
production build passed (`/tmp/bud-single-control-web-build.log`). These establish
compilation and existing primary/terminal-wait policy; rendered control counts
and lifecycle transitions still require UI acceptance.

Web attribution slice: system messages stamped `origin: automation` now render
as compact expandable Triggered by rows, including when generic system messages
are hidden. Expansion preserves full original input plus recorded rule revision,
invocation/event IDs and correctly labeled invocation creation time. Ordinary
messages cannot acquire attribution from text alone. Three focused tests pass
(`/tmp/bud-attribution-tests.log`). Native metadata mapping, exact detail links,
observed-time fields and rendered/replay acceptance remain unfinished.

Native attribution is now implemented in the typed ChatTurn model, network mapper
and system-message renderer. It preserves old local Codable records and retains
automation rows independently of generic system-message visibility. Exact detail
navigation and source observation timestamps remain follow-up work within this
phase. The original input remains available when expanded.

Mobile validation: simulator app/test build and all three attribution tests pass
(`/tmp/bud-mobile-attribution-tests.log`): server-message mapping with hidden system
rows, original-input and attribution Codable round-trip, legacy records, and
ordinary-message non-attribution. This does not yet prove rendered navigation or
physical-device interaction.

Attribution now links to the exact automation and its existing activity/history
on both clients. Web uses validated URL selection that survives reload and back
navigation; native loads the exact rule through the owner-authenticated detail
API, with cancellation/account checks and unavailable/retry state. Opening an
unavailable rule does not create a draft. The recorded historical revision remains
on the attribution row, separate from the current editable rule. Web source and
execution limits are collapsed under Advanced settings; activation review still
shows every effective limit. Physical-device build could not find the previously
connected iPhone; see `debug/automation-detail-device-unavailable.md` in main repo.

Detail-link validation: web production build and mobile simulator build passed
(`/tmp/bud-automation-detail-links-web.log`, `/tmp/bud-automation-detail-links-simulator.log`).
Physical install and rendered cross-client navigation remain unverified.
