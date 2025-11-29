# Debug: Terminal UI shows “Terminal unavailable for this Bud”

## Environment
- Web UI built from `web/src/App.tsx` (terminal-only view).
- Backend terminal feature enabled? (server logs not checked yet).
- Bud with tmux-enabled capabilities present (bud_id: b_01K9XX1BMTHW3WHF2D3PAWS3AP).

## Observed
- UI banner: “Terminal unavailable for this Bud.”
- Network console: `POST /api/terminals/{budId}/ensure 400 (Bad Request)` and `GET /api/terminals/{budId}/history?bytes=8192 400 (Bad Request)` (origin http://localhost:5173 via Vite proxy).
- xterm errors (`Cannot read properties of undefined (reading 'dimensions')`) appeared earlier when fit was invoked against a null or unmounted pane.

## Hypotheses
1) **Feature flag off in service**: `TERMINAL_ENABLED` defaults to false; the terminal routes return 400 “terminal_disabled”, leading to UI showing unavailable and failed ensure/history calls.
2) **Proxy target mismatch**: Vite proxy is not configured to forward `/api/terminals/*` to the backend; calls hit the frontend dev server and get 400. Need to confirm dev server proxy config.
3) **Capabilities gating**: Bud hello caps may not include `terminal`/`terminal_backends` in the backend’s `/api/buds` response; UI capability detection falls back to “unsupported”.
4) **xterm init timing**: The terminal element may be unmounted or fitAddon not initialized when `reset` runs, causing dimensions errors and the overlay logic to assume terminal is unavailable. Could be triggered by re-renders during failed ensures.

## Next checks
- Verify backend logs for terminal routes: do we see “terminal_disabled” 400s? Ensure `TERMINAL_ENABLED=true` in service.
- Inspect Vite proxy/config for `/api/terminals` paths; curl directly to backend (`http://localhost:3000/api/terminals/{budId}/ensure`) to rule out proxy issues.
- Confirm `/api/buds` payload includes `terminal: true` or `terminal_backends:["tmux"]` for the Bud; if not, fix capability advert/report.
- Add defensive checks around xterm init (ensure pane ref exists before open/fit) after addressing 400s. 
