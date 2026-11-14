# Gmail and Google Drive access

This extends [Calendar](./google-calendar.md) using the same Google OAuth client,
callback, encrypted connection row and human-chat tools. No MCP server, bucket,
new environment variables, dependencies or migration are needed beyond Calendar's
`0070_google_connections.sql`. Deploy the matching service and web builds together;
no daemon upgrade is needed. The daemon can be offline for these Google tools.

## What the Google Cloud project owner needs to do

In the same project that owns the existing `GOOGLE_CLIENT_ID`:

1. Open **APIs & Services → Library**. Enable **Gmail API** (`gmail.googleapis.com`)
   and **Google Drive API** (`drive.googleapis.com`) if not already enabled.
   Keep Google Calendar API enabled.
2. Open **Google Auth Platform → Data Access → Add or remove scopes**. Keep the
   Calendar/identity scopes and add:
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/gmail.readonly` (task read access)
   - `https://www.googleapis.com/auth/drive.readonly` (task read access)
3. While the app is in **Testing**, put each connecting Google account under
   **Audience → Test users**. The connected account may differ from Bud login.
4. Reuse the existing Web OAuth client and exact callbacks:
   `http://localhost:5173/api/google/callback` locally and
   `https://app.bud.dev/api/google/callback` for the current hosted environment.
   If these were registered for Calendar, no new redirect URI is needed. Keep
   `/api/auth/callback/google` for Bud sign-in too.

Read tasks request read-only access; tasks that write request full access. Settings
Connect requests full access for the selected service. Users explicitly connect
Gmail and Drive in Bud. API enablement alone does
not upgrade an existing Calendar grant. Bud requests the selected services and access levels together, using Google's
incremental authorization for later additions. Canceling/denying extra consent
preserves the prior grant. Choosing a different Google account is rejected;
revoke every connected service first to deliberately switch the shared account.
A successful replacement grant may omit services previously removed in Google
Account permissions. Bud accepts the newly selected service and updates the
others to the access actually granted, without restoring locally revoked services.

The Gmail and Drive read-only and full-access scopes are **restricted**. A public external release requires Google's
applicable restricted-scope verification and, for server-stored/transmitted data,
security assessment unless an exemption applies. Test-user consent is development
validation, not public-launch clearance. Testing grants generally expire after
seven days. This branch does not change the Google Cloud or Render dashboards.

Sources: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[incremental OAuth](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth).

## Supported operations and limits

Gmail: search messages; read messages/threads; create/read/replace/send/delete
drafts; send new messages and replies; list/create/rename/delete user labels;
apply/remove message labels (archive, read/unread, star); trash and restore mail.
Sending uses server-built plain-text MIME with Unicode subjects/body and validated
reply headers. The connected account determines the sender; aliases/arbitrary raw
MIME are not accepted. Deleting a draft is permanent; mail deletion uses Trash.
Attachment metadata is visible, but attaching/downloading attachments is not yet
implemented. Draft replacement replaces the whole message, including attachments.

Drive: search existing My Drive/shared files, optionally within a shared drive;
read metadata; read text; export Google Docs/Slides as plain text and Sheets as
CSV (first sheet only); create folders; upload small files or import a Google Doc;
replace uploaded-file content; rename/describe/copy/move files; trash/restore.
PDF/image parsing, large/resumable transfers, native Docs/Sheets/Slides content
editing, sharing changes, and permanent deletion are outside this version.
Native-file metadata can still be edited, and native files can be copied.

Uploads accept UTF-8 or base64 content with a **24,000-byte decoded limit**.
No local Finder path, remote URL fetch, or dependency on the separate file-library
branch is introduced. Text exports expose at most 24,000 bytes; provider responses
over 1 MiB fail explicitly. Tool results cap at 32 KiB, requests at 64 KiB, lists at
25 items/page. Pagination/truncation must be checked before claiming completeness.
Large Gmail threads return valid JSON containing the newest messages that fit,
with explicit truncation/omission metadata and bounded omitted-message IDs for
follow-up reads using `gmail_get_message`.

Drive edits require the last-read `version`, checked by a fresh metadata read
before dispatch. This detects an already changed file; it is **not an atomic
compare-and-swap** with other Drive clients. Changes in the read/write interval
can still race. Native content replacement is rejected by that preflight.
Content replacement preserves the existing Drive media type unless a type is
explicitly supplied. Calendar retains its documented If-Match/etag behavior.
Unknown send/upload/write outcomes stop for review and are never automatically
retried. Review Gmail/Drive before trying the action again.
Temporary token-refresh failures preserve the saved connection and return a
retryable error. On an explicit API 401, Bud refreshes credentials and tries
once more after checking access and write preconditions. A repeated 401 or
invalid refresh grant prompts for consent.
The four-operation concurrency cap applies per Bud user, not across all users.

Sources: [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending),
[reply threading](https://developers.google.com/workspace/gmail/api/guides/threads),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads),
[Drive download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads),
[Drive file version](https://developers.google.com/workspace/drive/api/reference/rest/v3/files).

## Test locally

Start the service and web using the commands in the Calendar setup doc. Use a
test Google account added to the existing project's test users.

1. Ask “Search my Gmail for my five newest unread emails.” Connect Gmail from
   the card, return to the chat, and send “Continue.” Verify against Gmail.
2. Ask for a draft to your own test address, inspect it in Gmail, request an
   edit, then explicitly ask Bud to send that draft. Verify exactly one send.
3. Ask Bud to reply to that test email; verify threading and recipient. Label,
   archive, trash, then restore the test message. Check each change in Gmail.
4. Ask “Find my Drive files with Bud test in the name.” Connect Drive in chat.
   Ask to create a folder and a small `bud-test.txt` containing `hello`, read it,
   replace its contents, rename/move/copy it, then trash and restore the test file.
5. Read a Google Doc and a Sheet; check the displayed truncation/first-sheet limits.
6. While Calendar is already connected, cancel Gmail or Drive consent once;
   Calendar must still work. Restart the service and repeat reads. Settings shows
   each service independently with **Revoke access**; revoke Gmail and verify
   Calendar/Drive still work. Revoking the last connected service removes the shared credentials.

Use the same Google account for all three connections. Test emails/file writes
above are manual acceptance steps; automated tests send no real mail and mutate
no real Drive files. Public production acceptance remains separate.

## Browser and agent contract

`POST /api/google/connect` accepts
`{selections:[{service:"calendar"|"gmail"|"drive",access:"read_only"|"read_write"}],thread_id?}`.
Cookie viewer/Origin and owned return thread/Bud are resolved before consent.
Inventory exposes effective `access[service]` plus read/write booleans. Tokens,
service access and pending selection/return context stay encrypted; no new columns.
If credentials cannot be read, inventory still succeeds with no effective access,
`status:"reconnect_required"` and `recovery_required:true`. Settings offers fresh
consent or **Clear saved connection** using the existing account DELETE endpoint.

`google_search_tools` accepts `service`, task-required `access` and `query`.
`google_call` executes only reviewed server-defined tools; the connection boundary
checks the operation's required access against both selected access and actual scopes.
A missing grant returns `connect_request` with provider `google_calendar`,
`google_gmail` or `google_drive`, the owned thread ID and exact required `access`.
When chat is opened on a native client, Bud can provide the web URL of the same
chat. Sign in there, use the card, then return to the phone to continue.
The card requires an explicit click. Callback status is advisory: clients verify
the effective grant from inventory. Consent never resumes a write automatically.

Settings offers per-service **Revoke access**, backed by
`DELETE /api/google/connection/:connection_id/services/:service`. This disables
that service in Bud and invalidates pending consent; other services remain usable.
It does not revoke individual upstream Google scopes. Last-service revoke or
account-wide disconnect removes saved credentials. Reconnect must be explicit.

Connections and transcript evidence remain owner-scoped. Content is untrusted
data supplied to the selected model, never authority to send mail or modify files.
There is no per-action approval layer. User requests govern actions after consent;
unknown write outcomes retain the existing stop-and-inspect behavior. See
[Calendar API and ownership](./google-calendar.md) and the
[combined implementation plan](../plan/google-task-access.md).
