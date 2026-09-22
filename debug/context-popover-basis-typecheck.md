# Debug: Context popover basis type check

## Environment and reproduction
Local web workspace; run `pnpm --dir web exec tsc -b` after hiding the anchored accounting label.

## Observed
`src/components/workbench/context-send-button.tsx(149,29): error TS2339: Property 'basis' does not exist on type 'ApiContextBudget'. Property 'basis' does not exist on type 'ApiContextBudgetUnknown'.`

## Cause and fix
The budget is a discriminated union. Check `status === available` before accessing its basis; preserve unknown-budget explanatory copy. No runtime or API changes.
