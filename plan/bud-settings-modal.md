# Plan: Bud settings modal (name, accent color, sessions as a tab)

## Context
- Follows `debug/bud-accent-color-flips-between-chats.md`: accent colors are now
  stable (id-hashed fallback + persisted at claim), but there is still no way
  for a user to *choose* a Bud's name or color.
- Today the only per-Bud UI is the **Terminal Sessions** modal
  (`web/src/components/bud-sessions-modal.tsx`), opened from the thread panel's
  Layers button (`thread-panel.tsx` → `onOpenSessions`) and owned by
  `routes/$budId.tsx` (`sessionsModalOpen`).
- Related spec files: `web/src/components/components.spec.md`,
  `web/src/components/workbench/workbench.spec.md`,
  `web/src/routes/routes.spec.md`, `web/src/lib/lib.spec.md`,
  `service/src/routes/routes.spec.md`, `service/src/db/db.spec.md` (no schema
  change expected — `display_name` and `accent_color` columns already exist).

## Objective
One **Bud settings modal** per Bud with tabs:
- **General** — display name + accent color (the only editable fields in v1)
- **Sessions** — the existing Terminal Sessions content, moved verbatim
- **Device** — read-only facts: daemon name, OS/arch, daemon version, status,
  last seen, bud id (copyable)

Acceptance:
- Renaming changes the label everywhere (rail tooltip, thread panel header,
  top bar) without a page refresh; re-connects of the daemon do not undo it.
- Picking a color updates the rail avatar and the `--bud-accent-*` theme
  immediately; it survives refresh, other devices, and daemon re-claims.
- The Layers button still lands the user on sessions in one click.
- Non-owners get a `404` from the write endpoint; nothing is globally readable.

## Design / Approach

### Naming semantics (important)
`bud.name` is **daemon-driven**: every `hello` re-sends the requested hostname
and the gateways re-resolve it via `resolveConnectedBudName` (`bud-name.ts`).
A user rename must therefore write **`display_name`**, never `name`. The API
already returns `display_name: bud.displayName ?? bud.name`, and the web already
labels with `display_name ?? name`, so the read side needs no change. Clearing
the display name (empty string / null) means "fall back to the daemon name" —
expose this as a **Reset** affordance next to the input.

### Service: `PATCH /api/buds/:budId`
- Auth: `requireViewer` → `getAuthorizedBud(viewer, budId)`; `404` if not owned
  (per AGENTS.md §4.6). Body (`snake_case`), all optional, at least one required:
  ```jsonc
  { "display_name": "studio mac" | null, "accent_color": "oklch(0.72 0.23 280)" }
  ```
- Validation (zod):
  - `display_name`: trim, 1..120 chars, or `null` to reset. Reject
    whitespace-only.
  - `accent_color`: an in-range `oklch(L C H)` string
    (`isValidBudAccentColor`, `src/bud-accent.ts`: L 0.55–0.85, C 0–0.35).
    Not arbitrary CSS: `getMutedColor` derives muted/soft variants by scaling
    oklch chroma (a hex value would flatten the theme), and the lightness
    range keeps black text legible on the tinted chips. The web offers the 5
    presets plus a hue slider at the palette's fixed L/C
    (`accentColorForHue`), so everything it can send passes.
- Response: `serializeBud(updated)` (same shape as the list item), so the web
  can upsert it straight into its bud list.
- No daemon interaction, no WS/SSE change; `display_name`/`accent_color` are
  browser-only concerns. Deploy-order independent.
- Owner stamping: the `bud` row already carries `created_by_user_id`; no new
  rows are written.

### Web
- **Rename** `bud-sessions-modal.tsx` → `bud-settings-modal.tsx` exporting
  `BudSettingsModal`; the current session list/close/confirm UI becomes a
  `SessionsTab` inside it (unchanged behavior, unchanged endpoints).
- Props:
  ```ts
  {
    bud: ApiBud                   // full API row (name, display_name, accent_color, os, arch, version, status, last_seen_at, bud_id)
    isOpen: boolean
    initialTab: 'general' | 'sessions' | 'device'
    onClose: () => void
    onNavigateToThread?: (threadId: string) => void   // sessions tab
    onBudUpdated: (bud: ApiBud) => void               // after a successful PATCH
  }
  ```
- **General tab**: display-name input (placeholder = daemon `name`, Reset link
  when a display name is set) and a swatch grid of the palette (selected =
  ring + check; hover previews nothing — keep it explicit). Save is one PATCH
  with only the changed fields; disabled until dirty; `MutationStatus` for
  success/error, consistent with the sessions tab.
- **State plumbing in `routes/$budId.tsx`**: today `buds` is derived purely from
  loader data. Add a small `budOverrides` map (`bud_id → ApiBud`) merged over
  `rawBuds` in the `buds` memo so `onBudUpdated` is instant; then call
  `router.invalidate()` so the next loader run reflects the server state (and
  clears the override on `rawBuds` change). The palette effect picks up the new
  `accentColor` automatically.
- **Entry points**:
  - Thread panel header: keep the Layers button → `onOpenBudSettings('sessions')`;
    add a `Settings2` icon button (same size/style) → `onOpenBudSettings('general')`.
    Also make the Bud name in the panel header a button → `'general'`.
  - Bud rail: no change in v1 (avatars stay pure navigation); long-press /
    context menu is a follow-up.
  - Mobile: same header inside the thread drawer.
- Modal chrome stays the existing neo-brutalist card; add a tab strip under
  the header (font-mono uppercase, active tab uses `--bud-accent-muted`, which
  doubles as a live preview when the user picks a color). Add `role="dialog"`,
  `aria-labelledby`, and Escape-to-close (the current modal has neither).

### Mockup
```
┌──────────────────────────────────────────────────────────────┐
│ BUD SETTINGS                                              [X] │
│ studio mac  ● Online                                          │
├──────────────┬──────────────┬────────────────────────────────┤
│  GENERAL     │  SESSIONS    │  DEVICE                         │
├──────────────┴──────────────┴────────────────────────────────┤
│ Display name                                                  │
│ ┌──────────────────────────────────────────┐  Reset           │
│ │ studio mac                               │  (daemon: mbp-2) │
│ └──────────────────────────────────────────┘                  │
│                                                               │
│ Accent                                                        │
│  (●) ( ) ( ) ( ) ( )    ← palette swatches, selected ringed   │
│                                                               │
│                                              [ Save changes ] │
├───────────────────────────────────────────────────────────────┤
│ Names and colors only change how this Bud appears to you.     │
└───────────────────────────────────────────────────────────────┘
```

### Risks and mitigations
- *Rename undone by the daemon*: prevented by writing `display_name` (see
  above). Add a test that a `hello` re-resolve leaves `display_name` untouched.
- *Color drift between client and server palettes*: both files carry a
  "MUST stay in sync" note; the server rejects colors outside its palette, so
  a stale client can't persist an unknown value.
- *Stale bud list after save*: instant override + `router.invalidate()`.
- *Losing the one-click sessions path*: Layers button keeps opening the
  Sessions tab directly.

## Spec Files to Update
- [x] `web/src/components/components.spec.md` — `bud-sessions-modal.tsx` → `bud-settings-modal.tsx` (tabs, props)
- [x] `web/src/components/workbench/workbench.spec.md` — thread panel header buttons/name button
- [x] `web/src/routes/routes.spec.md` — `$budId` modal state (`budSettings: { open, tab }`), `budOverrides`, invalidate flow
- [x] `service/src/routes/routes.spec.md` — `PATCH /api/buds/:budId` + `buds.test.ts` coverage
- [x] `plan/init-auth/validation-checklist.md` — new write path: owner-only PATCH (AGENTS.md §4.6)

## Impacted Contracts
- [ ] WSS protocol — none
- [ ] SSE events — none
- [ ] DB schema — none (`display_name`, `accent_color` exist)
- [ ] Agent tools — none
- [x] REST — new `PATCH /api/buds/:budId`
- [x] Web UI — modal restructure + thread panel entry points

## Test Plan
- Service (`routes/buds.test.ts`, node:test + `mock.method(db, …)` like
  `device-auth.test.ts`): owner PATCH updates and returns the serialized bud;
  non-owner → 404; invalid color / empty name → 400; `display_name: null`
  resets; `name` is never written.
- Service: gateway re-resolve keeps `display_name` — verified by inspection: no gateway/daemon-state code path references `displayName` (grep), so nothing can clobber it.
- Web: `theme-colors` already tested; modal is manual QA (no component test
  harness in `web/`): rename → label updates everywhere; color → avatar +
  theme update instantly and after refresh; Layers → Sessions tab; Escape
  closes; mobile drawer path.

## Rollout
- Service + web only; auto-deploys from `main`. No daemon release needed.
- Existing Buds: no migration — `GET /api/buds` already backfills a stable
  color for NULL rows; the first user pick persists it.
