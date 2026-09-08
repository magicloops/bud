# Debug: Missing contact scans remain processing indefinitely

## Reproduction and observation

Ingest a contact generation whose predecessor or manifest member never arrives.
Publication correctly waits, but status reports `processing` forever. Failed raw
processing jobs are not counted, and invalid scans outside the latest 200 scans
can disappear from the summary. Neither client can tell that repair is needed.

## Fix

Keep publication ordering and immutable events unchanged. Status must aggregate
all owner-scoped failed/invalid jobs and invalid or day-old pending scans, while
returning only a bounded detail page. Explain each pending scan's missing
predecessor/manifest/records. An overdue scan remains publishable when original
events arrive; age changes reporting, not the source checkpoint or trigger rules.

Validate against local PostgreSQL fixture owners, including foreign-owner
isolation, failed work and recovery of the reported pending state. The remaining
explicit source-reset mechanism is separate work.
