# Phase 2: Mobile identity, queue and background recovery

Status: partitioned queues, strict ACK handling, persisted retry/quarantine and cold callback recovery implemented; physical-device crash/lock/account-switch acceptance remains open. Dependencies: phase 0; phase 1 for integration. Parent: [implementation spec](implementation-spec.md).

## Outcome and files

Repair the shared TimelineCore transport before adding Contacts. Work in `bud-mobile`: `AppSessionStore`, `TimelineCoreManager`, `SettingsStore`, `SQLiteEventStore`, `BatchBuilder`, `SyncEngine`, `BackgroundUploader`, `BGTaskManager` and app background-session lifecycle. Read the full files and sibling repo instructions before editing.

## Durable account context

Bind queues, source checkpoints, batches, upload files and background callbacks to immutable `(environment, user_id, installation_id, collection_epoch)`. Use physically partitioned stores/directories or enforced composite keys everywhere; migrations must verify ownership. Quarantine legacy unscoped data until an explicit verified owner mapping exists. Never stamp it with the next login.

On sign-out/auth invalidation, stop collection and scheduling for that account and cancel or reconcile its transfers. Retain its partition during development; an already-dispatched request can finish only under its original identity, and its callback can mutate only that partition. A new account cannot adopt old tasks or credentials. Resume only with the original account/environment. Track shipped discard-on-sign-out as a follow-up.

## Queue and ACK state machine

Persist `pending → prepared → in_flight → acknowledged` plus `retry_wait` and visible `quarantined`. Acknowledged rows may be deleted after the matching batch transaction. Store batch membership, file/task identity, attempt, next retry and account context before handoff. Replace `INSERT OR REPLACE` event semantics with immutable insert/deduplication.

1. Build count- and byte-bounded gzip batches from eligible rows; persist membership and file metadata.
2. Enqueue a background upload under the same account credential context. Enqueue failure releases/retries membership; it cannot strand rows as in-flight.
3. Accept only a successful structured ACK with matching batch ID and explicit IDs belonging to that batch. Missing/empty-invalid/HTML/wrong-batch/foreign-ID responses never imply full success. For partial ACK, retire acknowledged rows and independently handle rejected/unacknowledged members.
4. Permanent event rejection becomes visible quarantine; preserve reason and original event for inspection. Transient failures use persisted backoff/retry hints. Split oversized multi-event batches on 413; isolate an individually oversized event visibly. Conflicting IDs require remediation, never silent rewriting.
5. After completion, drain the next batch within bounded concurrency/background budget. Persist retry scheduling across relaunch.

## OAuth and lifecycle

Wire the existing refreshable OAuth session into a token-provider interface; retain broad-token behavior only for this development stage. A URLSession request already created with an expired bearer must be rebuilt after refresh using the same owner/batch data. Refresh failure retains queued events and exposes reauthentication; it never swaps to another signed-in identity or loops indefinitely.

Recreate background sessions and reconcile SQLite batches/files/OS tasks during cold launch before network profile bootstrap. Buffer app-delegate completion handlers until the responsible session exists; invoke them exactly once after its events are durably handled. Recover orphan files/tasks and missing enqueue receipts without assuming absence means successful upload.

BGTask work awaits bounded local recovery/enqueue work and reports completion truthfully; it does not wait indefinitely for network transfer. Expiration cancels local work with durable retry state. Respect protected-data/first-unlock availability. No guaranteed background cadence is promised.

## Acceptance

- [ ] M-series crash/account/ACK matrix passes with kill points before and after each durable boundary.
- [ ] A→B switching, revocation and environment changes never move data or callbacks across partitions.
- [ ] Cold-launch URLSession completion works without `/api/me` success; locked/storage-full cases retain recoverable state.
- [ ] Existing location and health producers remain present and feed the repaired transport. Health source-anchor correctness remains a named future task, not an implied guarantee of this phase.

Update mobile storage/sync/background/event contracts and app session documentation. Roll out queue migration with recoverable backups/quarantine and explicit downgrade behavior; avoid a destructive in-place migration with no ownership evidence.


Orphan-file recovery is implemented: active startup retains the union of SQLite
and OS task references, removes only generated regular UUID batch files without
references, and preserves unrelated paths and queue/checkpoint contents. New
membership-write failures clean the not-yet-enqueued file. Seven selected queue
tests and all 31 TimelineCore tests pass (`/tmp/bud-orphan-batch-tests-verified.log`,
`/tmp/bud-orphan-batch-regression.log`). The startup fixture preserves original
queued bytes while removing a pre-membership crash leftover. Physical kill/lock
conditions remain unverified. See [debug note](../../debug/orphan-mobile-batch-files.md).
