# Debug: neutral-terminal-wire-contract-gateway-transform-error

## Environment
- OS / arch / versions: macOS (local dev), Node.js v22.14.0
- DB connection style: local service dev environment
- LLM mode (real/mocked): not relevant

## Repro Steps
1. Run `AGENT_DEBUG=true pnpm dev` from `service/`.
2. `tsx watch src/server.ts` fails during transform.

## Observed
- Startup aborts before the service boots.
- Error:

```text
Error [TransformError]: Transform failed with 1 error:
/Users/adam/bud/service/src/ws/gateway.ts:52:4: ERROR: Expected ")" but found ";"
```

## Expected
- The service should parse and boot normally after the neutral terminal wire-contract changes.

## Hypotheses
- The new `CapabilitiesSchema` `z.object(...).transform(...)` block in `gateway.ts` is missing a closing `})` before the terminating semicolon.

## Proposed Fix
- Close the `transform(...)` call correctly in `service/src/ws/gateway.ts`.
- Re-run the focused service tests that exercise `gateway.ts`, `agent-service.ts`, and terminal runtime code.
- If those pass, continue with the remaining validation/schema follow-up.
