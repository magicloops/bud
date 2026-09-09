# Plan: Stable proxy origins and owner-authorized links

## Context and diagnosis
See [proxy spec](../service/src/proxy/proxy.spec.md), [routes](../service/src/routes/routes.spec.md), and [debug note](../debug/proxy-origin-links.md).
Path-based reuse created separate hosts; mobile recognized only the current thread attachment. Paths already forward unchanged.

## Design and ownership
Reuse the oldest enabled site for an exact owner/Bud/host/port tuple, independent of path. Keep all existing rows and hostnames; no migration or disabling aliases. Paths remain per opening/attachment. Existing expiry and disable controls still apply.
Add authenticated GET /api/proxied-sites/resolve?endpoint_host=... with exact hostname plus owner SQL filtering, returning site metadata or 404. No global list, no network fetch of the supplied host, no thread mutation. Viewer grants continue to stamp the acting user and enforce site state.
Web and mobile resolve clicked HTTP(S) hosts through the app API, then mint a fresh grant with the clicked path/query/fragment. Unmatched links retain external navigation. Failures must be visible; stale mobile requests must not open after thread changes.

## Validation
Test origin reuse, retained aliases, owner isolation, deep paths/query/fragment, unsafe redirect rejection, and client link routing. Build service/web/mobile. Device validation: old message link, another thread/site/Bud, external link, expired/disabled site, sign-out and rapid thread switch.

## Rollout
Service first, then mobile. No daemon or schema changes. Old clients keep attachment/grant APIs. New resolver is additive. Existing hostname continuity remains subject to explicit disable, expiry, and local server availability.

## Validation results

Service/web builds passed; 37 service proxy/route tests and 3 web resolver tests passed. Changed web files pass ESLint. iOS simulator build and 8 focused WebProxyModelsTests passed (including historical-site opening, attachment preservation, encoded path/query/fragment, external fallback, and reset cancellation). Device/authenticated browser end-to-end verification remains after deployment. No production writes or commits.
