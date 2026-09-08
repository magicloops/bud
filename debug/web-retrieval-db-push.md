# Debug: web retrieval local schema application

## Environment
Local macOS development service, PostgreSQL, September 8 2026.

## Reproduction and observation
`pnpm db:push` from `service/` proposes the two new web retrieval tables plus
unrelated recreation of five invocation/approval unique constraints and two
existing foreign keys. The existing tables contain live development records.
The non-TTY attempt could not accept input (`stdin is closed`); reran with a TTY.
Selected no truncation at each prompt and aborted the final combined SQL batch.

## Expected and proposed fix
Apply only the reviewed additive SQL from generated migration
`0037_huge_wendigo.sql`, transactionally. Preserve the existing constraints and
records. The migration was executed successfully in an isolated test schema;
the repository tests verify ownership, budgets, pagination and cleanup.
Update db and migration specs with the local application result.

Applied migration 0037 transactionally to the local database successfully.
One test command was initially run from the repo root:
`node --import tsx --test src/agent/web-retrieval-tools.test.ts`, which reported
`Could not find 'src/agent/web-retrieval-tools.test.ts'`. Reran from `service/`;
all three focused agent integration tests passed.

After enabling the local flag, the focused regression command
`node --import tsx --test src/web-retrieval/*.test.ts src/agent/web-retrieval-tools.test.ts src/agent/model-runner.test.ts src/agent/conversation-loader.test.ts src/agent/agent-service.test.ts src/db/schema-metadata.test.ts`
failed the existing offline-catalog assertion: the expected five tools now also
included `web_search` and `web_read`. That fixture inherited local optional
configuration. Pin its optional retrieval setting to false; the new retrieval
tests separately verify enabled and disabled offline catalogs.
