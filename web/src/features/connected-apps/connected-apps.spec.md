# connected-apps

Owner-scoped Google Calendar consent, policy controls and write reviews in
Settings and chat. Cookie-aware transport resolves the viewer on the service;
OAuth credentials never enter browser state. The service authorizes each
connection and approval against the signed-in owner and originating thread.
Components remount on owner/thread identity changes and abort obsolete requests.
Dependencies: React, lucide-react, shared Button and transport.

- `google-services.ts` defines service labels, read/write access selection,
  actual Google grant flags and Bud write-policy inventory. Access to one service
  never implies access to another.
- `settings.tsx` offers one Connect Google form for selected services, defaulting
  each to **Allow changes, ask first** with optional read-only consent. One POST
  sends `selections: [{service, access}]`. Existing connections expose **Block
  changes** / **Ask before changes** through a policy PATCH without OAuth. A
  read-only Google grant needs additional consent before enabling changes.
  Blocking is enforced by Bud and retains Google's grant; the global
  `writes_enabled` flag disables all changes and is shown as an admin setting.
  Selecting read-only cannot remove prior Google grants; help explains revoking
  Bud in Google Account before reconnecting. One Disconnect Google removes all
  saved Google access. Mount/focus inventory reads are authoritative.
- `google-connect-request.ts` recognizes structured Google tool evidence and a
  server-stamped thread ID, including `write_required` for a consent upgrade.
  Ordinary message text cannot invent a consent card.
- `google-connect-card.tsx` provides matching inline consent and read-only/write
  selection. Explicit clicks POST selections plus `thread_id`, then navigate to
  the returned authorization URL. Duplicate clicks and stale navigation are
  fenced. Callback URL status is explanatory, never proof of a grant. Users send
  a message after OAuth to continue; consent itself does not replay a write.
- `google-approval-request.ts` validates public approval views in pending
  `google_call` arguments and persisted Google tool `approval_request` payloads.
- `google-approval-card.tsx` fetches owner/thread-validated status before showing
  private proposal details or enabling decisions. It shows account, complete
  untruncated arguments and full structured proposal details. Approval/rejection
  uses a single decision POST, with no automatic retries; focus, canonical status
  changes and expiry refresh the authoritative view. Account changes clear old
  details immediately. Approval authorizes one attempt and does not claim write
  success; the durable service resumes the action automatically. A draft-send
  review explains replacement of saved content and removal of attachments.
- `google-connect-card.test.tsx` mounts chat, Settings and approval cards to cover
  consent selection, policy toggles, global disable, exact proposal content,
  duplicate decisions, expiry, request failures and owner/thread races. It also
  verifies durable recovery, canonical precedence and top-level timeline cards.

One Google account per Bud user can differ from the Bud login. Adding permissions
preserves working services when consent is canceled. Google sign-in remains
separate from service consent. Setup and migration details live in
[Google write approvals](../../../../docs/google-write-approvals.md).
