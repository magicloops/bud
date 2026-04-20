# Debug: service-refactor-final-build-fixes

## Environment
- OS / arch / versions: macOS (local dev workstation), project workspace at `/Users/adam/bud`
- DB connection style: local dev database with `pnpm db:push` already applied
- LLM mode (real/mocked): not required for the failing build step

## Repro Steps
1. Run `pnpm --dir /Users/adam/bud/service build`

## Observed
- TypeScript build failed with one broken type import and two unsafe readiness casts:

```text
src/agent/conversation-loader.ts(5,33): error TS2305: Module '"../llm/index.js"' has no exported member 'TerminalObservationView'.
src/ws/bud-connection.ts(196,19): error TS2352: Conversion of type 'Record<string, unknown>' to type 'ReadinessAssessment' may be a mistake because neither type sufficiently overlaps with the other.
src/ws/bud-connection.ts(218,18): error TS2352: Conversion of type '{ ready: boolean; confidence: number; trigger: string; prompt_type?: string | undefined; hints?: Record<string, boolean> | undefined; quiet_for_ms?: number | undefined; activity_checks?: number | undefined; stable_checks?: number | undefined; }' to type 'ReadinessAssessment' may be a mistake because neither type sufficiently overlaps with the other.
src/ws/bud-connection.ts(237,18): error TS2352: Conversion of type '{ ready: boolean; confidence: number; trigger: string; prompt_type?: string | undefined; hints?: Record<string, boolean> | undefined; quiet_for_ms?: number | undefined; activity_checks?: number | undefined; stable_checks?: number | undefined; }' to type 'ReadinessAssessment' may be a mistake because neither type sufficiently overlaps with the other.
```

## Expected
- `pnpm --dir /Users/adam/bud/service build` completes without TypeScript errors.

## Hypotheses
- `conversation-loader.ts` drifted to import `TerminalObservationView` from the LLM barrel even though that type lives in `terminal/types.ts`.
- `bud-connection.ts` was depending on broad WS schema output plus direct `as ReadinessAssessment` casts after the gateway/runtime split, and `tsc` now correctly rejects those unsafe casts.

## Proposed Fix
- Import `TerminalObservationView` from `service/src/terminal/types.ts`.
- Normalize readiness payloads at the WS boundary before handing them to `TerminalSessionManager`, including defaulting missing hint fields instead of casting raw Zod output.
- Re-run the exact same `service` build command, then continue the final build/lint closure pass if it succeeds.
