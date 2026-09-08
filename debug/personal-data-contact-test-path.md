# Debug: Contacts test file creation used the wrong working directory

## Environment

September 4, 2026, macOS, service Node/tsx tests. Command working directory: `/Users/adam/bud/service`.

## Observed

The assistant used `service/src/personal-data/contacts.ts` and `service/src/personal-data/contacts.test.ts` within that directory, rather than package-relative `src/...` or absolute paths. The edit and test-file creation failed. The subsequent test command failed before loading tests:

```sh
pnpm exec node --import tsx --test src/personal-data/contacts.test.ts
```

Exact error:

```text
Could not find 'src/personal-data/contacts.test.ts'
```

Preceding file-operation errors:

```text
FileNotFoundError: [Errno 2] No such file or directory: 'service/src/personal-data/contacts.ts'
zsh:11: no such file or directory: service/src/personal-data/contacts.test.ts
```

This is an assistant command-path mistake, not evidence of a failing Contacts assertion. `service/src/personal-data/contacts.ts` exists from the preceding successful creation but is untested. No alternative test command was attempted after this failure, per AGENTS.md §3.5.

## Proposed correction on continuation

Use absolute paths for edits and package-relative paths for pnpm. Replace the unchecked context spread in contacts.ts with explicit selected context fields. Create the missing contact parser/manifest tests, then run them and the service build. The server validator is not yet connected to ingestion processing or agent queries.

## Prior verified work

Twelve TimelineCore package tests passed; full mobile simulator build passed with Contacts opt-in. The original 21 app auth tests and then 23 tests including Keychain collection-owner binding/rotation compatibility passed. No backend query/projection/automation acceptance gate is complete.

## Resolution

After removal of the stop-on-build-error directive, fixed absolute editing paths, created the missing tests, selected Contact context fields explicitly, and passed all three contract tests plus the service build. PostgreSQL projection tests subsequently passed for reverse order, incomplete scans, concurrent publication, replay and rebuild suppression.
