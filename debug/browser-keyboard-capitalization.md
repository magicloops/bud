# Debug: Mobile browser keyboard repeatedly enables Shift

## Environment
- iPhone hosted browser viewer in WKWebView; private remote input.

## Repro Steps
1. Tap an editable remote field and type using the software keyboard.
2. Turn Shift off and continue typing.

## Observed
- User reports Shift repeatedly becomes selected.
- The hidden textarea clears its value after each committed fragment/composition.
- It disables autocomplete/spelling but omits autocapitalize and autocorrect.

## Expected
- Manual capitalization choices remain effective; transport buffer resets do not
  request new sentence capitalization.

## Hypotheses
- Safari defaults textarea capitalization to sentences. Clearing the transport
  buffer repeatedly presents an empty sentence to the keyboard.
- No repeated keyboard focus is requested for text acknowledgements; automatic
  focus is limited to confirmed editable clicks.

## Fix
- Set autoCapitalize="none" and autoCorrect="off" on the hidden transport textarea.
- Keep explicit Shift, committed text, composition and input fencing unchanged.
- Do not mirror remote field contents into the local keyboard buffer.
- Update web browser spec. No service, daemon, protocol or native change.

Reference: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/autocapitalize

## Validation
- TypeScript and existing mounted mobile viewer tests; physical Shift behavior
  requires iPhone verification after closing/reopening the hosted viewer.
