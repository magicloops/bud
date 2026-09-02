# Debug: Bud accent colors flip when switching between chats on different buds

## Environment
- Prod web UI (deployed from `main`) against the deployed service
- Reproduces when the account has ≥ 2 buds, most readily when more than one is
  online (heart-beating); no LLM involvement

## Repro Steps
1. Have two or more buds, switch between conversations that live on different
   buds (bud rail or thread panel).
2. Sometimes the newly selected bud's accent (rail avatar, thread panel accent,
   user-message border, hover tints, top-bar active tab) shows the wrong color.
3. Re-clicking the same bud/conversation, selecting a different conversation, or
   refreshing the page corrects it.

## Observed
- Accent shows one color, then the wrong color, then self-heals on the next
  navigation.
- All accent surfaces flip together (rail avatar + `--bud-accent-*` consumers),
  i.e. the whole assignment moves, not a single stale component.

## Expected
- Each bud has one stable accent color, everywhere, across navigations.

## Hypotheses

### 1. Primary (confirmed by code read): index-based fallback colors over a volatile list order
Accent colors are, in practice, **positional**, and the position is unstable:

- `bud.accent_color` is NULL for every bud. The service only *reads* the column:
  the sole references are the schema definition (`service/src/db/schema.ts:83`)
  and the serializer (`service/src/routes/buds.ts:29`). **No code path ever
  writes `accentColor`** — not device claim, not settings.
- So the web always lands on the fallback: `DEFAULT_AVATAR_COLORS[index % 5]`
  where `index` is the bud's position in the `/api/buds` response
  (`web/src/routes/$budId.tsx:126-135`, and again for the theme palette at
  `:145-152`). 5 colors, assigned by array position.
- `/api/buds` orders by `desc(budTable.lastSeenAt)`
  (`service/src/routes/buds.ts:48-53`). `lastSeenAt` is bumped on every daemon
  heartbeat (`service/src/ws/bud-connection.ts:606`, every ~30s per bud —
  `WS_HEARTBEAT_SEC`, `service/src/config.ts:177`), on connect
  (`runtime/daemon-state.ts:207`), on disconnect (`bud-connection.ts:1139`), and
  from the gRPC gateway (`control-gateway.ts:500,991`).
- Every navigation to `/$budId` (i.e. every chat switch) re-runs the route
  loader, which refetches `/api/buds` (`$budId.tsx:71`). With two online buds
  heart-beating, their `lastSeenAt` values leapfrog between fetches, so
  successive loader runs can return the buds in different orders → every bud's
  fallback color reshuffles.

This explains every symptom:
- **Wrong color after switching chats**: the switch refetched the list in a new
  order; the bud you selected now sits at a different index.
- **Re-click / selecting another conversation fixes it**: that's another loader
  run; the order flips back (or you re-learn the assignment).
- **Page refresh fixes it**: fresh fetch, order re-derived.
- **Everything flips together**: the rail avatars and `--bud-accent-*` theme
  both derive from the same reshuffled array, consistently wrong.

Side effect of the same root cause: the bud rail's *ordering* itself can jump
between navigations (buds swap places every heartbeat leapfrog), which is
questionable UX independent of color.

### 2. Secondary: stale global CSS vars during the navigation window
`--bud-accent-{vibrant,muted,soft}` are set on `document.documentElement` in a
`useEffect` after the new match renders (`$budId.tsx:155-160`). During a pending
navigation the previous bud's inline values persist, so the UI briefly shows the
old accent before the effect fires — the observed "one color, then the wrong
color" sequence is (old bud's accent) → (reshuffled wrong accent). Also, the
inline overrides are never removed on unmount, so non-bud pages (settings, auth
shell, index) keep whatever bud accent was last applied instead of the
`index.css` defaults (`web/src/index.css:52-54`). Cosmetic, but part of the
same mechanism.

### 3. Ruled out / minor
- `deriveBudPalette`/`resolveCssVar` (`web/src/lib/theme-colors.ts`): resolves
  `var(--*)` at derive time; for literal `oklch(...)` strings it passes through
  unchanged. Deterministic — not the flip. (Note: for a non-oklch literal, e.g.
  a hex value someone sets in the DB later, `getMutedColor` silently returns the
  input, so vibrant == muted == soft. Latent, unrelated.)
- Router loader caching/preload: `createRouter({ routeTree })` with defaults
  (`web/src/main.tsx:17`) — no `defaultPreload`, no stale-while-revalidate
  weirdness. The loader re-runs per navigation; the problem is what it returns,
  not when.

## Proposed Fix
Options considered at investigation time, cheapest first (see Resolution below):

1. **Client-side stable assignment (smallest change)**: derive the fallback
   color from a stable hash of `bud_id` instead of the list index
   (`DEFAULT_AVATAR_COLORS[hash(bud_id) % 5]`) in both places that index today
   (`$budId.tsx` buds memo + palette memo — ideally one shared helper in
   `theme-colors.ts`). Colors become order-independent immediately; no server
   change, no migration. Small collision chance across buds (5 colors) but the
   *same* bud always gets the *same* color.
2. **Stable list ordering**: order `/api/buds` by `createdAt`/`budId` (or sort
   client-side before assigning colors). Fixes the rail-reordering side effect
   too, but changes list UX (no more most-recently-seen-first) and, alone, still
   couples color to position.
3. **Durable accents (real fix)**: assign and persist `accent_color` at device
   claim (pick from the palette, e.g. hash- or round-robin-based), so the column
   stops being universally NULL and colors survive any ordering, any client.
   User-editable later. Requires a small service change; no schema change
   (column exists).
4. Optionally, independent cleanup: reset `--bud-accent-*` inline vars on
   `$budId` unmount so non-bud pages fall back to the `index.css` defaults.

Recommended: 1 now (kills the bug), 3 as the durable follow-up; 2/4 optional.

## Spec files affected
- `web/src/routes/routes.spec.md` (accent derivation note) — if/when fixed
- `web/src/lib/` spec (shared color helper) — if option 1 lands there
- `service/src/routes/routes.spec.md` — only if ordering (2) or claim-time
  assignment (3) changes the service

## Resolution (2026-09-01)
Options 1 and 3 implemented (PR #107), then revised the same day: the first
cut hashed `bud_id` into the palette, which is order-independent but with 5
colors collides ~20% of the time — an account with two Buds got the same
color. The positional scheme was the right idea; only its key was wrong.

Final rule, identical on both sides: colors are assigned positionally by
**creation order** (`created_at`, `bud_id` tiebreak — both creation-ordered),
first Bud pink, second orange, …, skipping colors already persisted for other
Buds. Creation order never changes, so the assignment never flips.
- **Web**: `withFallbackAccentColors(buds)` (`web/src/lib/theme-colors.ts`)
  resolves missing accents in `routes/$budId.tsx` before anything reads them;
  only matters against an older service.
- **Service**: `src/bud-accent.ts` — `GET /api/buds` resolves legacy NULL rows
  with the same function (wire value never NULL, never `last_seen_at`
  dependent); device claim persists the next free color after resolving the
  owner's other Buds (`routes/device-auth.ts`); re-claims keep the existing
  color. Dev-bypass enrollment and seed rows stay NULL and resolve at read
  time. Tests: `bud-accent.test.ts`, `routes/buds.test.ts` (GET ordering),
  `routes/device-auth.test.ts`.
- 2026-09-02: `/api/buds` now orders by `created_at` asc (`bud_id`
  tiebreak) — the rail no longer reshuffles between navigations, and rail
  position matches the positional accent order. Still not changed: the
  `--bud-accent-*` inline-var cleanup on unmount (hypothesis 2 transient).
- Follow-up: user-editable name/color via a Bud settings modal —
  `plan/bud-settings-modal.md`.
