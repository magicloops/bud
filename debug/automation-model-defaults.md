# Debug: Automation model defaults

## Environment and reproduction
- Local development service, PostgreSQL, iPhone, GPT-5.6 Luna.
- Ask the agent to create a new-contact automation without choosing a model.

## Observed
- The September 8 failed create call omitted model but explicitly supplied reasoning_effort=minimal.
- AutomationManagement already inherits the admitted chat invocation's model and reasoning for omitted/null fields.
- The unsupported reasoning override failed exact validation with the ambiguous invalid_automation_model error. A later call explicitly supplied Luna/none and succeeded.

## Fix
- Tell the agent explicitly to omit both model and reasoning unless the user requests an override; reinforce this on each create-field description.
- Preserve exact server-bound defaults and explicit overrides. Do not silently replace unsupported explicit choices.
- For failed create-model validation, report the attempted model/reasoning and explain how to inherit the chat defaults.
- Add omitted/null model-and-reasoning coverage and a failed-override recovery test.
- No ownership, schema, protocol, or mobile changes. Existing human-origin/lease/owner checks and approval remain in force.

## Investigation command correction
The initial `pnpm exec tsx -e` database inspection failed with `Top-level await is currently not supported with the cjs output format`. Retried successfully using `node --import tsx --input-type=module` and a heredoc.

## Validation
- Automation tool/parser tests, draft contract tests, and isolated PostgreSQL invocation/proposal tests pass (9 tests).
- The existing server inheritance remains unchanged; this fixes agent guidance and ambiguous error feedback, not a missing model default.
