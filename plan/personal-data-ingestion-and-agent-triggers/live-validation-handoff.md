# Live development validation handoff

Status: reconciled September 7, 2026. Happy paths have partial user validation;
the complete scenarios below remain open. See [current evidence](progress-checklist.md).
Use with [phase 8](phase-8-validation-and-rollout.md) and the full
[validation matrix](validation-checklist.md). This guide makes the next manual
session concrete; it does not replace device failure injection or rollout gates.

## Ready locally

- Recheck service readiness before testing; historical process IDs are not current state.
- Local configuration enables durable invocations, automations, activation reviews,
  existing-contact reviews and app-key requests. Product defaults remain off.
- Expanded Contacts capability requires the deployed grant-field schema at startup.
- Backend regression: 151 selected tests pass; prior complete TimelineCore suite: 31 pass, including
  capability HTTP and orphan-batch recovery tests. Web/service builds pass.
- Migrations span `0024_true_luminals.sql` through `0036_magical_ken_ellis.sql`.
  Local evidence is in the phase docs; staging application is not verified.
- Selected target: `bud-dev`, GPT-5.6 Luna. Verify availability in the client.
- Existing user automations/data remain intact. New cases should use a distinctive
  `Validation` name and synthetic contacts; record the created rule/request IDs.

At 2026-09-07 04:28 UTC, the reconnected/unlocked physical iPhone was available
and the current Debug app (`chat.bud.app.local`) built and installed successfully.
Build log: `/tmp/bud-personal-data-device-ngrok-build.log`. Its built Info.plist
uses `https://b21325f57611.ngrok.app` for app/ingest origin and matching OAuth
issuer/audience; public OAuth discovery and local service readiness also passed.
Installation is not proof of signed-in ingestion or UI acceptance. Browser setup and desktop controls currently
fail before UI access; the user can perform the UI steps while backend observations
are collected. Do not extract browser sessions or bypass authentication to test.

## 1. Expanded collection and honest sync

1. Open mobile Settings → Data sources. Confirm the displayed account and that
   Collect Contacts is enabled with full iOS access for live addition detection.
2. Enable Include addresses and websites. The choice should save immediately.
   Agent/app access stays a separate setting; no new field grant is implied.
3. Tap Sync now. Observe capture, waiting for upload, processing and completion.
   The receipt must report expanded coverage only for an actual expanded scan.
4. Find a synthetic contact containing an international postal address and two
   website values in web Data sources. Inspect current fields and history.
5. Confirm enriching a previously imported contact caused no new live delivery.
   Add a new synthetic contact during the test and verify its normal eligibility.
6. Repeat Sync now without edits, then offline. Offline status must not claim a
   newly completed server publication; retained data must recover after reconnect.

Record scan ID, capture/receipt/publication timestamps and delivery counts, without
logging contact contents. Postal addresses must not be presented as observed
physical presence; website values must not execute or fetch automatically.
Cases: UX1–UX3, CF1–CF5, C1/C3/C4, Q1/Q2/Q5.

## 2. Agent-created automation and opposite-client review

In a new conversation on the selected Bud/model, send:

> Create a draft automation named Validation contact note. When a newly observed
> contact arrives, query its details and write a short note in a new conversation.
> Include available location evidence only if I have granted location access,
> label uncertainty, and limit it to 5 invocations per day. Request my review
> before enabling it. Do not process existing contacts.

The agent should create the draft and request activation through its tools,
without asking for internal identifiers. Open Automations on the other client,
review the exact model, instruction, permissions and limits, then explicitly
approve. Expect one active revision and one continuation in the requesting chat.

Add a uniquely named synthetic Apple contact, reopen Bud and Sync now for the
first deterministic run, then background mobile and close web. Inspect activity
later: exactly one invocation, compact Triggered by attribution, and one Stop
control only while appropriate. A completed run should not show a cancel action.

The instruction above intentionally overrides the new originating-chat default.
Repeat without a target instruction to verify the requesting chat is used, then
with an explicitly selected existing conversation, including when that
conversation already has work. Separately test decline and a changed draft/grant
before approval. They must not activate stale work. Cases: AM1–AM5, T2/T5/T7/T8,
UX4–UX6, A5/A7. Foreground-assisted sync does not prove suspended capture.

## 3. Existing-contact review

Ask the agent to propose processing at most three synthetic Validation contacts
with the active rule, in one batch, excluding contacts already delivered. It must
request a separate existing-contact review, not reactivate the rule.

Review on the opposite client. Record the frozen membership/count and receipt;
approve once, then reload/retry the same decision. Expect the same receipt and
no duplicate work. Repeat with no eligible matches: ordinary no-work result and
no pending review. Test cancel and an explicitly requested repeat separately.
Add a new contact while bootstrap proceeds and verify no skipped/duplicate action
across the snapshot boundary. Cases: AM6, T3/T4/T6, A5.

## 4. Agent-built private app and data permission

Ask the selected agent to build a private contact search/history dashboard on its
Bud and request a names-only query key for that app backend. The request should
open a durable user review; approve in the other client only after inspecting
its private destination and field/history limits.

Expect setup to complete without a raw key in chat, terminal logs or frontend
assets. Search must not match fields outside the granted set. Open the private
preview as the owner, then verify another signed-in account cannot access it.
Revoke in Data sources → App data access and verify the next query fails.
Repeat decline and an interrupted setup; no duplicate credential or unintended
continuation. Cases: K1–K8, Q1/Q2. The future viewer-authenticated broker is outside
this development slice.

## 5. Recovery and remaining acceptance

Run selected-Bud/model disconnect, reconnect and visible expiry; do not substitute
another model. Use the phase-8 controlled crash cases around terminal dispatch;
ambiguous outcomes must require review and retain the thread reservation. Do not
interrupt unrelated user work merely to run a fixture.

Complete account/environment switch and physical background/lock/kill/storage
cases in M1–M9 and C2/C7. Record both successful and failed conditions. Additional
required work includes the full private-key channel audit, mixed-version/rollback
proof, remote legacy inventory, deployment migration evidence and measurements.
Commits, PRs and deployment remain separate user decisions.

For each check, record the exact build, client/device state, steps, IDs, timestamps,
observed outcome and unresolved defects using the validation evidence template.
Passing this guide's happy paths alone does not close the full-plan gate.
