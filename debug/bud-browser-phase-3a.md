# Debug and validation: browser workbench pane

## Environment and objective
Local web/service/daemon; Phase 3a adds a reused browser viewer pane and private
controller-owned viewport fitting. User confirmed the preceding standalone
viewer works. No new claims about the full Phase-2 acceptance matrix.

## Build feedback
`pnpm build` in web initially rejected TypeScript constructor parameter properties
(TS1294: erasableSyntaxOnly), and the new browser view was not assignable to the
terminal hook's narrower TerminalViewMode (TS2322). Use explicit class fields and
map the browser overlay to the existing terminal-hidden file mode at that boundary.
Service build and daemon cargo check passed on the first run.

## Checks
- Web/service production builds pass; daemon `cargo build` passes.
- Web pure tests: 5 passed. Mounted pane/viewer tests: 2 passed.
- Service browser suite: 11 passed, 2 opt-in DB fixtures skipped; this phase adds
  no schema changes. Controller/codec tests cover the new command specifically.
- Live daemon suite with BUD_BROWSER_EXECUTABLE set to cached CfT152: 10 passed,
  including 640×480 resize without navigation, retained synthetic password input,
  stale frame/document/controller/epoch rejection, and 11 seconds of continuous
  capture with two lease renewals after resize.
- Targeted web ESLint passes after replacing a side-effect ternary rejected by
  no-unused-expressions with explicit if/else. The first correction command used
  a repo-relative path from service/ and failed FileNotFoundError; rerun at root.
- No authenticated browser runtime was available (discovery returned no browsers).
  Actual visual pane/divider/focus, narrow layouts, popup selection and network
  latency/soak checks remain manual. Existing user daemon was not restarted or
  duplicated; the rebuilt executable is ready for its next launch.

The first targeted service run failed with `browser_viewport_unconfirmed`: the
mock dispatch treated `undefined === command.operation` as a configured failure
for non-control commands. Require an explicitly configured failure in the fixture.

The live CDP test returned the correct width `640.0`; serde JSON numeric equality
against an integer literal failed. Assert numeric dimensions through `as_f64`.

- Live localhost HTTPS POST to the new viewport endpoint without a session
  returned `401 {"error":"unauthorized"}`; no daemon was touched.
