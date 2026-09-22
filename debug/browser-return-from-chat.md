# Debug: return browser control from chat

## Observed
After taking private control, users can ask Bud to browse, but must find Return
to agent in the viewer menu before browser actions can continue.

## Approach
Expose the mounted viewer's existing return action to its owning thread route.
The chat's browser-paused notice offers Return to agent while that viewer owns
control, with the same busy/resize guards as the menu. Clear the action on control
loss, session end or unmount; other viewers and closed panes retain Open browser
controls. No automatic takeover, return, message submission or mutation retry.

The browser session remains owner/thread scoped. The existing authenticated
control endpoint reauthorizes the session and validates viewer identity, lease
and revision. No new route, wire contract or persisted identity is introduced.

## Validation
Mounted viewer regression: no action before acquisition, return uses the acquired
viewer identity, duplicate clicks dispatch once, success clears the action, and
unmount/control failure removes it.
