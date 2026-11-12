# connected-apps

`settings.tsx` renders the signed-in user's direct Google Calendar connection. It uses the shared
cookie-aware transport and is remounted by owner ID from account settings. Reads
abort on unmount; mutations never retry automatically. The service alone resolves
ownership and stores OAuth tokens. Browser state contains connection IDs/status,
Google account email, Calendar access and a short-lived consent URL, never credentials.

Connect navigates to the service-provided authorization URL. Google sign-in remains
separate from Calendar consent. Partial consent requests reconnection. Gmail and
Drive are not advertised until their tools are implemented. Disconnect removes Bud's saved credential;
upstream Google grants can be removed through Google Account settings.

Dependencies: React, shared Button, `apiFetchJson`, `apiFetch`.

`calendar-connect-request.ts` recognizes only structured Google tool results with
the fixed google_calendar provider and server-stamped thread ID; message content
cannot invent a consent card. The work projector keeps these results outside
collapsed work even after final/reload.

`calendar-connect-card.tsx` renders inline consent in ChatTimeline, remounted by
viewer/thread identity. Mount and focus read current owner-scoped inventory;
Connect explicitly POSTs `{ thread_id }` before navigating to Google's URL.
Reads and navigation are abort-fenced on account/thread change or unmount, and
double clicks cannot start duplicate flows. Callback status is explanatory only;
connected status requires a fresh inventory read. Users send a new message to
continue after consent; the card never resumes/replays Calendar writes.

`calendar-connect-card.test.tsx` covers mounted timeline placement, explicit
click/body/navigation, failed/canceled consent recovery, authoritative connection
status, malformed payloads and obsolete owner/thread requests. A disposable
Chrome preview verified the visible card without altering the real account.
