# Scroll capture scheduling

## Objective
Deliver screenshots during sustained wheel movement, rather than only after it
settles. Keep PNG quality and existing one-frame downstream credit.

## Approach
- A pending media demand joins the same FIFO CDP lock as input, with a bounded
  one-second wait. Reauthorize after waiting and before delivery. No parallel CDP
  channel, operation replay, or new scheduler.
- Pace capture starts at least 100ms apart; capture/transport time counts toward
  the budget. No unconditional sleep after sending and no accumulated catch-up.
- Deliver same-document/same-size captures even when scroll offsets changed
  during capture. Internally mark those viewports unstable: they can authorize
  continued wheel movement but not click/text/key/back. A subsequent settled
  capture restores ordinary input. Resize/navigation still discard captures.
- Every busy/discard outcome uses the normal authorization/delivery path.

## Contracts and rollout
Existing service-authorized session/controller and media ticket own all access.
No routes, schema, wire fields, or viewer code changes. New daemon works with old
service; old daemon retains old scheduling. Restart/rebuild Bud for full effect.
No image-quality changes, WebRTC, extra buffering or optimistic canvas scrolling.

## Validation
Real Chrome continuously moving page produces frames, unstable captures reject
clicks, settled capture restores input. Retain existing private input, resize,
epoch/renewal and navigation tests. Document hardware/network smoothness separately.

Relevant spec: [browser runtime](../../bud/src/browser/browser.spec.md).
