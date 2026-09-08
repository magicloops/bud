# Debug: Automation contract error assertion

`pnpm --dir service exec node --import tsx --test src/personal-data/automation-contracts.test.ts` initially failed with `The input did not match the regular expression /invalid_automation/` because DataRequestError exposes its stable identifier on `code`, while the Error message is user-readable. Updated the test to assert `{ code: "invalid_automation" }`. Both contract tests now pass; service TypeScript build passes.
