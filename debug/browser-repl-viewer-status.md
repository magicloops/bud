# Debug: REPL browser opens while viewer reports unavailable

## Environment and reproduction

macOS development service and daemon, REPL browser tools enabled. On September
23, 2026, thread `3297763e-fb32-403d-b30b-57baa1594e72` asked to open Reddit.
The pane reported “Could not refresh browser status. Check the Bud connection
and retry.” Session: `browser_01M382H84TRXDV01B3K7A0G0M7`.

## Observations

- Daemon ensure completed at 21:25:19 UTC; the connection stayed online.
- The thread transcript confirms successful `browser.tabs.open`, owned-tab
  listing, title/URL reads, and a screenshot emitted to the agent.
- Three snapshot calls passed `scope: 'interactive'` and failed with
  `browser_stale_reference`. Scope is a reference to an observed container,
  not a snapshot mode. The catalog listed the optional argument without
  explaining its meaning. The helper's `resolve_page` diagnostic stage also
  covers this validation failure; it does not prove the tab is missing.
- The database session was `ready`. These failed cells did not mark Chrome
  interrupted.
- The viewer message comes from its status/ensure catch block, before media
  attachment. It can represent a failed status GET, ensure POST, subsequent
  status GET, or a client exception. The daemon excerpt cannot distinguish them.

## Proposed fix and remaining evidence

Clarify the REPL catalog: start with `tab.snapshot()` and filter the result
locally; optional scope must be a returned container reference. This corrects
the demonstrated API misunderstanding, but does not establish or fix the viewer
failure. No new scope modes or automatic replay are needed.

Before changing viewer recovery, obtain the failing request's HTTP status and
response body (and any client exception) from the web app Network/Console panel.
Keep status failure separate from Chrome health and from semantic call failures.
Do not reset the profile, private authority, or session based on this message.

Related specification: [agent](../service/src/agent/agent.spec.md).

## Confirmed viewer cause

The user supplied `origin_denied` from POST `/api/browser/sessions/.../ensure`
on `https://localhost:3443`. The running launcher is `pnpm dev:ngrok`.
Both `local-dev.mjs` and its child `local-https.mjs` replace the trusted-origin
setting with the public app origin plus HTTP localhost ports, omitting local
HTTPS when the public app origin is ngrok. The browser route rejects that POST
before daemon dispatch; agent calls do not use this browser-facing origin check.

Use one explicit development-origin list in both launchers, including
`https://localhost:3443`. Preserve the ngrok OAuth issuer/audience and the exact
origin check; do not trust request Host headers or arbitrary origins. Restart
the development launcher to replace its inherited environment. No daemon rebuild
or profile reset is required.
