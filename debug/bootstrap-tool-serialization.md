# Debug: Existing-contact tool serialization

## Environment
Local service, mocked model runner, no live account operations.

## Repro Steps
Run `pnpm exec tsx --test src/agent/automation-tools.test.ts src/agent/automation-agent-loop.test.ts` from `service/`.

## Observed
Catalog/parser test expected `automations_request_existing_contacts` but received `undefined` from conversation serialization. Full output: `/tmp/bud-bootstrap-tool-tests.log`.

## Expected
Preserve the new canonical tool name and selection arguments through replay.

## Hypotheses
The shared serializer enumerates tool names separately from the strict parser registry.

## Proposed Fix
Add the new name to both shared serialization switches; retain the round-trip test. Update agent spec.

Canonical replay also needs to recover the bootstrap selection from the public
proposal, rather than use activation-only `draft_version` arguments. Cover every
decision outcome both with and without a provider ledger.
