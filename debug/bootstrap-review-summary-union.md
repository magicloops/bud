# Debug: Bootstrap review summary union

## Environment
Local web TypeScript build, no live requests.

## Repro Steps
Run `pnpm build` from `web/` after extending the activation summary to existing-contact reviews.

## Observed
Inspection found the prop annotation was accidentally changed to two object members rather than a union. Build output is in `/tmp/bud-bootstrap-web-review-build.log`.

## Expected
The summary accepts either activation or existing-contact proposal data and narrows by the latter's kind.

## Proposed Fix
Use `ApiAutomationProposal | ApiBootstrapProposal` for the prop, with render coverage for counts, selection and repetition warning.
