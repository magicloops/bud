# Debug: Frozen bootstrap owner lookup

Command: `BUD_DATA_DB_TEST=1 pnpm exec tsx --test src/personal-data/contact-processor.test.ts src/personal-data/automation-bootstrap-review-contracts.test.ts` from `service/`.

The new foreign-owner freeze assertion expected `automation_not_found` but received
a PostgreSQL foreign-key failure inserting `data_owner_state` for the fixture's
nonexistent other owner. Exact test output is retained in
`/tmp/bud-frozen-bootstrap-tests.log` (initial run).

Freezing a review is only valid for an existing rule, whose creation already
establishes owner state. Require and lock that existing state instead of creating
it. Missing owner state returns the same not-found result as a missing owned rule.
This avoids writing before ownership is established and preserves publication
serialization. Rerun the integration fixture and service build.
