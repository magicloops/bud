# uploads

User-owned immutable originals, separate from the daemon file viewer.
`attachments.tsx` owns composer upload state, retry/removal and transcript download
cards. Requests use the shared authenticated transport; IDs are authorized again
on the service. Local files upload through `/api/uploads`, then the composer sends
only verified file IDs with its message. Failed sends preserve the selection.
Removing a chip detaches it, without deleting the saved original.

The reusable library UI is the second stacked PR; originals are durable already.
