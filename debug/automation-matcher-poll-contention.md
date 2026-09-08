# Debug: Matcher poll contention

`BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/personal-data/contact-processor.test.ts src/personal-data/automations.test.ts` initially failed at the assertion that one matcher poll returned true (`false !== true`).
The matcher deliberately uses SKIP LOCKED on the owner, and a live development
processor shares this database. A diagnostic rerun passed. This is consistent
with transient owner-lock contention; a single poll is not a completion promise.
The test now uses bounded retry and checks the durable delivery/revision result.
The combined PostgreSQL suite then passed, as did the service build.
