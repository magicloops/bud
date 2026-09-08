# Debug: OpenAI rejects automation tool schemas

## Environment and reproduction
Local development service, GPT-5.6 Luna, automation proposals enabled. Ask for a
Validation contact note draft. The provider rejects the request before tool execution.

## Observed
`400 Invalid schema for function 'automations_create_draft': In context=('properties', 'sources', 'type', '0', 'properties', 'source_ids'), 'uniqueItems' is not permitted.`
Code: `invalid_function_parameters`; parameter: `tools[15].parameters`.
Evidence: `/tmp/bud-ngrok-local-https.log`, September 6, 2026 21:30 local time.

## Cause and proposed fix
Canonical schemas include uniqueItems for source IDs and scopes. OpenAI's strict
schema transformer forwards it unchanged. Remove that keyword recursively only
in the OpenAI request copy; retain canonical schemas and server validation.
Exercise the actual enabled catalog through a captured provider request, including
create/update drafts and existing-contact reviews, and verify canonical immutability.

Official supported schema subset:
https://developers.openai.com/api/docs/guides/structured-outputs#supported-schemas

Spec affected: service/src/llm/providers/providers.spec.md.

## Resolution and validation
The OpenAI adapter now deletes `uniqueItems` from each cloned schema node.
30 provider/catalog tests pass (`/tmp/bud-automation-schema-tests.log`), and
`pnpm build` passes (`/tmp/bud-automation-schema-build.log`). A real GPT-5.6 Luna
Responses request accepted all 20 enabled tool definitions with `tool_choice:none`
and returned `end_turn`; no tool executed and no contact data was sent.
The development watcher reloaded to PID 67089 and `/readyz` passed at
2026-09-07 04:32:33 UTC. User automation creation/review remains the next live step.
