# Rolled-out capability defaults

The app-key and agent-automation review features are rolled out. Remove the need
for their three explicit opt-in environment settings without changing user consent.

- `APP_DATA_KEYS_ENABLED` defaults to on in durable invocation mode.
- `AUTOMATION_PROPOSALS_ENABLED` defaults to on when automations are enabled.
- `AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED` defaults to proposal enablement.
- Explicit `0` remains an operational disable override. Explicit `1` still
  requires its prerequisites. Legacy-mode startup remains supported.

The full flow now requires only `AGENT_INVOCATION_MODE=durable` and
`AUTOMATIONS_ENABLED=1`. Removed the three redundant variables from the ignored
local service `.env`. No database, client or daemon protocol changes. Human
approval, ownership, schema readiness and durable recovery checks are unchanged.

Updated [startup/spec](../service/src/src.spec.md), service environment template
and [service spec](../service/service.spec.md). Validation: package-local service
build and startup tests with `BUD_DATA_DB_TEST=1`, covering default/override
combinations, schema readiness and database mode guards. Deploy the new service
before removing explicit settings in other environments; older binaries still
default those features off. No deployment or commit is included.
