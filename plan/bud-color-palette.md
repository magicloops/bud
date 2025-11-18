# Plan: Bud Palette Sync

## Context
- Link to issue(s): _Phase 4 UI polish – dynamic Bud palettes_
- Related docs: `plan/ui-schema-alignment.md`, `sample_nextjs_UI/app/page.tsx`, `sample_nextjs_UI/components/*`

The Next.js prototype drives its neobrutalist look by binding each Bud/session to `--avatar-*` colors. The sidebar uses the brightest tone, the conversation drawer uses a muted version (`getMutedColor(..., 0.6)`), the chat column uses an even softer shade (~0.4), and global accents (send button, toggles) pull from the same palette. Our Vite port currently:
- hardcodes fallback colors (`var(--sidebar-primary)`, `var(--accent)`)
- only passes a Bud color into the rail/thread/chat components
- leaves other controls (composer button, toggles) on the default accent
- never updates CSS custom properties when a Bud changes.

Therefore selecting Buds doesn’t recolor the UI beyond a couple of widgets, and the send button doesn’t match the Bud accent anymore.

## Objective
When a Bud is selected, propagate its accent color across the entire workbench so the sidebar uses the most vibrant tone, the thread drawer/chat use progressively muted hues, and key CTAs (send button, toggles) reuse the same palette. Colors should fall back gracefully if a Bud lacks `accent_color`.

While addressing palette parity, also tackle the small UI nits picked up during review:
- The Bud rail buttons are noticeably larger than the sample app; align their size/padding/margins with the Next.js sidebar so the rail looks compact.
- Remove the “Bud” title strip above the thread list so that header matches the height of the chat/terminal top bar (uniform 64px row).

## Design / Approach
1. **Palette source of truth**
   - Prefer `bud.accent_color` from the backend.
   - If absent, choose a deterministic fallback (e.g., cycle through `--avatar-{1-5}` by Bud index) so every Bud still has a palette.
2. **Derived shades**
   - Reuse `getMutedColor` to generate two derived shades: `muted` (thread drawer) and `soft` (chat timeline background).
   - Store them in a small `useBudPalette` hook that memoizes `{vibrant, muted, soft}` for the active Bud.
3. **CSS custom properties**
   - Update the root (or a scoped wrapper) with `--bud-accent-vibrant`, `--bud-accent-muted`, `--bud-accent-soft`.
   - Components (Bud rail, thread drawer, chat timeline, send button, view toggles) can then rely on CSS classes (`bg-[var(--bud-accent-…)]`) instead of inline color props.
4. **Component updates**
   - Bud rail: use `--bud-accent-vibrant`.
     - Adjust button dimensions (e.g., 56×56 with 12px padding) per sample to tighten the rail.
   - Thread panel: replace inline `accentColor` prop with `var(--bud-accent-muted)` and adjust count badges.
     - Drop the extra “Bud” label row; align the header height with the chat/terminal top bar for visual consistency.
   - Chat timeline: background/pill shading uses `--bud-accent-soft`.
   - Composer button + toggles: swap `bg-accent` with `bg-[var(--bud-accent-vibrant)]` to keep CTAs in sync.
5. **Persistence**
   - Ensure `bud.accent_color` is seeded/settable so palette survives reloads; eventually expose in Bud settings (future work).

## Impacted contracts
- [ ] WSS protocol
- [ ] SSE events
- [x] Web UI surfaces (styling)
- [ ] DB schema (already supports `accent_color`, but rollout requires seeding)
- [ ] Agent adapter/tool registry

## Test plan
- Manual: seed a few Buds with different `accent_color` values, switch between them, and confirm the sidebar, thread list, chat column, and send button all change in tandem.
- Verify fallback behavior when a Bud lacks `accent_color`.

## Rollout
- Update seeds or admin tooling to populate `accent_color`.
- Document the palette behavior in `web/README.md` so future contributors know to set Bud colors.

## Out of scope
- Advanced theme editing UI.
- Persisting per-thread override colors.
- Linking palettes to Bud tags/capabilities.
