# connected-apps

Owner-scoped Google Calendar, Gmail and Drive consent in Settings and chat. Cookie-aware
transport resolves the viewer on the service; OAuth credentials never enter the
browser. The service authorizes connection and originating-thread ownership.
Components remount on owner/thread/service/access changes and abort obsolete
requests. Dependencies: React, lucide-react, shared Button and transport.

- `google-services.ts` defines service labels, exact requested read/full access
  and effective access levels (`none`, `read_only`, `read_write`). Readiness uses
  the server's effective access, which combines Google scopes with explicitly
  enabled Bud access; retained upstream scopes cannot reactivate a revoked
  service. Access to one service never implies access to another.
- `settings.tsx` shows one row per service with No access / Read access / Full
  access and the connected email. Connect and Enable full access request
  `selections: [{service, access: 'read_write'}]`. Revoke access DELETEs only
  `/api/google/connection/:id/services/:service`, updates that row immediately on
  success and refreshes inventory. Stored access remains revocable when the
  connection needs reauthentication or OAuth setup is unavailable.
  Help distinguishes immediate Bud disablement from removing Google's upstream
  grant. Inventory refreshes on mount/focus; mutations serialize and never retry
  automatically. `recovery_required` inventory rows show retained account email,
  direct reconnect guidance and Clear saved connection through the owner-scoped
  connection DELETE. Clearing is available without OAuth setup, abort-fenced on
  owner changes, and removes the stale row before refreshing inventory.
- `google-connect-request.ts` recognizes structured Google tool evidence with
  provider, server-stamped thread ID and explicit `access`. Missing or invalid
  access and ordinary chat text cannot invent a consent card.
- `google-connect-card.tsx` renders **Read <service>** or **Full <service> access**
  for exactly the task's requirement. There is no permission picker. One
  Connect/Upgrade click POSTs that service/access plus `thread_id`, then navigates
  to Google's returned URL. Read access requires an upgrade for write tasks;
  existing full access satisfies a read task. Duplicate clicks and stale
  navigation are fenced. Callback URL status explains consent but is never proof
  of access. Users send a message after consent to continue; connecting does not
  automatically replay a write. An unusable saved connection adds a short
  reconnect notice; the same exact-access consent click recovers it without
  requiring a Settings detour or a separate clear step.
- `google-connect-card.test.tsx` mounts chat and Settings for exact read/full
  request bodies, top-level timeline placement, effective access, upgrades,
  per-service revocation, unreadable-credential recovery/clearing, failure recovery
  and owner/thread/access/service races.

One Google account per Bud user can differ from the Bud login. Consent remains
separate from Google sign-in. Setup is documented in
[Google services](../../../../docs/google-services.md).
