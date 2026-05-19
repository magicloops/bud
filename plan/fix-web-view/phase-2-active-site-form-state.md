# Phase 2: Active Site Form State

## Context

The Web view header shows editable Host, Port, Path, and Name controls. Those
controls are currently independent local state with a `5173` default. Selecting
or opening another proxied site can leave the Port input showing the previous
value even though the active site title uses the selected site's real target.

## Objective

Make the Web view form values reflect the active proxied site after site
selection or attachment, without clobbering a user's in-progress edits for the
same active site.

## Scope

- Sync `WebViewPane` form values from `activeSite` when the active proxied site
  id changes.
- Keep `localhost:5173/` as the no-active-site default.
- Keep the current Open flow and form layout.
- Ensure the visible Port value is the value submitted by Open.

## Non-Goals

- No durable edit-in-place endpoint for existing proxied-site targets.
- No new active-site settings screen.
- No service API changes.
- No mobile changes.

## Implementation Steps

1. Add a small form-state synchronization path in
   `web/src/components/workbench/web-view-pane.tsx`.
2. Track the last active proxied site id used to seed the form, or an
   equivalent dirty-state guard.
3. When `activeSite?.proxied_site_id` changes:
   - set Host from `activeSite.target_host`
   - set Port from `String(activeSite.target_port)`
   - set Path from the active path value used by the current pane, falling back
     to `/`
   - leave Name blank, because it is an optional label override for the next
     Open action rather than an active-site edit field
   - clear the dirty-state guard for the new site
4. When the user edits any form field, mark the current form dirty so normal
   rerenders for the same active site do not overwrite typing.
5. When there is no active site, keep the existing default values.
6. Ensure site-picker selection and successful Open both leave the form aligned
   with the newly active site.
7. Update `web/src/components/workbench/workbench.spec.md` and
   `web/src/features/threads/threads.spec.md` as needed.

## Product Notes

- The current control surface behaves like "open or switch to a local app",
  not a persisted settings editor. This phase should not imply that changing a
  field edits the existing site until the user clicks Open.
- The Name field should stay blank when syncing from an active site. That keeps
  the active header as the place that shows the existing display name, while
  Name remains an optional override for the next Open request.

## Test Plan

Automated, if practical:

1. Render `WebViewPane` with active site A on port `5173`; assert the Port input
   is `5173`.
2. Rerender with active site B on port `3000`; assert the Port input becomes
   `3000`.
3. Edit the Port input for active site B; rerender with the same active site;
   assert the edited value is preserved.
4. Rerender with active site C; assert the form syncs to site C.

Manual:

1. Open a proxied site on `5173`.
2. Open or select a proxied site on another port.
3. Confirm the active header and editable Port input agree.
4. Type a custom port but do not submit; confirm unrelated state updates do not
   reset the field.
5. Click Open and confirm the submitted target matches the visible form values.

## Acceptance Criteria

- The Port input reflects the selected active site's target port.
- Switching between sites does not leave stale host/port/path values behind.
- User edits are not overwritten during ordinary rerenders for the same site.
- Open submits the visible form values.
