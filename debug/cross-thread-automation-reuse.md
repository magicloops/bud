# Debug: Cross-thread automation reuse

## Observed
Production had one automation, version 3. Revision 1 targeted the Adam's Contacts
thread. The Contact Atlas chat called list/get/update/request_activation, not
create_draft. Its transcript explicitly chose to extend the existing rule to avoid
"competing" triggers. Approved revision 3 imported into both sites and linked to
Contact Atlas, retaining the original thread. One successful revision-3 delivery
went to that saved destination. Read-only inspection; no production mutation.

## Cause and fix
Owner-wide tool listing and insufficient create-versus-update guidance encouraged
reuse. Current-thread creation defaults never applied to the update path. Make
listing thread-scoped by default with explicit all scope, clarify independent
workflows, and surface replacement/destination in both review clients.
See ../plan/thread-scoped-automation-authoring.md.

## Validation fixture correction

After adding a foreign-owner fixture, these commands failed:

- `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/agent/invocation-automation-proposal.test.ts`
- `pnpm --dir service build`

The fixture omitted required updatedByUserId. Compiler output:

```text

> @bud/service@0.0.1 build /Users/adam/bud/service
> tsc --project tsconfig.json

src/agent/invocation-automation-proposal.test.ts(100,45): error TS2769: No overload matches this call.
  Overload 1 of 2, '(value: { createdByUserId: string | SQL<unknown> | Placeholder<string, any>; id: string | SQL<unknown> | Placeholder<string, any>; updatedByUserId: string | SQL<...> | Placeholder<...>; ... 6 more ...; activeRevision?: number | ... 3 more ... | undefined; }): PgInsertBase<...>', gave the following error.
    Argument of type '{ id: string; createdByUserId: string; draft: { target: { mode: string; thread_id: `${string}-${string}-${string}-${string}-${string}`; }; event_type: string; name: string; instruction: string; sources: { source_ids: never[]; }; ... 5 more ...; max_invocations_per_day: number; }; }' is not assignable to parameter of type '{ createdByUserId: string | SQL<unknown> | Placeholder<string, any>; id: string | SQL<unknown> | Placeholder<string, any>; updatedByUserId: string | SQL<...> | Placeholder<...>; ... 6 more ...; activeRevision?: number | ... 3 more ... | undefined; }'.
      Property 'updatedByUserId' is missing in type '{ id: string; createdByUserId: string; draft: { target: { mode: string; thread_id: `${string}-${string}-${string}-${string}-${string}`; }; event_type: string; name: string; instruction: string; sources: { source_ids: never[]; }; ... 5 more ...; max_invocations_per_day: number; }; }' but required in type '{ createdByUserId: string | SQL<unknown> | Placeholder<string, any>; id: string | SQL<unknown> | Placeholder<string, any>; updatedByUserId: string | SQL<...> | Placeholder<...>; ... 6 more ...; activeRevision?: number | ... 3 more ... | undefined; }'.
  Overload 2 of 2, '(values: { createdByUserId: string | SQL<unknown> | Placeholder<string, any>; id: string | SQL<unknown> | Placeholder<string, any>; updatedByUserId: string | SQL<...> | Placeholder<...>; ... 6 more ...; activeRevision?: number | ... 3 more ... | undefined; }[]): PgInsertBase<...>', gave the following error.
    Object literal may only specify known properties, and 'id' does not exist in type '{ createdByUserId: string | SQL<unknown> | Placeholder<string, any>; id: string | SQL<unknown> | Placeholder<string, any>; updatedByUserId: string | SQL<...> | Placeholder<...>; ... 6 more ...; activeRevision?: number | ... 3 more ... | undefined; }[]'.
 ELIFECYCLE  Command failed with exit code 2.

```

Corrected fixture owner stamping; reran the focused test and build.
