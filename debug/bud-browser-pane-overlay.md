# Debug: browser pane resizes with its controls

## Observed
Handoff text and private-control instructions change above the flex-sized browser
surface. GET metadata includes handoff details, while control responses omit them;
replacing metadata on renewal removes the handoff until the next poll. Each height
change triggers fitting, which invalidates focus and queued input.

## Fix
Make the measured browser surface fill the pane independently of all controls.
Place existing controls and private typing in an absolutely positioned, scrollable
overlay accessible by hover, click and keyboard. Status/errors remain available
without consuming surface height. Preserve omitted handoff metadata on control
responses; explicit null from metadata still clears it. No authorization, protocol,
or private input changes; the service continues to authorize owner/thread/session.

## Validation
Mounted viewer tests: menu changes and successful renewal retain media and input
readiness without another fit. Web build and focused lint. Manual visual validation
of hover, keyboard, narrow panes and actual divider resizing remains useful.

## Direct typing without opening controls
The canvas click handler explicitly opened the controls to focus their textarea.
Move the same committed-text/IME bridge outside the hidden menu, visually hide it
but keep it focusable, and focus synchronously with preventScroll after a permitted
page click. Closing the menu must not disable typing. Keep input authorization,
frame/focus validation and the existing queue; no global keyboard listener.

## Hover gap
The panel's top margin was outside its pointer hit area, while the overlay parent
uses pointer-events:none to leave the page usable. Crossing that margin therefore
fired mouseleave and closed the menu. Replace the margin with padding on a bounded,
pointer-active wrapper around the panel. This bridges the gap without intercepting
the rest of the browser or adding close timers.
