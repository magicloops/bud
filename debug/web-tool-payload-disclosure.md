# Debug: Grouped tool names and payload disclosure

## Environment and reproduction
- Web client using the compact transcript API.
- Open a turn containing browser tools, expand its work and tool rows.

## Observed
Rows show `Tool` and summaries such as `Browser operation completed.` without
access to the returned structured payload.

## Expected
Identify the tool used and allow inspection of its payload, preserving specialized
output renderers and keeping collapsed payloads cheap to render.

## Cause and proposed fix
Grouped row summaries still read tool fields from metadata after the compact
contract moved them into `tool_payload`. Grouped details also lack the standalone
row's payload disclosure. Read structured fields, retain the tool name alongside
command summaries, and add lazy payload disclosure to grouped details.
No API or authorization change: these are already authorized transcript rows.

## Validation
- `pnpm test:render` (web): 69 passing, including mounted disclosure and compact
  tool identity regressions.
- `pnpm build` (web): passed; existing large-chunk warning remains.
- Focused ESLint and `git diff --check`: passed.
- No live browser visual verification performed.
Affected spec: `web/src/components/workbench/workbench.spec.md`.

## Expanded detail alignment
Tool and reasoning detail wrappers had no left inset, so content began under
the chevron. Use a shared 20px inset for the 12px chevron plus 8px gap,
aligning browser details with the globe and matching reasoning's inset.
Use 8px above and below the details for consistent disclosure spacing.
