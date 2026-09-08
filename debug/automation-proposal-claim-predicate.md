# Debug: Automation proposal claim predicate

## Environment
Local PostgreSQL; isolated schema continuation fixture.

## Repro Steps
From service: `BUD_DATA_DB_TEST=1 node --import tsx --test src/agent/invocation-automation-proposal.test.ts`.

## Observed
Claim query failed after adding the third resolved-review branch. Full command output is in `/tmp/bud-proposal-continuation-test.log`.
The nested SQL predicate had an unmatched opening parenthesis; TypeScript compilation cannot validate raw SQL syntax.

## Expected
Human inputs and resolved question/app/automation continuations are claimable; unanswered reviews are not.

## Proposed Fix
Use one waiting-for-user condition with three EXISTS alternatives, avoiding repeated nested status branches. Rerun the isolated PostgreSQL lifecycle test.
