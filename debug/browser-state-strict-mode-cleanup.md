# Debug: Browser state socket closed during Strict Mode setup

## Environment and observed behavior

Development React/Vite web client, Phase 7f state feed. The supplied stack closes
state-feed.ts from effect cleanup through `doubleInvokeEffectsOnFiber`, before
the WebSocket handshake completes. Subscription currently creates the socket
synchronously; the development setup/cleanup/setup probe immediately closes it.
This warning alone does not establish a server failure. The reflow warning is a
separate performance observation without enough evidence to attribute a cause.

## Proposed fix

Defer initial socket construction to one microtask, shared by subscribers in the
same visit. Check for remaining subscribers before connecting. Strict Mode's
synchronous probe then creates only the surviving connection, and disposal before
startup creates none. Real unmounts still immediately fence/close existing sockets;
this does not suppress actual handshake errors or change reconnection/auth policy.
Update the browser spec and add mounted Strict Mode and early-disposal regressions.

## Validation

Implemented deferred initial construction. Mounted Strict Mode test confirms two
setups/one probe cleanup create exactly one socket; actual disposal closes it and
unsubscribe-before-start creates none. All 35 focused browser/client-recovery tests
pass; `pnpm --dir web exec tsc -b` and `git diff --check` pass. No live browser
verification or service restart performed. A real unmount during an already-started
handshake can still report a cancellation; genuine transport errors are unchanged.
