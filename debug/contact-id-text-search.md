# Debug: Contact identifiers passed to text search

Production contact 01M22KJHED48PGMZR65NR39J65 and its event revision existed.
One run called contacts_search with the contact and revision IDs and got empty
text-search results; another run successfully called contacts_history for the same
contact. No ingestion or permission failure explained the empty search results.

Fix: phase-18-contact-trigger-evidence adds approved exact-revision context at
first start and contacts_get for explicit lookups. No production writes performed.

## Validation

Command `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test
src/personal-data/agent-queries.test.ts src/personal-data/contact-field-policy.test.ts
src/personal-data/contact-processor.test.ts src/agent/invocation-repository.test.ts`
initially passed 13 assertions/subtests and failed the processor integration's
`assert.ok(capped)` (daily_work_limit delivery not yet found). The matcher uses
SKIP LOCKED and this fixture shares public tables with the dev worker. Standalone
rerun of contact-processor.test.ts passed, including the new live/bootstrap
context checks. No production records were accessed or modified for validation.
Tool extraction/replay and model-runner suites passed all 23 tests.

The added resumption fixture initially called `defer` on a running invocation,
which correctly failed `lease_lost` because defer accepts leased preflight work
only. Corrected the fixture to model a resumed leased state directly, preserving
its visible input and reservation, then verify start does not replace/append data.
No runtime lifecycle guard was relaxed.
