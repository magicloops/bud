# Private viewer recovery across service restart

Preserve the already authorized mounted viewer, not the expired in-memory lease.
Successful acquire/renew/recover replies include a ten-minute HMAC-signed recovery
ticket, bound to owner, authenticated session plus viewer UUID, browser ID,
generation, daemon boot and control epoch. Derive a domain-specific signing key
from the existing persistent Better Auth secret. Keep the ticket in viewer memory,
never URLs, logs, transcript, localStorage or agent tools.

The existing authenticated, Origin-checked control POST accepts `recover` with
the ticket. Resolve owner-scoped state before checking it. Reject different
viewers, expired/tampered tickets, ended/replaced sessions and epochs advanced by
explicit release/return/takeover. A valid ticket can acquire a fresh private lease
using the existing daemon pause/acquire acknowledgement, without navigation,
input replay or agent continuation. An already restored lease recognizes the same
ticket to tolerate a lost response without repeating transitions. Never displace
a different live controller.

The mounted viewer clears queued input on loss but retains its recovery ticket
for transport/lease failure. Retry recovery through the existing three-second
metadata poll once the same daemon is available. Input/resize uncertainty and
explicit control actions discard it. Unmount/sign-out discards it; new tabs or
reloads use explicit takeover. Recovery failure preserves private state and shows
manual recovery. Older services omit tickets and retain explicit takeover.

No DB migration or daemon protocol change; existing pause/acquire commands provide
the privacy fence. `private_content` stays true until explicit return. Owner/auth
session validation precedes all state access. Full effect needs new service/web
and a stable Better Auth secret across service restarts.

Validate ticket binding/expiry/rotation, fresh coordinator recovery, duplicate
recovery, conflict with another viewer, return/release invalidation, late polling
and renewal replies, no automatic return or input replay, and unmount cleanup.
