# Phase 3: Web And Mobile Client Surfaces

## Objective

Expose proxied sites as a usable product surface in the web workbench and iOS
client. Users should be able to create/reuse a site, attach it to a thread,
view it embedded when browser policy allows, and fall back to standalone opening
when iframe auth is blocked.

## Scope

- Add web workbench web-view pane.
- Add hooks/state for Bud proxied sites and thread web-view attachment.
- Add manual open controls for host-local ports and paths.
- Add picker for existing proxied sites on the same Bud.
- Add iframe, standalone-open, reload, detach, disable, and copy/open controls.
- Add SSE handling for proxied-site and thread web-view events.
- Define iOS client API flow and hosted-web-view behavior.
- Add browser fallback messaging for blocked private iframe access.

## Non-Goals

- No public/password sharing.
- No agent-created generated UI yet.
- No browser automation/observation.
- No guarantee that all browsers permit embedded private access.

## Web Files

Expected new or changed files:

- `web/src/features/buds/use-proxied-sites.ts`
- `web/src/features/threads/use-web-view.ts`
- `web/src/features/threads/web-view-state.ts`
- `web/src/features/threads/web-view-flow.ts`
- `web/src/components/workbench/web-view-pane.tsx`
- workbench layout files that decide when the Web view tab is visible.

Use existing data-loading and SSE patterns instead of adding a separate global
store unless the current codebase already has an equivalent shared state
pattern.

## Web Pane Behavior

Primary states:

- No site attached.
- Creating or attaching.
- Loading viewer grant.
- Embedded iframe ready.
- Iframe auth blocked.
- Bud offline.
- Site disabled or expired.
- Unsupported daemon capability.
- Generic proxy error.

Controls:

- Port input.
- Optional path input.
- Title/display name input or generated display name.
- Create/open button.
- Existing site picker.
- Reload.
- Detach from thread.
- Disable proxied site.
- Open standalone.
- Copy URL.

Behavior:

- The pane attaches a thread to a proxied site, but disabling a site is an
  explicit site lifecycle action.
- Creating with `reuse_existing` should prefer an existing site for the same
  Bud/target/path.
- Opening embedded first requests a viewer grant from `bud.dev`, navigates the
  iframe to the bootstrap URL, and lets `bud.show` set cookies.
- If the iframe cannot authenticate, show a concise in-product fallback that
  opens the endpoint in a new tab/window.
- The fallback should not expose bearer tokens or raw grant values in user-copy
  text.

## Iframe And Standalone Policy

Iframe expectations:

- Chrome is acceptable for the first production target.
- Use a sandbox policy only if the local app still works for common dev server
  needs. Do not accidentally disable scripts/forms/popups that local apps need
  unless the security review requires it.
- Allow same-origin inside the iframe relative to `bud.show`, not `bud.dev`.
- Do not embed `bud.dev` API credentials into iframe URLs or postMessage data.

Standalone expectations:

- Opening top-level `bud.show` should be the reliable fallback.
- iOS can use a normal hosted web view and rely on the `bud.show` bootstrap
  route plus cookies.
- Mobile clients should not inject arbitrary bearer headers for page and
  subresource navigation.

## iOS Contract

The iOS client should:

1. Call the Bud API with the existing authenticated app session to create/reuse
   or fetch a proxied site.
2. Call `POST /api/proxied-sites/:proxied_site_id/viewer-grants`.
3. Open the returned `bootstrap_url` in the app's web-view surface.
4. Let `bud.show` set and refresh proxy viewer cookies.
5. Handle `bud.show` product error pages for offline/disabled/expired cases.

Do not require:

- Custom authorization headers on every subresource request.
- Native interception of all web-view requests.
- Sharing the `bud.dev` cookie jar with `bud.show` beyond normal browser/webview
  cookie behavior.

## SSE And State Synchronization

Consume events:

- `bud.proxied_site.created`
- `bud.proxied_site.updated`
- `bud.proxied_site.deleted`
- `thread.web_view.attached`
- `thread.web_view.detached`

Expected handling:

- Update the site picker when a site is created, updated, disabled, or expires.
- Update the active thread pane when an attachment changes.
- If the active site becomes disabled/expired/offline, leave the pane visible
  but switch to the appropriate state.
- Do not clear the durable site record just because the thread detaches.

## Accessibility And UX Constraints

- The Web view tab should expose the proxied site as the primary content, not a
  marketing-style explainer.
- Controls should be compact and familiar: inputs for port/path, icon buttons
  for reload/open/copy/detach/disable where existing icon conventions allow.
- Text must fit in mobile and desktop panes without overlapping the iframe or
  controls.
- Error states should be actionable and short.

## Tests

Add tests for:

- Create/open flow attaches a site to the current thread.
- Existing site picker attaches without creating duplicates.
- Detach removes the thread attachment but leaves the site enabled.
- Disable changes site lifecycle and updates active pane state.
- Viewer grant failure shows fallback/error state.
- Iframe blocked state offers standalone open.
- SSE updates refresh active pane and site picker.
- Owner-only route failures do not render another user's site metadata.

Manual validation:

- Chrome embedded iframe.
- Chrome standalone tab.
- Safari or Firefox fallback behavior if available.
- iOS top-level web-view opening.

## Spec Files To Update During Implementation

- `web/src/src.spec.md`
- `web/src/components/components.spec.md`
- relevant `web/src/features/*.spec.md`
- iOS specs/docs if this repository tracks client integration details
- `docs/proto.md` if SSE payload shapes are added or changed

## Acceptance Criteria

- A web user can create/reuse a proxied site from the Web view tab.
- A web user can attach an existing proxied site to multiple threads over time.
- The embedded iframe works in the supported browser path.
- The standalone fallback works when iframe private auth fails.
- iOS can open the proxied site through hosted auth without custom subresource
  headers.
- UI state follows SSE updates and ownership boundaries.
