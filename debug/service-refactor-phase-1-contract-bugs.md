# Debug: service-refactor-phase-1-contract-bugs

## Environment
- OS / arch / versions: local macOS development in `/Users/adam/bud`
- DB connection style: PostgreSQL with `db:push` for local development and `db:migrate` for staging
- LLM mode (real/mocked): mixed provider-backed local development; provider-less startup must also work

## Repro Steps
1. Start the service with no provider credentials configured.
2. Seed or create a bud enrollment token, then attempt gateway enrollment using the same token.
3. Inspect mounted browser-facing SSE and run routes in the service.
4. Start or observe a Node REPL prompt through terminal context sync.

## Observed
- Service startup still hard-fails when no LLM providers are configured, despite the current local-development posture.
- Enrollment-token hashing is duplicated and inconsistent between seeding and gateway validation.
- Legacy standalone run/SSE surfaces remain mounted even though the active runtime is thread-scoped terminals plus the newer agent runtime.
- The terminal context classifier can treat a bare `>` as a generic shell prompt before recognizing it as a Node REPL prompt.

## Expected
- Service boot should succeed without configured providers and degrade optional provider-backed features cleanly.
- Enrollment-token hashing should be defined once and match across token creation and validation.
- Legacy run-manager routes and bud-scoped terminal stream routes should be removed when they are no longer part of the supported runtime.
- A bare `>` prompt should classify as a REPL prompt before generic shell heuristics run.

## Hypotheses
- Provider initialization still encodes an older assumption that Anthropic/OpenAI credentials are required at process startup.
- Enrollment hashing drift came from separate helper implementations using different secrets or defaults.
- Legacy run transport was left in place during the thread-terminal cutover and now overlaps with current contracts.
- Prompt detection ordering regressed when shell heuristics were generalized.

## Proposed Fix
- Remove the legacy standalone run-manager surface from service bootstrap, routes, and gateway handling.
- Add a shared enrollment-token hashing helper under `service/src/auth/` and reuse it from seeding and gateway validation.
- Make provider initialization and thread-title generation tolerant of a provider-less boot path.
- Reorder the REPL prompt heuristic so Node REPL detection runs before generic shell prompt matching.
- Update the affected specs and contract docs in the same change set.
