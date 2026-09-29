# Debug: hidden rendering configuration

## Environment and reproduction

Same isolated macOS/Chrome 154 fixture as the [capture gate](browser-screencast-capture-gate.md).
Run `node spikes/browser-streaming/run.mjs --headless --seconds=3 --input=wheel`
to separate a physical window from Chrome's internal selected/hidden lifecycle.

## Observations and hypotheses

Initial headless trials also stop after internal minimization; changing process
mode alone may not remove target visibility scheduling. Target-scoped focus
emulation may retain rendering without activating a native window. Compare it
before adopting process-wide flags or a different browser runtime.

Source research command `python3 /tmp/bud-rendering-research.py` retrieved the
emulation handler but a second Chromium source request returned
`HTTP Error 503: Service Unavailable`. The retrieved handler is sufficient for
the focus-emulation hypothesis; any needed switch definitions will be retried
against the official source separately.

## Proposed investigation

Add an explicitly experimental focus-emulation option to the local probe,
record installed method support, actual wheel effects and window state. Measure
OS foreground state without activating applications. Disable emulation on the
same attachment and inspect cleanup. See the [investigation plan](../plan/browser-streaming/rendering-investigation.md).

## Outcome

Eight local runs are summarized in the investigation. Focus emulation plus
idle-selected background targets supports minimized streaming and native wheel
effects; macOS background launch avoids observed Chrome foreground activation.
Headless alone and the matched no-focus-emulation control fail. Process-wide
background switches do not repair selected/minimized capture and are unnecessary
for the working candidate. Disabling emulation restores hidden visibility but
not `hasFocus(): false`; detach resets viewport geometry. These remain explicit
production lifecycle/provenance follow-ups. The source-research 503 was resolved
by reading the official Chromium GitHub mirror; no app build/run failure occurred.

## Scoped lifetime follow-up

Implemented the next source-only experiment in
[scoped-rendering-lifetime](../plan/browser-streaming/scoped-rendering-lifetime.md).
`node spikes/browser-streaming/run.mjs --lifecycle` passed repeatedly. Assigning
viewport metrics to the persistent command attachment instead of the retiring
source avoided the previously measured detach reset. Source loss is explicitly
reported as unacknowledged cleanup even though the fixture becomes hidden.
No daemon/service behavior or private authorization contract has changed.
