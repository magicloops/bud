# Phase 3j: Preserve agent viewer connections across turns

Status: **Implemented locally; manual acceptance pending.**

## Objective and evidence

Keep the passive browser viewer connected across agent turns. In thread
`918cfc7f-18c9-4315-8e5f-83d848a5a748`, agent epochs 2→3→4 unnecessarily revoked
media, producing approximately 0.5s and 3.1s gaps while Chrome remained alive.
See [investigation](../../debug/reddit-clicks-and-viewer-disconnects.md).

The user explicitly confirmed that this browser feature is not live and does not
need backward compatibility. Continuity is the default passive-media contract:
no new capability, attach opt-in, metadata flag or legacy branch.
This exception applies to this browser feature, not unrelated deployed contracts.

Related specs: [daemon](../../bud/src/browser/browser.spec.md),
[service](../../service/src/browser/browser.spec.md),
[web](../../web/src/features/browser/browser.spec.md),
[protocol](../../docs/proto.md).

## Implementation

1. Daemon passive attachments capture one local monotonic media-fence revision.
   Agent epoch advancement leaves it unchanged. Pause and control/privacy
   transitions invalidate it, including takeover→return between checks. Initial
   admission still validates the current epoch. Idle, pre/post-lock and delivery
   checks preserve connection, generation and private-content boundaries.
2. Service passive groups use session/generation and the current carrier binding,
   without invocation epoch in their key. Private groups remain exact-epoch and
   controller-bound. Sizing uses the same group lookup. Authentication, owned
   session and carrier checks still run during idle and delivery; control fences
   close groups/tickets immediately. Late authorization cannot deliver afterward.
3. Web agent-only epoch changes preserve the canvas/socket. Privacy, generation,
   permission, explicit reconnect and network failure still clear/reconnect.
   Viewport fitting retains current epoch cancellation and command checks.

The revision is only local revocation memory, not a durable lifecycle. Existing
operation refresh, dirty bit, frame credit and heartbeat behavior remain unchanged.
In-flight capture drains under existing bounds and revoked results are discarded.
Agent commands, references and private input retain their existing fencing.

## Ownership and impacted contracts

Resource remains the owner/thread/Bud-bound browser session. Existing authenticated
routes resolve the acting viewer and authorize before metadata/attachment. Idle and
delivery recheck ownership. No new resource, route, row stamping, DB migration,
SSE event or provider payload. There are no new wire fields; passive-media lifetime
semantics change in daemon, service and web together for local development.

## Edge cases and validation

- Repeated agent turns preserve sockets and canvas; stale commands still reject.
- First/new/slow viewers retain bounded credit and sizing arbitration.
- Takeover during capture or awaited authorization fences delivery. A rapid return
  cannot revive an attachment created before private control.
- Lease expiry, explicit pause, disconnect, session close and generation change
  retain revocation; private renewal/input/return behavior remains unchanged.
- Sign-out, other owners, deleted threads and unclaimed Buds cannot retain access.
- Fit cancellation follows current command authority even when media survives.

Automated daemon authority, live Chrome media, relay race and mounted web tests
cover these boundaries. Remaining manual acceptance: repeat agent follow-ups and
verify unchanged connection IDs, then takeover/return and confirm new connections;
repeat two-account revocation and in-flight private capture checks.

## Won't-dos

- No backward-compatibility negotiation or old-version fallback for Phase 3j.
- No removal of command epochs, ownership checks, private leases or privacy fences.
- No new queue, durable media record, polling loop, heartbeat or retry system.
- No retaining pixels across actual revocation/network failure.
- No forced Reddit clicks, CAPTCHA changes, SSE network investigation or WebRTC.
- No broad viewer refactor or removal of unrelated capability gates in this patch.

## Delivery

Use updated service/web and rebuild/restart the local daemon. No migration.
Keep current diagnostics through manual acceptance; cleanup is a separate task.
Daemon/service/web specs, protocol and auth validation checklist are updated.
