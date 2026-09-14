# Debug: web auto-scroll does not resume after disclosure

## Reproduction
In the local web app, expand a work/activity section during streaming, scroll back
to the bottom, and observe whether subsequent output follows.

## Current evidence and hypotheses
Disclosure disables following. Only scrollend with an active gesture and a bottom
gap under 48px re-enables it. We have not established which condition failed.
Possibilities: gesture cleared by another interaction; output grew before scrollend;
scrollend targets an inner scrollable tool payload; following resumes but a pending
frame is blocked by gesture/selection; no subsequent resize schedules catch-up.
Do not change policy until the reproduction distinguishes these cases.

## Diagnostics
Development builds emit `transcript-scroll` console entries, capped at 300 per
mounted viewport, with a viewport ID, monotonic time, geometry, follow/gesture/frame
state and selection state. Log disclosure, gesture start, bottom-threshold crossings,
scrollend (including ignored reasons), content resize, follow scheduling/execution
and blocked frames. Capture descendant scrollend in capture phase to distinguish
inner payload scrolling from transcript scrolling. No text, keys, URLs or IDs from
messages are logged; measurements stay outside React state.

Reload the local app, clear the browser console, filter `transcript-scroll`, then
reproduce once while output is still arriving. Preserve entries from the disclosure
through several updates after returning to the bottom. Diagnostic capture does not
change follow or gesture decisions. Remove these temporary logs after diagnosis.

## Outcome
The user repeated the scenario successfully. No follow-policy change was made.
Temporary diagnostics were removed before PR preparation; the capture description
above records the investigation, not instrumentation retained in the build.
