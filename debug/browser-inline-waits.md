# Debug: browser calls finish instead of waiting for control

Development service/web, managed Bud browser, real-agent reproduction: acquire
private control, then ask the agent to browse. Browser preparation rejects before
dispatch and the executor presents that result to the model, which finishes with
instructions to return control. The existing chat notice is outside the transcript.

Implement [Phase 3e](../plan/bud-owned-browser/phase-3e-inline-browser-waits.md):
atomically park proven undispatched work in the existing invocation tables,
preserve call identity, project waits inline and continue after explicit return.
Unknown dispatched results remain errors, never safe waits. Existing controller
authority and ownership checks are reused. No second daemon or production changes.


## Validation notes

- Service/web compilation passes. PostgreSQL browser repository/control/broker/
  continuation suite: 16 passed, including two waits and independent cancellation.
- Web state/projection suite: 35 passed; mounted handoff/viewer suite: 7 passed.
- `pnpm db:push` canceled at unrelated `agent_invocation_dedupe_key` recreation
  prompt (exit 1); no truncation accepted. Generated 0042 SQL applied locally in
  one transaction. No production change.
- Initial mounted test failed because Node has no `import.meta.env`; use the
  existing test-only module loader, without changing application transport.
- Actual-agent signed-in return/resume and restart acceptance remain manual.

Agent-loop/worker tests: 22 passed, one opt-in real-browser fixture skipped.
The new case verifies original-call waiting, no tool result/final refusal and no
trailing dispatch. Actual signed-in agent testing has not been performed here.

## Inline card polish

Pending tool chrome and duplicate helper text obscured the main decision. Render
pending browser waits as a compact shared-button row, with Return to agent and
Cancel. Hide Open browser for the visible matching pane; retain it when closed.
No authority or lifecycle changes. Mounted test covers visibility, disabled return
without ownership, cancellation and inert history.

User testing confirmed the actual-agent flow works and accepted the compact inline
Return to agent / Cancel controls, including the green border and hard shadow.
