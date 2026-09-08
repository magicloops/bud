# Debug: Proxy open timeout from suspended dashboard server

## Environment / reproduction
September 7, 2026, local bud-dev and neo-contacts Vite app. Open authenticated
bud-show.test preview on target 127.0.0.1:5174 after moving from 5173.

## Observed
Both old Vite PID 33014 (5173) and new PID 36947 (5174) are in macOS ps state
TN: stopped, nice priority. Their listening sockets remain open, but direct
curl requests time out after five seconds with no response bytes. Bud web on
[::1]:5173 responds 200 immediately. The daemon still answers terminal observe
requests in milliseconds. A further Vite process PID 37254 is running; inspect
its actual port before assuming the requested port was acquired.

## Hypothesis and fix
A suspended target accepts no HTTP work despite retaining its listening socket.
Vite permits automatic port fallback, obscuring stale listeners. Resume the
exact suspended target to confirm; use a detached noninteractive launch with
strictPort for a durable fix if it suspends again. Preserve other Bud services.

## Resolution
SIGCONT of PID 36947 immediately returned to TN. SIGTERM plus SIGCONT also
failed to release its listener. First detached launch correctly failed with
`Error: Port 5174 is already in use` (strictPort), logged in
/tmp/neo-contacts-vite-5174-detached.log. Killed only the confirmed suspended
5174 Vite process, then launched Vite with stdin=/dev/null, a new session,
--host 127.0.0.1 --port 5174 --strictPort. PID 37576 now serves HTTP 200 in
17 ms. Further process PID 37254 was found on 5175 and left untouched.
No Bud service/daemon restart, site mutation or auth bypass. Authenticated
browser retry remains necessary to confirm the complete preview path.
