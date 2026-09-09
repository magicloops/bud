# Rolled-out capabilities are standard service behavior

Durable invocation mode, automation scheduling, automation proposals,
existing-contact reviews and app-key requests are always enabled. This replaces
the earlier conditional-default rollout: this deployment has no live external
consumers requiring legacy opt-in behavior.

Retire AGENT_INVOCATION_MODE, AUTOMATIONS_ENABLED, APP_DATA_KEYS_ENABLED,
AUTOMATION_PROPOSALS_ENABLED and AUTOMATION_EXISTING_CONTACT_REVIEWS_ENABLED
from configuration. Existing values are ignored, including legacy/0 overrides.
Keep AGENT_AUTOMATION_CONCURRENCY_PER_BUD (1–32, default 1) and retain
WEB_RETRIEVAL_ENABLED (default on, explicit disable supported).

Human review, ownership, data grants, schema readiness and database mode guards
remain enforced. The historical legacy execution code is not removed in this
configuration change, but production startup can no longer select it.

Rollout: apply existing migrations and stop legacy service processes before
starting this version; the database mode guard rejects mixed legacy/durable
processes or unresolved legacy questions. This is a service runtime cutover,
not a daemon protocol change. No daemon upgrade or new migration is required.
No production data reconciliation is performed automatically.

Validation: startup defaults with an empty environment and stale retired flags,
capacity validation, PostgreSQL schema/mode guards, service composition build.
Specs: service/service.spec.md and service/src/src.spec.md.

Validation completed: `pnpm build` and all 5 startup tests with
`BUD_DATA_DB_TEST=1` passed. No production deployment or reconciliation performed.
