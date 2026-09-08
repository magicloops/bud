# Debug: Completed approvals outside Worked for

## Reproduction and observation
On web, approve an agent-created automation and let the agent finish. The resolved
approval tool row remains between Worked for and the final assistant response.
The projector excludes all activation, existing-contact and app-permission tool
rows by name, even after their pending overlay becomes a canonical result.

## Fix
Keep only pending approval overlays standalone. Group resolved, rejected and
failed approval results into their turn's work alongside other tools. Leave
ask_user_questions behavior unchanged. Resolve tool identity from the existing
metadata-or-content helper, covering continuation rows with no metadata.tool.
No transcript, ownership, API or decision mutation changes.

## Validation
Regression coverage for all three approval tools, pending-to-canonical replacement,
content-only identity and final assistant preservation; web tests and build.

- Focused projection tests: 16 passed.
- `pnpm build` in `web/`: passed (bundle-size advisory only).
- `git diff --check`: passed.
- Browser visual verification remains manual.
