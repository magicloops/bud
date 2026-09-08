# Debug: Agent contact-field response fixture

## Environment and reproduction

Local TypeScript service. Run `pnpm build` from `service/` after adding
`permission.contact_fields` to agent query results.

## Observed

Build exits 2 with TS2322 in `src/agent/personal-data-tools.test.ts` at lines
36, 77, 126, 144 and 162. Each injected adapter returns the shared old fixture:
`Property 'contact_fields' is missing in type ... but required in type ...`.
Exact output is in `/tmp/bud-agent-contact-field-build.log`.
The 13 runtime tests pass; the type checker catches fixture contract drift.

## Proposed fix

Type the shared fixture from the adapter's return contract and include the
legacy approved fields. Rerun focused tests and the service build. No production
authorization relaxation or schema change is needed.
