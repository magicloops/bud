# Debug: Browser viewer reconnects in HTTP development

## Environment and reproduction

macOS, local PostgreSQL, real LLM, `pnpm dev` on main `2f1b2af` and a matching
foreground daemon connected to `ws://localhost:3000/ws`. Open a browser task's
viewer at `http://localhost:5173`.

## Observed

The agent opens example.com and reads its heading successfully. Viewer sockets
open but receive no frames, then the service closes each media group with
`reason: ticket_expired`, `frames: 0`, after approximately five seconds.
`curl http://localhost:5173/ws/browser-media` returns HTTP 200 and the Vite HTML
shell instead of reaching the service's WebSocket route.

## Cause and fix

The HTTP launcher uses port 5173 as `BETTER_AUTH_URL`. The service derives its
daemon media endpoint from that public origin, but Vite proxies only discovery,
API, ingestion and terminal paths. `/ws/browser-media` never reaches the service,
so the daemon cannot consume its one-use media ticket. Proxy `/ws` HTTP requests
and WebSocket upgrades to the existing configured API target.

## Ownership and rollout

This adds development forwarding for existing service routes. Browser workspaces
remain owned by their thread/Bud owner. The service resolves the signed-in viewer
and checks Origin/ownership before viewer upgrades; daemon media requires the
one-use ticket bound to its authenticated carrier and workspace generation.
The proxy grants no authority and writes no rows. No schema or protocol change.
Restart Vite (normally automatic after a config edit) and reload the viewer;
no daemon rebuild or profile reset is required.

Related spec: [web](../web/web.spec.md).

## Validation

Before the fix, `pnpm exec tsx --test vite.config.test.ts` failed with
`Browser media upgrade did not reach the service`. The test starts the actual
Vite configuration and requires a successful upgrade at the loopback service.

- After the fix, `pnpm test:dev-proxy` passes with HTTP 101 from the upstream.
- `pnpm build` in `web/` passes (existing bundle-size warning only).
- `git diff --check` passes.
- Live acceptance on 2026-10-15: the existing example.com test workspace renders
  its page in the browser pane and reports “Watching agent.” The viewer logs
  `frame_presented` and ACKs for JPEG at 645 ms and PNG at 1080 ms, instead of
  expiring at zero frames. No service or daemon code changes were needed.
