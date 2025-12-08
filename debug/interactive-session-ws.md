# Debug: Interactive session WS failure

## Environment
- OS / arch / versions: macOS (host), `bud` Rust agent (local build), service (`pnpm dev` pointing at local Postgres), web (`pnpm dev` via Vite).
- DB: local Postgres via Drizzle (previous migrations applied).
- LLM mode: n/a (manual session start via web UI).

## Repro steps
1. Start backend (`pnpm dev` in `service/`) and Bud (`cargo run -- --server ws://localhost:3000/ws --token DEV-LOCAL-ONLY`).
2. Start web (`pnpm dev` in `web/`), open http://localhost:5173, select Bud/thread, click “Start session”.
3. Observe console error: `WebSocket connection to 'ws://localhost:5173/term?...' failed: WebSocket is closed before the connection is established.` Vite proxy now forwards `/term`, and backend logs show GET /term hitting Fastify, but WS never upgrades.

## Observed
- Browser tries `ws://localhost:5173/term?...` (through Vite). Service logs show `incoming request` and we now log both SessionManager + term gateway saying `Client attached to session (role=writer)`.
- Despite backend accepting the client, browser still reports `WebSocket ... closed before the connection is established` (Strict Mode double-connect may be forcing an immediate close and re-open).

## Expected
- `/term` endpoint should upgrade to WS, sessionManager.attachClient should run, and the browser should transition to “connecting/open”.

## Hypotheses
1. **Fastify websocket plugin serves only the main `/ws` endpoint**: our custom `/term` handler uses the same `registerTermGateway(server, sessionManager)` but might not run before `server.register(websocketPlugin)` or lacks `reply.raw` lifecycle hook, though logs show route attaches.
2. **Proxy vs absolute URL**: Vite proxies `/term`, but when `VITE_API_BASE_URL` is unset we now talk to `localhost:5173` (good). However, fetches still call `http://localhost:3000` because `apiFetch` builds absolute URLs when `apiBaseUrl` is empty? (needs re-check; we might have bug: `buildApiUrl` returns `path` when `apiBaseUrl` is undefined, so fetch uses relative `/api/...` (correct).)
3. **SessionManager attach token mismatch**: maybe we open the WS before Bud finishes `session_opened`, so attach token is valid but sessionManager doesn’t yet know about the session. We currently set status to `opening`, but attachClient only checks `sessions` map, which is populated on createSession. That part seems fine.
4. **Handshake aborted due to missing `ws` option in proxy earlier**; now the backend sees GET /term but doesn’t run handshake because Fastify’s websocket plugin expects `connection` upgrade. Maybe Vite is initiating HTTP GET without `Upgrade: websocket` header (doubtful) or the backend route needs to call `socket.on("connection")`.
5. **Bud not yet sending `session_opened` before UI tries to attach**: attach occurs immediately after POST returns (before Bud ack). SessionManager status is “opening” but attachClient doesn’t wait; should accept attaches regardless. However, Bud might send session_opened later, so that’s OK.

## Proposed fix
- Capture actual network trace: ensure Vite dev server proxies `Upgrade` requests. If not, configure `ws: true`.
- Confirm `/term` route returns 101 upgrade by hitting via `wscat`.
- Possibly change frontend to use `buildWsUrl` targeting backend port directly (set `VITE_API_BASE_URL=http://localhost:3000` during dev) to bypass proxy.
- Add logging in `registerTermGateway` to confirm route handler runs and `socket.on('connection')` handshake succeeds.

## Next actions
- [ ] Verify Vite proxy logs / `wscat` to confirm WS upgrade path.
- [x] Add temporary logging inside `registerTermGateway` to see if `attachClient` runs (confirmed: backend sees attach and assigns writer).
- [x] Instrument client-side WebSocket effect to log `open/error/close` events to console for further debugging.
- [x] Default `VITE_API_BASE_URL` to `http://localhost:3000` during dev to bypass Vite proxy for `/term`, eliminating proxy-induced closes.
- [ ] If errors persist after the direct backend connection, inspect browser network trace for close codes and reconcile with backend logs.
