# Debug: Automation tool schema type

## Environment
Service TypeScript build with JSONSchema7 provider contracts.

## Repro Steps
From service: `pnpm build`.

## Observed
`src/agent/automation-tools.ts(43,5): error TS2322`
Readonly enum and required arrays from `as const` were incompatible with mutable JSONSchema7 arrays. Full error: `/tmp/bud-automation-tools-build.log`.

## Expected
Shared draft schema satisfies the canonical provider parameter type.

## Proposed Fix
Contextually type the shared definition as `CanonicalTool["parameters"]` instead of freezing it with `as const`. Runtime validation remains unchanged.
