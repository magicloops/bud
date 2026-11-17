# Plan: Connect Google Calendar from chat

## Objective

Calendar listing now works with the user's real connected Google account. When a
Calendar request needs a connection or renewed consent, show an actionable card in
the conversation. A human clicks Connect, completes Google consent and returns to
the same chat. Settings remains available for managing the connection.

## Design and ownership

- Existing Google discovery/call results carry a server-generated
  `connect_request { provider: google_calendar, thread_id }` when connection is
  required. No OAuth state, URLs or credentials enter the transcript/model.
- Chat renders this result outside collapsed work, checks the current connection,
  and starts OAuth only on the user's click. It displays current success/failure
  and reconnect states; a new chat message continues the original request.
- POST /api/google/connect accepts optional thread_id, resolves the cookie viewer
  and trusted Origin, and authorizes the thread/Bud before beginning OAuth.
- Bind the return thread to the existing encrypted, session/state-bound flow.
  Callback reauthorizes the thread and derives a same-origin route from database
  IDs. No arbitrary return URLs or new database columns. Consent denial/partial
  consent return to the same authorized chat; invalid state falls back to Settings.
- Connection ownership remains the Bud user, even when the Google email differs.
  Existing message/connection owner stamping and transcript authorization apply.
  No new rows, autonomous grants, action replay or automatic writes after consent.

## Specs / contracts

Update google, connected-apps, workbench and threads specs, OAuth setup docs and
auth validation checklist. Document the Google tool payload and connect body in
docs/google-calendar.md; these use the existing opaque tool_payload contract,
with no SSE event shape or daemon protocol changes. Service and web
ship together; no daemon upgrade or schema migration.

## Validation

- Owned/foreign/deleted thread, Origin, same-session state/replay, settings default,
  callback success/denial/partial consent, return context across service restart.
- Disconnected/revoked agent tools expose the card; connected/disabled-API and
  foreign/automation calls do not invent consent or leak another owner's state.
- Mounted chat card renders outside collapsed work, POSTs only after click,
  handles failures/connected state and fences late responses after owner/unmount.
- Service/web build and focused regressions. Verify local chat presentation without
  disconnecting the user's real Google account or approving fresh Google consent.

## Results

Implemented and validated: 13 Google tests (isolated DB enabled), 5 mounted chat
tests and 27 projection/streaming regressions pass. Service typecheck and web
production build pass. A disposable Chrome fixture verified the actual timeline
card; the running service remains ready. No real account was disconnected and no
Calendar event was changed. Real disconnected-account consent remains user testing.
