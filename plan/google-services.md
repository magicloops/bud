# Plan: Gmail and Google Drive access

## Objective

Extend direct Google OAuth on `prashanth/googleservices` with full Gmail workflows
(search/read, drafts, send/reply, labels/trash) and existing-Drive read/write.
Keep Calendar working and expose service-specific consent in chat and Settings.
Requested future commit title: `feat: add google drive & gmail access`.

## Design and ownership

- Reuse the owned `google_connection` row, encrypted token storage, callback and
  Google OAuth client. Add incremental service-scoped consent with encrypted
  requested-service/return-thread context. Canceling or denying extra permissions
  preserves the prior grant; expanding access cannot silently change accounts.
- Browser inventory/connect/disconnect resolves the cookie viewer before SQL;
  mutations require trusted Origin. Chat destinations reauthorize thread and Bud.
  Connections remain user-owned with owner/tenant stamps; no new table required.
- Generalize the service-owned tool catalog and bounded Google transport. URLs,
  MIME bodies, `users/me`, scopes and account choice are constructed server-side.
  Gmail uses gmail.modify; Drive uses drive; Calendar retains its current scopes.
- Gmail tools search/read messages and threads, manage drafts, send/reply, and
  manage labels/trash. Drive tools search/read/export, create/upload/update/copy
  files and folders, and trash/restore. File content is bounded; binary content
  never renders as terminal text. Sharing and permanent deletion are out of scope.
- Keep human invocation/lease/ownership checks before dispatch and evidence.
  No automatic retries of sends/uploads/writes or actions after OAuth consent.
  Email bodies and file contents are untrusted data. Tools cannot access a foreign
  connection, arbitrary remote URL, local path, or credentials.
- The current main checkout does not contain the separate file-library feature;
  this implementation must not import that unmerged branch as a hidden dependency.

## Specs and contracts

Update [Google](../service/src/google/google.spec.md),
[connected apps](../web/src/features/connected-apps/connected-apps.spec.md),
workbench/threads/agent specs, setup docs, and auth validation checklist.
Use existing tool_payload envelopes with service-specific consent evidence;
no daemon protocol changes. Preserve existing persisted Calendar cards.

## Validation

Synthetic Google transport and isolated PostgreSQL cover incremental grants,
cancel/partial consent, wrong account, owner/Origin/state/return-thread checks,
refresh, disconnect races and dispatch scope gates. Test MIME header injection,
Unicode/replies, content bounds, tool schemas, paging and uncertain writes.
Mounted UI tests cover each consent card and stale viewer/thread responses.
Run service/web builds and focused regressions. No real mail is sent and no real
Drive file is changed during automated validation.

## Rollout

Deploy matching service/web builds after Calendar migration 0067. Reuse existing
Render callback and encryption key. Google Cloud owner enables Gmail API and
Drive API and declares new scopes; users explicitly consent to each service.
Restricted-scope verification/security assessment is a public-release concern.
No commit, push, PR, merge or hosted configuration change without user approval.

## Implementation status

Implemented service-scoped consent, Gmail/Drive catalogs, shared Settings and
in-chat cards. Updated specs, auth validation and Google Cloud handoff documentation.
52 backend and 31 web focused tests pass; both builds pass. No schema change.
File transfer and native-file edit limits are explicit in docs/google-services.md.
Real consent/send/file mutation acceptance is pending user testing. No commit,
push, PR, merge, cloud dashboard change or deployment was performed.

Local service readiness and anonymous 401 confirmed. Started Vite on port 5173
and verified all three connection cards on signed-in Settings, retaining Calendar.
