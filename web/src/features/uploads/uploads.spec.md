# Chat uploads and reusable file library

- `attachments.tsx`: composer upload/draft state, bounded sequential uploads,
  retry/cancel/removal, selection of saved IDs and authorized transcript downloads.
- `library.tsx`: accessible native dialog mounted in a portal; owner library
  search, cursor pagination, upload/attach controls and explicit deletion review.

The composer exposes **Attach files** and **Your files** for new/existing chats.
Attach files stays left; Your files sits at the right edge above Send, sharing
the same text styling, icon size and the composer's responsive control alignment.
Drag/drop uploads through authenticated `/api/uploads`; a saved selection reuses
its ID without another upload. Pending/failed uploads block send. Failed sends
keep files and text. Thread content remounts by authenticated owner/thread.
Removing a chip detaches only. Library deletion revokes access across chats and
removes a selected draft chip; existing transcript excerpts remain.
All reads/writes use the shared authenticated transport. The service resolves the
viewer and enforces owner SQL; no owner is sent by the UI.
