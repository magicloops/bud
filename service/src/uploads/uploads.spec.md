# User file uploads

Private, immutable user-owned originals independent of a Bud or chat. The viewer
is resolved by `requireViewer` before upload/read/delete. Repository queries
include `created_by_user_id`; foreign IDs return 404, anonymous requests 401.
`user_file` stamps the viewer and includes nullable `tenant_id`. Chat messages
inherit the owning thread and keep attachment references in existing metadata.

## Files

- `contracts.ts`: strict IDs, names, MIME types and size limits.
- `schema.ts`: re-exports the canonical Drizzle table from db/schema.ts.
- `objects.ts`: immutable originals on private disk; production mount validation,
  streaming size/SHA-256 verification, atomic publication, capacity reservations,
  safe ID paths and temporary-file cleanup.
- `objects.test.ts`: production configuration/mount rejection, atomic visibility,
  permissions, reopen persistence, interruption, disk capacity and staging cleanup.
- `repository.ts`: owner SQL, serialized quota reservations, upload state CAS,
  attachment admission, extraction cache and deletion.
- `routes.ts`: authenticated REST, cookie Origin enforcement, streaming upload
  concurrency/time bounds and expired/failed/deleted object cleanup; storage is
  validated at registration before the service starts listening.
- `documents.ts` / `document-worker.mjs`: at most two short-lived PDF/DOCX/text
  extraction or image/PDF rendering workers; 20s timeout, 192MiB V8 heap, 200 pages,
  1M extracted characters. Native allocations are not an OS memory sandbox.
- `agent.ts`: files_read, current thread/Bud/invocation authorization,
  bounded excerpts, untrusted-document labeling and provider-only page hydration.
- `page-references.ts`: shared newest-two-page selection for hydration, context
  token estimates and invalidation of measured request baselines.
- `browser-files.ts`: 30-second single-use transfer grants, revoked at dispatch
  completion; current invocation/browser evidence checks before/after byte reads.
- `uploads.test.ts`: storage, PDF, owner isolation, current-chat agent scope,
  deletion, grants/replay and image-accounting fixtures (DB opt-in).

## HTTP contracts

- POST `/api/uploads`: `{name,mime_type,size_bytes}` reserves an immutable ID.
- PUT `/api/uploads/:file_id/content`: octet-stream, exact declared byte count;
  only pending uploads can start. Ready replies contain attachment metadata.
- GET `/api/uploads/:file_id`: ready metadata.
- GET `/api/uploads/:file_id/content`: authorized original attachment download.
- DELETE `/api/uploads/:file_id`: durable revocation, extraction removal and
  best-effort object deletion, retried by cleanup. Transcript excerpts remain.
- GET `/api/uploads/browser-transfer`: one-use private Bearer grant; no public
  URL credentials. It is a daemon transfer, not an authenticated user read.

Attachment metadata is `{file_id,name,mime_type,size_bytes}`. Limits: 25MiB/file,
10 files/100MiB per message, 1GiB/1000 ready or recent pending files per user.
Incomplete uploads expire after one hour. Removing a composer chip only detaches.

## Agent and browser flow

`files_read` lists current attachments or reads an owned ID attached to this
conversation, with 16,000-character excerpts
and explicit coverage warnings. PDFs with empty text require visual inspection.
Page JPEG bytes are inserted only at the provider boundary, at most two recent
pages, and never in transcript/ledger diagnostics. Text-only models receive an
explicit unavailable notice. Original bytes are always retained unchanged.

`browser_exec.file_ids` selects originals for a single cell. `tab.fileInputs()`
returns exact input/observation identities. `uploads.attach(target_id,reference,
observation_id,file_id)` downloads the authorized original to a private daemon
worker directory, verifies size/hash and invokes the guarded native set_files
operation. Credentials stay in an injected closure outside model arguments and
receipts. Worker cleanup removes staging even on interruption. Selecting a file
may trigger website upload handlers; it never clicks Submit. Hidden inputs and
iframes work; directories and stale/replaced inputs fail without retargeting.

## Storage and rollout

Development defaults to `service/.bud-data/files` when launched from service/;
`FILE_STORAGE_DIRECTORY` overrides it. Production requires explicit absolute
`FILE_STORAGE_MOUNT_PATH` and `FILE_STORAGE_DIRECTORY`, with the directory strictly
inside the mount. Startup and subsequent operations verify a writable Linux mount
through `/proc/self/mountinfo`; root/overlay/tmpfs/ramfs storage and symlinked
production paths are rejected. There is no production fallback to temporary disk.

The Render Blueprint declares one backend instance and a 10 GB disk at `/var/data`,
with originals at `/var/data/uploads`. It pins service Node to 22.23.2 (PDF.js needs
^22.13 or >=24). No S3 dependency, account or bucket credentials are required.
This configuration has not been provisioned/deployed by this task.

The upload directory is service-owned with mode 0700; files are 0600. Originals
are streamed once into private `.upload-<UUID>` staging on the same volume,
length/hash checked and fsynced, then hard-linked atomically to a validated file
ID without overwrite. Directory sync precedes a successful receipt. Failures
remove staging; hourly checks expire abandoned staging older than one hour.
Disk capacity reservations include concurrent writes and preserve 256 MiB free;
full/quota errors return `file_storage_full` (507), with no ready DB record.
File permissions and owner-authorized service routes remain the access boundary;
the volume is never served as static assets.

Render disks prevent multiple backend instances and cause brief deployment
downtime. Monitor disk usage and increase disk size before capacity is exhausted.
Daily disk snapshots and PostgreSQL backups are independent: restore only during
a coordinated maintenance window, reconcile file IDs/hashes against metadata,
and preserve deletion revocations. Deleting a live file does not erase copies in
older backups. Existing local development files are not automatically migrated.
See [Render disk operations](https://render.com/docs/disks).

Apply generated migrations 0053/0054 before service startup. Coordinated upgrade:
matching service/web and rebuilt daemon/helper; old helpers reject the new local
REPL operations. Existing WebSocket envelopes and capability fields are unchanged;
there is no compatibility upload path. See [plan](../../../plan/browser-file-library.md)
and [validation](../../../debug/browser-file-uploads.md).
