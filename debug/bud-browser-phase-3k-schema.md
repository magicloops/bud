# Debug: Phase 3k local schema application

## Environment

Local macOS development, service PostgreSQL configured through `config.databaseUrl`.
No production database or daemon lifecycle changes.

## Observed

`pnpm db:push` from `service/` stopped at the existing unrelated prompt:

```
You're about to add agent_invocation_dedupe_key unique constraint to the table,
which contains 205 items. If this statement fails, you will receive an error
from the database. Do you want to truncate agent_invocation table?
```

Canceled with Ctrl-C; command exited 1 (`drizzle-kit push exited with code 1`).
No truncation was selected. This is the same constraint recreation encountered
by previous browser migrations; it is not required by Phase 3k.

The initial temporary SQL application script, run with
`pnpm exec tsx /tmp/bud-apply-browser-resource.mts`, failed before connecting:
`SyntaxError: ... pg/lib/index.js does not provide an export named 'Pool'`.
Using the CommonJS default export corrected the import.

## Resolution and validation

Generated/reviewed migrations `0044_dry_princess_powerful.sql` and
`0045_gorgeous_luke_cage.sql` were applied in one transaction to the local database,
with a localhost host guard. No unrelated schema proposal was applied.

`BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test
src/browser/resource-repository.test.ts` passes from `service/`, applying both
migrations against isolated pre-change tables and validating ownership,
concurrency, private recovery, return and reset receipts. `pnpm build` passes.
Shared runtime adoption is now implemented. Migration 0046 was subsequently
generated/reviewed and applied locally with the same localhost-guarded transaction.
It retires unlinked sessions, removes copied authority and installs the claim
retirement trigger. An initial attempt reused the 0044/0045 application script and
failed with `relation "browser_resource" already exists`; the transaction rolled
back. Applying only the pending 0046 SQL succeeded. No unrelated tables were reset.

The full service browser suite passes 28 tests with BUD_DATA_DB_TEST=1. The
repository fixture executes migrations 0039–0046 against isolated tables and checks
same-owner reclaim retirement. Continuation covers lifecycle cancellation without
canceling unrelated chat. Schema metadata validation also passes.

Live Chrome validation caught a cleanup failure after an intentionally interrupted
CDP command: `live_authority_fifo_admission_and_unknown_cancellation` failed when
closing a workspace using its poisoned CDP connection. Workspace close now creates
a fresh connection solely to enumerate and close its own targets; no uncertain
action is replayed. All six existing live manager cases pass, as do the new
`live_global_privacy_and_lifecycle` and explicitly enabled shared-workspace fixture.

Commands were run from their owning packages. Service `pnpm exec tsc --noEmit`,
web `pnpm build` and daemon `cargo build` pass. Web emits its existing bundle-size
warning. Native keychain/login persistence and Linux acceptance are not established
by disposable-profile tests; see the Phase 3k checkpoint.
