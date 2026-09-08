# Debug: Agent field storage fixture lifetime

`BUD_DATA_DB_TEST=1 pnpm exec tsx --test src/personal-data/grants.test.ts
src/personal-data/agent-queries.test.ts src/db/schema-metadata.test.ts` failed
at the second grant update. Output: `/tmp/bud-agent-fields-storage-tests.log`.
The query attempted to insert synthetic owner `alice` into `data_owner_state`.

The fixture opened a raw transaction and created temporary tables with
`ON COMMIT DROP`, but the repository owns its transactions. Its first commit
dropped the temporary tables; subsequent queries resolved public tables and
failed their foreign key. No live user grant was changed.

Use session-lifetime temporary tables on the dedicated connection, allowing each
repository transaction to commit normally. Closing that connection removes the
fixture tables. Re-run the fixture and build.

The build also reported TS2345 because `DataGrants` accepted a database type
requiring `$client: Pool`, while the isolated fixture uses `PoolClient`. The
repository never uses `$client`; omit that property from its dependency type.
Exact initial build output: `/tmp/bud-agent-fields-storage-build.log`.

Local `pnpm db:push` was canceled at the unrelated
`agent_invocation_dedupe_key` recreation/truncation prompt. Reviewed generated
0035 SQL adds only `agent_data_grant.contact_fields`; applied locally in a
transaction with a five-second lock timeout, without changing invocation data.
