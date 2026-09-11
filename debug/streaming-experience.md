# Debug: Streaming progress and work disclosures

## Environment and reproduction

Static baseline review: web e7fdbec, mobile d653710. Send a task with tools,
commentary, more tools and a final answer; inspect progress and expand completed work.

## Observed

Web hides its footer whenever any live work group exists, and canonical commentary
folds into that group's default-collapsed body. Mobile's pending response indicator
clears at the first tool/text and is not rearmed. Mobile already models activity
segments but flattens them while live. Both require redundant expansion with no commentary.

## Expected / proposed fix

Implement plan/streaming-experience-contract.md and client plans using existing
identities and lifecycle signals. Keep commentary visible, use activity segment
disclosures, show progress during active non-text gaps, and reveal no-commentary
work directly. Preserve waiting states and execution/terminal observation timing.

## Validation setup failures

- Initial `pnpm exec tsc -b` in the fresh web worktree: `Command "tsc" not found`. Installed existing locked dependencies with `pnpm --dir web install --frozen-lockfile`; typecheck then passed.
- `pnpm --dir web test:render`: Node rejected imported `settings-layout.css` with `ERR_UNKNOWN_FILE_EXTENSION`. Added a test-only loader for CSS and Vite environment access within the render test; application bundling is unchanged.

## Results

Web unit/render suites, build and changed-file lint pass. Native focused streaming
tests pass. Broader mobile ChatStore run: 106 tests, four model-selection tests
with 13 failed assertions. Repeating those four on detached unchanged d653710
reproduced all 13 assertions (nil/inherited model preferences versus old explicit
model expectations); excluded from this presentation fix. Baseline log:
`/tmp/bud-streaming-mobile-baseline.log`.

Commands: `pnpm --dir web test`, `pnpm --dir web test:render`,
`pnpm --dir web build`; mobile uses xcodebuild test with Bud scheme and iPhone 17
simulator, selecting ChatStoreTests, ChatTranscriptRowProjectorTests and
ChatTranscriptRowViewTests; final focused run adds ChatAssistantActivityPolicyTests.
Browser runtime reported no browser and discovery returned an empty list.
