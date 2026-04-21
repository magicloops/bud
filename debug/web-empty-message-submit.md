# Debug: Web Empty Message Submit Race

## Environment
- Package: `web/`
- UI surface: `/$budId/new` and `/$budId/$threadId`
- Runtime: React 19 + Vite 7 browser app
- Composer: `web/src/components/workbench/command-composer.tsx`

## Repro Steps
1. Open the Bud web workspace on either the new-thread view or an existing thread.
2. Type a message into the composer textarea.
3. Press `Enter` to submit quickly.
4. Observe that the UI rejects the send with `Message cannot be empty`.

## Observed
- The textarea visibly contains text.
- Submit is triggered from the composer’s textarea key handler via `requestSubmit()`.
- The route submit handlers in `/$budId/new` and `/$budId/$threadId` validate against the controlled React `messageText` state.
- On fast Enter submits, the submit handler can observe stale state and trim an empty string even though the DOM textarea already has the typed value.

## Expected
- Submit validation should use the current submitted textarea value.
- Fast Enter submits should send the typed message rather than failing with a false empty-message error.

## Hypotheses
- The keydown-driven `requestSubmit()` path can run before the latest `onChange` state update is committed.
- Reading the current form payload from the submit event is a more reliable source of truth than route-local controlled state during submit.

## Proposed Fix
- Give the composer textarea a stable form field name.
- In both route submit handlers, read the submitted textarea value from `new FormData(event.currentTarget)` and validate/send that value instead of relying on `messageText` state.
- Keep React state for rendering/clearing the textarea after successful dispatch.
- Update the relevant web specs to note the form-payload submit behavior.
