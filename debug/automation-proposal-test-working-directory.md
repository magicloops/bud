# Debug: Automation proposal test working directory

## Environment
Local macOS workspace; service package uses package-local tsx.

## Repro Steps
Ran from `/Users/adam/bud`:
`BUD_DATA_DB_TEST=1 node --import tsx --test src/personal-data/automation-proposals.test.ts`

## Observed
Exact output: `Could not find 'src/personal-data/automation-proposals.test.ts'`.
The service-relative test path was resolved from the repository root.

## Expected
Run the PostgreSQL repository fixture from `/Users/adam/bud/service`.

## Proposed Fix
Run the exact test command from the owning service package directory. No implementation change required.
