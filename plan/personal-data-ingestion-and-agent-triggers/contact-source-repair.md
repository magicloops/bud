# Explicit complete-snapshot source repair

Repair retains the same owner/installation/epoch/store identity and existing
contact IDs. The mobile user explicitly requests repair after reviewing missing
scan diagnostics. A durable local request produces a full permitted snapshot,
with a fresh scan/event identity at the next local generation. It uses distinct
`contacts.repair_record.v1` and `contacts.repair_scan.v1` event types, `resync`
mode, and never claims newly-observed additions. An empty replacement is valid.

The service stages and verifies all members and the digest as usual. Only a
complete repair at a generation newer than the published source can skip missing
predecessors/observation linkage. Under the existing owner lock, publication
updates retained contacts, hides prior visible contacts absent from the replacement,
records revisions, supersedes older unpublished scans, and advances the source
checkpoint atomically. No live domain event is emitted. Published history,
completed actions and explicit bootstrap dedupe remain intact. Late old records
cannot reopen the superseded chain. Subsequent ordinary generations again require
exact predecessor linkage.

No new tables are needed; repair metadata remains in the immutable raw events and
manifest, and existing text statuses gain `repair_pending` and `superseded`. No owner identity comes
from a new request argument. Upload authentication and epoch ownership remain the
authority. UI must explain visibility replacement and require explicit consent.

Compatibility: old services store these unknown event types without interpreting
them as ordinary contact scans. New services stage repairs as `repair_pending`,
which older publishers do not select, including an adjacent-generation repair
already staged before rollback. A restored new service resumes that same scan.
Older status clients may lack repair diagnostics; they cannot publish it. Mobile must check the additive
`features.contact_source_repair` capability before offering repair. New services
continue ordinary v1 publication unchanged. The capability is now advertised. Mobile persists the repair request before
scanning, consumes it with the committed snapshot/events, and checks capability
after explicit confirmation. Unsupported repair jobs from an older service
are recovered by the existing bounded owner-scoped processor pass.

Validation: incomplete/reversed repair batches, digest/context mismatch, original
source IDs, hidden missing contacts, no repeated domain actions, concurrent repair
publication, stale repair, late superseded records, subsequent incremental scan,
empty replacement and foreign-owner isolation. Test with real PostgreSQL plus
mobile durable request and snapshot tests; visual/device acceptance remains open.
