# Plan: Reusable files in chat and the Bud browser

## Status and decisions

- Branch: `browserfileupload`, based on `browserview` with both viewer fixes.
- User confirmed a reusable file library from the first version.
- No object-storage configuration was found in the checked-in deployment config
  or local service/web environment keys. This does not establish whether an
  unused bucket exists in the hosting account.
- User chose a Render persistent disk for production to avoid another storage
  provider. The same disk implementation serves local development.
- User confirmed Bud may search and reuse their library when relevant.
- Two stacked PRs: `browserfileupload` adds uploads, reading and browser attachment;
  the library PR adds search, selection, deletion UI and agent-wide library access.
  Both include the existing browserview fixes.
- Local implementation is ready for user testing. The live synthetic resume
  read/fill/browser attachment flow passed; fresh native-picker upload remains
  a manual acceptance step. See [validation results](../debug/browser-file-uploads.md).

## Context

The current branch has read-only access to files already on a Bud machine, but
no chat attachment library or browser file-input operation. The earlier upload
work is saved in `stash@{0}`. Its design made the daemon the durable file store,
used ephemeral service staging, and relied on terminal tools for document reading.
It also targeted the retired browser_act API. Reuse individually reviewed transfer,
input-targeting and fixture code where it fits; do not apply the stash wholesale.

The previous resume failure demonstrated that successful transfer is insufficient:
missing PDF parsers caused the agent to print binary PDF streams and then fail
transcript persistence. Document reading must be a first-class supported path.

Related specs:
- [Service files](../service/src/files/files.spec.md)
- [Database](../service/src/db/db.spec.md)
- [Thread routes](../service/src/routes/threads/threads.spec.md)
- [Agent](../service/src/agent/agent.spec.md)
- [Browser service](../service/src/browser/browser.spec.md)
- [Daemon browser](../bud/src/browser/browser.spec.md)
- [Browser helper](../bud/browser-helper/browser-helper.spec.md)
- [Web workbench](../web/src/components/workbench/workbench.spec.md)
- [Web thread state](../web/src/features/threads/threads.spec.md)

## Objective

A user uploads a resume once, selects it in a new or existing conversation, asks
Bud to use its information in an application, and sees the original resume attached
to the website's file input. The same file can be selected in another conversation.
Uploads remain available after a service restart and while the owning Bud is offline.

The upload operation selects a file; it does not itself submit an application.
Website change handlers may transmit the file immediately. Agent action rules and
the user's task authorization still govern the destination and subsequent actions.

## Storage and ownership

- Original bytes live on the backend's private Render persistent disk. Local
  development uses an ignored service data directory through the same interface.
- Postgres stores opaque file IDs, owner/tenant, original filename, safe display
  name, MIME type, verified size/hash, object key, upload/processing states and
  timestamps. Each uploaded original is immutable; replacing a resume creates a
  new file identity so old chats cannot silently attach different bytes.
- Message-file references associate the exact file with the canonical message.
  Removing a draft chip only detaches it. Deleting a chat removes its references,
  not the user's library file.
- Library deletion revokes future access and cleans original/derived/cache data.
  Historic messages show an unavailable attachment; prior conversation text is
  not represented as erased merely because its source file was deleted.
- Proposed initial bounds: 25 MiB/file, ten files/100 MiB per message, 1 GiB/user.
  Enforce quotas and actual received size on the service, not only in the UI.
- Pending/incomplete uploads expire; saved library files persist until deletion.

The authenticated viewer owns the library. Library list/search filters by owner in
SQL; file reads, writes and downloads resolve an owned file before accessing bytes.
Attachment admission resolves the owned Bud/thread and owned files before the
message/turn transaction. File and reference rows carry created_by_user_id and
tenant_id as required. Foreign resources return 404; unauthenticated requests 401.
No cross-user hash deduplication or global file inventory.

PR1 tools resolve current-thread attachments. PR2 expands access to the owning
user's library. Both resolve server-side invocation identity; model-supplied owner
IDs are never authority.

## Upload and chat flow

1. Paperclip menu offers Upload files and Choose from library; drag/drop also works.
2. Authenticated upload streams through the service into storage with bounded
   concurrency, size/hash validation, sanitized filenames and a durable receipt.
3. Composer chips show filename, progress, ready/error, retry and remove. Failed
   sends preserve both draft text and selected file IDs.
4. Sending atomically attaches validated IDs to the canonical message and admits
   the turn using the existing idempotency contract, including opening messages.
5. Transcript cards retain attachment identity and offer authorized preview/download.
6. Library supports listing/searching, choosing, uploading and deleting files.

Only metadata/references enter normal message JSON, SSE and tool descriptions;
binary/base64 payloads are retrieved separately when actually needed.

## Reading files

- Provide bounded, format-aware file reading with explicit coverage/page metadata.
- Prioritize PDF, DOCX, text and images for the resume use case. Other stored file
  types remain downloadable/attachable without claiming they were understood.
- Extract text from PDF/DOCX with bundled dependencies rather than assuming a
  machine has pdftotext, Python packages or office applications installed.
- Empty/partial PDF extraction must be explicit. Rendered-page/vision handling for
  scanned resumes must respect the selected model's image capability and budgets;
  an unreadable file cannot be described as fully read.
- Treat file contents as untrusted task data and preserve that boundary in context.
- File references survive context compaction so the agent can reread the source.
- Never dump binary file contents into terminal output or ordinary model text.

## Attaching to a website

- Extend the current browser_exec facade with file-input discovery and a bounded
  setFiles operation using opaque file IDs. Support hidden HTML inputs and iframes.
- Resolve file authority on the service and issue a short-lived transfer grant for
  the exact Bud/thread/invocation. Credentials and download grants stay outside
  model-visible output.
- Stage verified original bytes on the daemon in private directories using atomic
  writes, safe names, size/hash checks and bounded cache retention.
- Recheck current invocation, owned target/document and private-control fences
  before selecting files. Use the existing serialized browser action path.
- Select the actual local bytes in the exact observed file input. Respect multiple
  input restrictions and reject folder-upload requests in the first version.
- Return evidence of selected filenames/count; observe the site's accepted state
  before claiming success. Do not blindly retry an uncertain website upload.
- Cached daemon copies are disposable; the service's persistent disk remains the
  source of truth for original bytes.

## Implementation sequence

1. Confirm production storage setup separately from local testing.
2. Implement owned library schema/migration, storage, quota handling and routes.
3. Add library/composer/transcript UI and atomic attachment admission.
4. Add document reading and model-context integration.
5. Adapt transfer and browser input code to the current REPL and authority model.
6. Run an end-to-end synthetic resume/application fixture and document deployment.

## Specs and contracts to update

- Relevant service files/routes/DB/agent/browser specs and parent indexes.
- New web files feature spec plus composer/thread/route specs.
- Daemon/helper specs and docs/proto.md for new file transfer/capability contracts.
- DB schema, generated checked-in migration and migrations.spec.md.
- Ownership validation checklist in plan/init-auth/validation-checklist.md.
- Remove the browser UI's unsupported-file-upload notice only for supported flows.

## Validation

- Two-user isolation for library list/search/read/download/delete, message
  attachment, agent reads and daemon transfer; cookie write origin checks.
- Stream bounds, quota concurrency, interrupted uploads, wrong sizes/hashes,
  duplicate send retries and deletion racing with upload/read/staging.
- Resume reading fixtures: text PDF, scanned PDF, DOCX, Unicode, malformed input,
  unsupported types, extraction truncation and binary-safe transcript persistence.
- Browser fixture: labeled/hidden/iframe file inputs, multiple inputs, stale target,
  navigation, control loss, exact original bytes and no implicit form submit.
- Signed-in local acceptance: upload synthetic resume, reuse in another chat,
  extract information, fill a local fixture and verify the selected file's hash.
- Service/web builds, relevant Rust/helper tests, checked-in migration validation
  and the existing browser visibility/reconnection regressions.

## Rollout

- Apply the reviewed schema locally with db:push and generate/review the checked-in
  migration for deployment; test the migration from the current deployed schema.
- Production needs the declared Render persistent disk before service startup.
  Local testing uses local disk and needs no cloud credentials.
- Deploy matching service/web, then rebuild/restart the daemon with its bundled
  helper. The existing REPL envelope is unchanged; old helpers reject new operations
  and require upgrading. No reset of browser profiles or saved sign-ins.
- User requested two PRs with empty descriptions on October 15 after local
  testing. Stack uploads on browserview, then the reusable library on uploads.
  Production disk provisioning and deployment remain separate release steps.

## Implemented choices

Original keys derive from file IDs; metadata stores no bucket URLs. Attachment
references use existing message metadata, not a join table. PDF/DOCX extraction
is cached in owner rows; library search matches names and already extracted text.
Browser staging exists only for its cell and is deleted afterward. The two newest
requested document pages share hydration and context accounting selection.
Local db:push was attempted and canceled due to unrelated constraint churn;
reviewed generated 0053/0054 SQL was applied transactionally instead.
Production disk code and Blueprint are prepared below; focused storage/upload
tests pass 12/12. Actual provisioning and deployment remain pending.

## Render persistent disk implementation

- Keep one backend instance; declare a 10 GB disk at `/var/data` and upload
  directory `/var/data/uploads` in render.yaml. Upgrade the service Node pin to
  the locally tested 22.23.2 runtime required by PDF.js.
- Remove the unused S3 adapter/dependency and cloud credential configuration.
- Production requires explicit absolute directory and mount paths, with uploads
  strictly inside a real writable Linux mount. Missing/ephemeral mounts fail
  before serving requests; they never fall back to the service's temporary disk.
- Preserve user ownership, authenticated routes and existing quota/byte bounds.
  File IDs alone form disk paths; use private directory/file permissions and
  reject symlinks. No public/static serving of the volume.
- Stream each upload once to a private temporary file on the mounted volume,
  verify length/hash, fsync, then publish atomically without overwriting an
  existing original. Delete incomplete staging on failure and expire crash
  leftovers. Reserve concurrent write capacity and keep 256 MiB free.
- Validate production configuration rejection, disk persistence after reopening,
  permissions, atomic visibility, interrupted/full-disk handling, immutable
  writes and the existing multi-user HTTP/library/browser-transfer suite.
- Update root/service/upload specs, environment template and this validation
  note. No DB schema or daemon protocol change for the storage switch.
- Actual disk provisioning/deployment stays pending the user's test/release
  decision. Render disk snapshots and Postgres backups are separate; restoration
  requires reconciliation, and deleting live files does not erase old backups.

### Deployment handoff (after local acceptance)

1. Review/apply the Blueprint disk declaration: `bud-service`, 10 GB, mount
   `/var/data`. Keep `numInstances: 1`; provision the volume before starting the
   new service. Adding a Render disk triggers a deployment and storage charges.
2. Set `FILE_STORAGE_MOUNT_PATH=/var/data` and
   `FILE_STORAGE_DIRECTORY=/var/data/uploads`; service Node is pinned to 22.23.2.
   No storage credentials or public bucket are involved.
3. Apply 0053/0054 through the existing `pnpm db:migrate` pre-deploy command.
   Mount validation happens only at application runtime, not during migrations
   or build (Render does not mount disks in those phases).
4. Deploy matching service/web and rebuild/restart the daemon/helper. Upload a
   synthetic file, read/download/attach it, restart the service and verify the
   same original and checksum remain. Exercise a second account's denial.
5. Monitor Render disk usage and enlarge before capacity runs out. Daily disk
   snapshots do not form a transaction with Postgres backups. Coordinate restore
   with metadata/deletion state; never restore a disk over live writes.
6. Existing local originals stay local. Copy and verify both originals and their
   ownership metadata only if a separate data migration is explicitly requested.
