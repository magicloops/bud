# Mobile API follow-up handoff

Verified against service commit `65a1be7` on 2026-10-01. This supplements the
[original handoff](mobile-api-handoff.md) and answers the mobile team's five
follow-up questions. It describes implementation, not a claim that production or
an installed native build has adopted it.

## 1. Expanded examples

Use [mobile-api-follow-up-fixtures.json](mobile-api-follow-up-fixtures.json).
It contains complete JSON envelopes rather than abbreviated snippets:

| JSON key | Contents |
|---|---|
| `open_response` | Full thread summary, three canonical messages, transcript pagination and turn timing, idle agent state with a settled invocation and empty pending inventories, stream cursor and inclusion flags |
| `presentation_examples` | All seven kinds, each with a tool message, historical message with null ID/status, and pending-tool object with pending presentation |
| `generic_tool_messages` | Search, read, ordinary browser and proxied web-view examples |
| `historical_edge_cases` | Plain text, malformed JSON, metadata-only payload and an object lacking a tool name |
| `events` | Full list `upsert`, `agent.invocation_changed`, and `transcript.message` envelopes |

Messages, presentation, invocation, environment and runtime snapshot examples were
generated through the implementation's serializers with synthetic inputs. The open
envelope was assembled from the route's field definitions. These are **not captured
production responses**. Nested tool-specific result objects are illustrative
projection examples, not exhaustive schemas for approval UI or tool execution.
The pending examples with empty args show pre-identity classification; they are
not valid requests to invoke those tools. Do not copy their identifiers/cursors
into live requests. Dates and selected model are examples, not API constants.

An actual full open does not need every possible optional state to be populated.
In this example the runtime has no active turn, while durable history contains a
settled invocation. `context_budget` is absent from `agent_state`, not null.
`included` explicitly marks the omitted resources. Transcript messages are oldest
to newest within the loaded page; populated boundary cursors do not imply more
history exists—use the `has_more_*` fields.

The event objects express SSE framing: `event` is the SSE event name, `id` (where
present) is the SSE ID, and JSON-stringified `data` is the SSE data body. In particular:

- `agent.invocation_changed` data is the invocation itself, **not** `{invocation: ...}`.
- `transcript.message` data is `{message: ...}` using the same canonical message
  shape as REST. Deduplicate against already loaded rows and other canonical events.
- `upsert` data is `{thread, epoch, sequence}`. It carries a full thread summary,
  not a partial patch. Its checkpoint is separate from the thread agent-stream ID.

Invocation events describe committed lifecycle state, not proof that all messages
have been received. Keep the recovery algorithms in the original handoff.

## 2. Tool presentation classification

| Tool/evidence | `presentation.kind` |
|---|---|
| `ask_user_questions` | `questions` |
| `data_request_api_key` | `app_permission` |
| `automations_request_activation` | `automation_activation` |
| `automations_request_existing_contacts` | `bootstrap` |
| `browser_request_handoff`, or a payload with top-level `wait_kind: "return_control"` | `browser_handoff` |
| `terminal.*` | `terminal` |
| `web_search`, `web_read` | `generic` |
| Ordinary browser tools, such as `browser_open`, `browser_observe`, `browser_act`, `browser_close` | `generic` unless the return-control rule applies |
| `web_view.open`, `web_view.close`, `web_view.list`, other tools | `generic` |

For canonical results the tool name normally lives in `tool_payload.tool`. For
pending calls it is `pending_tool.name`, or `agent.tool_call.data.name`; there is
no pending `tool_payload` requirement. Historical objects may lack a tool name;
do not assume every non-null payload has `tool`. `display_role` is often simply
`Tool`, so it is not a reliable tool identifier.

`presentation` is a rendering hint, not an authorization/action contract. Request
IDs come from request evidence, proposal IDs from proposal evidence, and handoff
IDs from handoff evidence. They can be null even when the kind is known. Pending
calls use `status: "pending"`; persisted rows use whatever status was recorded,
otherwise null. Null does not mean approved, succeeded, or safe to act on.
Terminal/generic IDs are currently always null. Status is not one universal enum
shared by all tools; retain tool-specific contracts for interactive actions.

No new search/read/browser kind is needed for this release. Native can specialize
generic rendering by tool name. Adding kinds later is possible; clients should
retain a generic fallback for unknown kinds.

## 3. Historical rows and removal of old parsing

**Yes: old stored rows are projected when served by the new backend.** The shared
serializer is used for paged messages, `/open`, reconciliation, and canonical SSE
message objects. This is read-time conversion; stored content/model replay is not
rewritten by a migration.

For a tool row, the serializer first accepts an object parsed from stored content.
Otherwise, when metadata has a string `tool`, it extracts a payload from metadata
while retaining service timing/model/path metadata. With neither source available,
it returns `tool_payload: null`, generic presentation with null ID/status, and the
original content. Valid JSON arrays/scalars are not treated as tool payload objects.
An object without a tool name remains an object; the server does not manufacture
a name. Non-tool rows keep their existing content and need not have either new field.

For responses from the new service, delete the client fallback that parses tool
JSON from `content` or copies it out of metadata. Keep plain-text rendering for
null payloads, unknown-kind fallback, and tool-specific decoding of `tool_payload`.
Do not accidentally remove unrelated model-context block decoding.

That does **not** automatically cover old on-device cached response objects or an
old service. Invalidate/version the transcript cache at cutover, or migrate it
locally once. A client released before backend cutover needs the explicit rollout
strategy below before it can remove old-server parsing entirely.

Source: [message-view.ts](../../service/src/agent/message-view.ts),
[message-loader.ts](../../service/src/routes/threads/message-loader.ts),
[transcript-events.ts](../../service/src/agent/transcript-events.ts).

## 4. Optional resources and agent-state cost

| Need | Existing endpoint | Guidance |
|---|---|---|
| Initial transcript and execution state | `GET /api/threads/:thread_id/open?limit=100` | Use as the initial load; attach the agent stream with its cursor |
| Context budget | `GET /api/threads/:thread_id/agent/state` → `context_budget` | Load separately when needed; no new dedicated cheap budget endpoint was added |
| Full model-context inspector | `GET /api/threads/:thread_id/model-context` → `context_budget` plus reconstructed messages/tools | Diagnostic view; not a cheaper budget fetch |
| Attached proxied web view | `GET /api/threads/:thread_id/web-view` → `{web_view: object|null}` | Fetch when opening that feature; an unattached view returns null |
| Browser inventory/state | Existing `GET /api/threads/:thread_id/browser-state` and its browser state protocol | Separate from proxied web view; retain the browser handoff's native authentication/stream contracts |

The routes retain authentication and ownership checks. An omission in `/open` is
not evidence that an attachment, browser session, or budget does not exist.

**Standalone `/agent/state` retains potentially expensive work.** With an active
runtime budget it reuses that snapshot; otherwise it reconstructs context with
the environment and tool catalog. It also reads durable invocation/pending-request
inventories. `/open` skips budget reconstruction, but still reads environment and
those inventories; it is not a zero-query runtime snapshot. Some state-loader
queries remain sequential. There is no measured latency guarantee for either route.

Do not immediately fetch `/agent/state` on every open solely to replace fields
already in `agent_state`. Fetch budget off the critical rendering path when the
UI needs it. Keep the existing pending-inventory recovery mechanism where required;
this work did not make all non-message inventories event-driven. A separate budget
endpoint or query parallelization could improve this later if measurement justifies
it; neither is part of the current contract.

Sources: [state-loader.ts](../../service/src/routes/threads/state-loader.ts),
[agent.ts](../../service/src/routes/threads/agent.ts),
[model-context.ts](../../service/src/routes/threads/model-context.ts),
[proxied-sites.ts](../../service/src/routes/proxied-sites.ts).

## 5. Release mechanics and the installed-build gap

**The mobile build number is not assigned in this repository or handoff.** Service
commit `65a1be7` identifies the reviewed implementation, not an iOS build. The mobile
release owner must record the marketing version and build number, distribution
channel and availability before cutover. Adam confirmed on 2026-10-01 that the
product is not live and all Buds and mobile clients can be upgraded in sync.
Fleet coordination is therefore resolved; the exact mobile version/build remains
a release-record field to fill in, not a reason to introduce compatibility code.

“Deploy together” is insufficient if old installed apps remain in use. The PR has
breaking tool/list contracts and removes the old per-Bud list stream. It does not
implement a minimum-client-version gate, an upgrade screen for already installed
apps, or an old-contract compatibility layer. An old app may fail on the new API;
we must not imply it will receive a clean upgrade prompt automatically.

Use the confirmed coordinated pre-launch upgrade:

1. Keep PR #139 unmerged while the mobile team builds and tests the matching app
   against a matching test service, including the new fixtures and restart recovery.
2. Choose the exact build and make it available to every current user before
   scheduling cutover. All installed clients are included in the coordinated upgrade.
3. Use an agreed cutover window: stop client use,
   drain service work, apply `0048_lush_timeslip.sql` and
   `0049_thread_change_publication.sql` with `pnpm db:migrate`, merge/deploy the
   matching service and web, install the matching mobile build, then resume use
   after smoke checks. The trigger change means migration execution itself belongs
   in that window. Service auto-deploy on merge must be accounted for explicitly.
4. Validate OAuth discovery, open/replay, all interactive cards, list paging/feed,
   atomic create/retry, mark-read and reconnect on a real device. No daemon upgrade
   is needed. Preserve receipts and admitted work if rollback is required; restore
   matching clients and the prior trigger when rolling back the list implementation.

This accepts a bounded period of unavailability, rather than pretending a new-only
mobile build will also work against the old backend. Single-instance production
makes coordination simpler but does not eliminate the installed-client gap.

No legacy API bridge, dual parser for old servers, or minimum-version gate is
required for this confirmed release scope. Update/invalidate old mobile transcript
caches during the app upgrade. All Buds may be upgraded as part of the coordinated
release, but this backend API change does not require a new daemon version.
If the all-clients-upgrade assumption changes, revisit rollout before merging;
do not silently accept mixed incompatible versions.

This document records the release procedure, not deployment authorization or a
completed rollout. No mobile build, migration or production deployment was
performed for this handoff.
