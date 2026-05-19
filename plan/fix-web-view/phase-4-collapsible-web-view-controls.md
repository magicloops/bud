# Phase 4: Collapsible Web View Controls

## Context

`WebViewPane` currently renders two fixed header rows:

1. A compact top header with the active site title plus icon buttons for Reload,
   Open standalone, and Detach.
2. An always-visible action form with Site, Host, Port, Path, Name, and Open.

The action form is useful, but it takes vertical space from the embedded app and
adds visual noise during the common path where a user is only viewing an already
attached site. The controls should be available on demand through a settings
button in the top header.

Related docs:

- [implementation-spec.md](implementation-spec.md)
- [phase-1-preserve-web-view-iframe-lifecycle.md](phase-1-preserve-web-view-iframe-lifecycle.md)
- [phase-2-active-site-form-state.md](phase-2-active-site-form-state.md)
- [phase-3-reconnect-transport-refresh.md](phase-3-reconnect-transport-refresh.md)

## Objective

Hide the Web view action form by default while keeping it one click away from
the top header. The change should make the embedded app area denser without
affecting iframe lifecycle, viewer grants, active-site sync, or reconnect
recovery.

## Scope

- Add a settings/tuning icon button to the top Web view header next to Reload,
  Open standalone, and Detach.
- Use that button to toggle the Site/Host/Port/Path/Name/Open controls.
- Keep the controls collapsed by default.
- Preserve current form behavior when expanded:
  - active-site state sync
  - site picker
  - host/port/path/name inputs
  - Open submit behavior
  - disabled/loading states
- Keep the iframe mounted and unchanged when the controls open or close.

## Non-Goals

- No service, daemon, or proxy protocol changes.
- No changes to one-time viewer-grant semantics.
- No changes to Web view reload/reconnect recovery.
- No durable user preference for expanded/collapsed state in this phase.
- No redesign of the site picker or form fields.
- No change to the in-pane "Open in new tab" fallback unless later UX review
  chooses to remove or restyle it.

## Current Implementation Notes

- `web/src/components/workbench/web-view-pane.tsx` owns all presentation for
  the top Web view header and action form.
- The top header currently imports and renders `RefreshCw`, `ExternalLink`, and
  `Unplug` icon buttons.
- The action form is an unconditional sibling below the top header:
  `Site` select, `Host`, `Port`, `Path`, `Name`, and `Open`.
- Form state is already React-owned in `WebViewPane`, so conditionally rendering
  the form row should not lose field values as long as the state remains in the
  parent component.
- The iframe is below the action row and already keyed by `iframeUrl`; toggling
  the form must not change that key or `iframeUrl`.

## Design / Approach

### Top Header Settings Button

Add a compact icon button in the existing top-header action group.

Recommended shape:

- icon: `Settings2`, `SlidersHorizontal`, or the closest existing Lucide
  settings/tuning icon
- `title`: `Web view settings`
- `aria-expanded`: reflects whether the controls are open
- `aria-controls`: points at the controls row id
- active visual state when expanded, matching existing ghost icon-button style

Button order should keep destructive/navigation controls predictable. A
reasonable first order is:

- Settings
- Reload
- Open standalone
- Detach

### Collapsed By Default

Add local component state in `WebViewPane`:

```ts
const [controlsOpen, setControlsOpen] = useState(false)
```

The action form row should render only when `controlsOpen` is true. This keeps
the default Web view focused on the embedded page.

Do not auto-expand just because there is no active site in this phase. The
settings button remains the explicit way to open the action controls.

### Preserve Existing Behavior

When controls are expanded:

- Site selection still calls `onSelectSite`.
- Open still calls `onOpenLocalApp(...)`.
- Form fields still sync from `activeSite` when the active site changes.
- Loading and unavailable transport disabled states remain unchanged.

When controls are collapsed:

- Existing top-header actions continue to work.
- Product-visible status banners continue to render below the top header.
- The iframe area grows vertically because the action row is absent.
- No viewer grant should be minted and no iframe should reload solely because
  the controls were toggled.

## Implementation Steps

1. Update `web/src/components/workbench/web-view-pane.tsx`.
2. Import the chosen Lucide settings/tuning icon.
3. Add local `controlsOpen` state, defaulting to `false`.
4. Add a settings icon button to the top header action group with accessible
   toggle attributes.
5. Wrap the current action form row in a conditional render keyed by
   `controlsOpen`.
6. Keep form state declarations at the `WebViewPane` component level so values
   survive collapsing and expanding.
7. Verify the settings toggle does not change `iframeUrl`, call `onReload`, or
   trigger `onOpenLocalApp`.
8. Update `web/src/components/workbench/workbench.spec.md`.

## Edge Cases

- If no active site exists, the empty Web view state remains visible and the
  settings button opens the form for creating/selecting a site.
- If the user closes the controls while an input is focused, focus may return to
  the page naturally; no custom focus management is required for the first pass.
- If a site changes while controls are collapsed, form state should still sync
  so the values are correct when reopened.
- If loading starts while controls are open, existing disabled states remain.

## Test Plan

Automated, if practical:

1. Render `WebViewPane` and assert the action row is hidden by default.
2. Click the settings button and assert Site/Host/Port/Path/Name/Open controls
   appear.
3. Click the settings button again and assert controls are hidden.
4. Assert toggling settings does not call `onReload`, `onOpenLocalApp`,
   `onOpenStandalone`, `onDetach`, or `onSelectSite`.

Manual:

1. Open a thread Web view.
2. Confirm only the top header actions are visible by default.
3. Click the settings/tuning icon and confirm the action form appears.
4. Change/select a site or port and confirm Open still works.
5. Collapse and expand again; confirm field values remain synchronized.
6. Confirm toggling the controls does not reload the iframe.
7. Confirm Terminal/Web tab switching still preserves the iframe.
8. Confirm reconnect recovery behavior from Phase 3 still works.

Recommended package checks:

```bash
pnpm --dir /Users/adam/bud/web test
pnpm --dir /Users/adam/bud/web lint
pnpm --dir /Users/adam/bud/web build
```

## Acceptance Criteria

- The Site/Host/Port/Path/Name/Open row is hidden by default.
- A settings/tuning icon in the top header toggles the row open and closed.
- Existing form behavior is unchanged while the row is open.
- Toggling the row does not remount or reload the iframe.
- No service, daemon, DB, Cloudflare, or mobile contract changes are required.
