# Legacy ingestion inventory

Read-only local inspection on September 4, 2026. No payloads, credentials or raw
owner identifiers were printed. No data was migrated, relabeled or deleted.

## Standalone database

The standalone repository's configured database resolves to localhost and its
local authentication mode is `dev`. In a read-only PostgreSQL transaction,
`public.events` contains **6 rows**, **1 owner label**, and **1 installation**.
All six rows use the shared `dev` owner label. Earliest receipt:
2026-02-09 10:18:02.186 UTC; latest receipt: 2026-03-10 08:51:48.582 UTC.

Decision: leave these records in the standalone database as unmapped legacy data.
The `dev` label does not establish a real Bud account. Do not bulk-import them
into a signed-in account. Any later migration must establish owner provenance,
preserve original event IDs and receipt timestamps, and explicitly suppress live
actions. No standalone retirement or deletion is authorized by this inventory.

The repository contains a Render blueprint for a `bud-ingest` web service with
production JWT authentication and externally supplied database/secret settings.
This is deployment configuration, not proof that a remote service or database
exists. Remote deployment/database inventory remains unverified; no Render
connector was available in the current tool inventory.

## Local mobile queues

Read-only SQLite inspection under local CoreSimulator application-support
TimelineCore directories and the host's standard TimelineCore directory found
**two legacy unpartitioned queues**, each containing **zero events**. No
account-partitioned queue was found in those inspected locations. These findings
do not cover a physical phone, backups, other Macs or custom app storage paths.

The physical iPhone is still reported unavailable by `xcrun devicectl list devices`.
Its queue inventory, signed-out retention and first-unlock behavior remain open.
Keep legacy files intact; new authenticated collection already uses separate
owner/environment/installation partitions and must not adopt unverified queues.

## Verification boundaries

Database query: count rows/distinct owner labels/distinct installations, count
rows with the literal development label, min/max receipt. No raw envelopes read.
SQLite queries: schema table names, event counts and state counts using `mode=ro`
and `PRAGMA query_only=ON`. No event payloads or authentication stores read.
