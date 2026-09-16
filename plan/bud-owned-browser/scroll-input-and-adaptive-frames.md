# Independent scrolling and adaptive screenshots

## Contract
The service's existing owner/controller/connection/epoch guards authorize input.
Scrolling additionally requires the current target, document and viewport context,
but not a recent screenshot or frame delivery ACK. Click/text/key/back retain
current, stable, recent-frame guards. No automatic retry of uncertain mutations.

Keep frame_token opaque to service and viewers. New daemon tokens contain a random
viewport-context prefix and a frame suffix. Only the daemon interprets them:
scroll validates the context, other input validates the entire token. The context
survives scroll offsets and image quality changes, and rotates on target/document/
size changes or existing reference invalidation. This removes the 32-record
superseded-frame history instead of layering another fallback on top of it.
Old services/viewers carry the opaque string unchanged; old daemons keep their
old behavior. No new enum/field/capability or DB migration is required.

## Capture
After successful human wheel dispatch, use existing JPEG quality 65, at most 1x
and 1280 pixels on the longest edge for 250ms. Further successful wheels extend
that interval. Then normal demand automatically restores negotiated PNG/density.
No new timer, scheduler, media queue, lower idle rate or image diffing in this
change. Capture quality never changes CSS viewport size, focus or scroll context.
Reset the motion timer with reference invalidation. Keep the existing 10fps budget.

Canvas CSS dimensions track remote CSS dimensions independently of bitmap density,
so switching JPEG/PNG cannot change the apparent page size or input coordinates.

## Validation
Live Chrome: old displayed tokens keep scrolling despite newer captures and aged
capture timestamps; clicks still reject those tokens; document/resize/control
invalidation reject old contexts. JPEG while moving, sharp PNG after 250ms,
unchanged CSS dimensions, context and focus. Existing browser authority tests,
web tests and builds. Measure perceived smoothness and input failures locally.

## Ownership / rollout
No new resource or endpoint: existing authenticated session/controller remains the
owner boundary. No private page content enters logs or transcript. New daemon with
old service works using already accepted opaque frame_token and JPEG/PNG forms;
new service/web with old daemon retains old behavior. Rebuild Bud and refresh web.
