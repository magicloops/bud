# Design: Responsive Web Layout (mobile-usable workbench)

> Scoping document for making the web app usable on phones and tablets.
> Today the workbench is a fixed-width, desktop-only four-column flex row
> with zero responsive accommodation — no breakpoints, no `dvh`, no
> `visualViewport` handling, no touch paths.

**Related Docs**:
- [terminal-grid-sync-and-predictive-echo.md](./terminal-grid-sync-and-predictive-echo.md) —
  grid geometry ownership (§4) that a mobile mode must amend
- [web-app-overview-and-ios-feature-parity.md](./web-app-overview-and-ios-feature-parity.md)
- `plan/refactor-web/` — the shell/module boundaries a redesign must respect

---

## 1. Executive Summary

Measured on the real app (headless Chromium against the dev stack,
2026-08-20):

- **390×844 (phone)**: the bud rail + thread list consume the entire
  viewport; the chat timeline renders as a one-character-wide sliver; the
  terminal and composer are unreachable. No horizontal page overflow — the
  columns flex-shrink into mutual illegibility instead.
- **768×1024 (tablet)**: chat is usable, but the terminal pane is a ~30px
  strip of clipped glyphs; rail + thread list still eat ~46% of width.
- Root cause is arithmetic: fixed columns total **752px before the
  terminal gets a pixel** (rail `w-20` 80px + thread panel `w-72` 288px +
  chat `w-96` 384px, plus 16px of `border-r-4`s). The thread panel's
  `min-w-60` is the one hard floor.

### Recommendation

A **breakpoint-driven single-pane mobile shell** built on the existing
`ViewMode` switcher (extended with `'chat'`), with rails/thread-list
becoming overlay drawers, a viewport foundation pass (`dvh`,
`visualViewport`, safe-area), and an explicit **terminal geometry
decision: below the breakpoint the client becomes a geometry observer** —
it never resizes the shared PTY. Desktop layout is untouched in v1 (no
drag-resize panes; that is a separate, later enhancement).

## 2. Current State (inventory)

Full audit with file:line references lives in this doc's source review;
the load-bearing facts:

| Fact | Where | Consequence |
|---|---|---|
| Four-column `h-screen` flex row, all widths hardcoded | `$budId.tsx:204`, `bud-rail.tsx:42` (`w-20`), `thread-panel.tsx:151` (`w-72 min-w-60`), `$threadId.tsx:870` (`w-96`) | 752px of chrome before the `flex-1` workbench |
| No breakpoints anywhere in the workbench | 3 trivial `sm:/md:/lg:` uses in settings/index only | nothing adapts |
| No pane-resize infrastructure at all | zero hits for resizable/splitter | we introduce flexibility, not adapt it |
| `ViewMode = 'terminal' | 'web' | 'file'` switcher exists in the top bar | `workspace-top-bar.tsx:6`, state at `$threadId.tsx:125` | the natural mobile paradigm seed |
| terminal↔web toggle hides via `invisible`, keeps both mounted | `thread-terminal-pane.tsx:267` | mobile switcher must hide, not unmount (iframe/terminal state) |
| `h-screen` = `100vh`, zero `dvh/svh`, zero `visualViewport`, zero safe-area | grep-clean | composer below the fold under iOS Safari chrome; keyboard occludes input |
| Three nested `overflow-y-auto` scrollers + non-scrolling body | chat timeline, thread list, terminal grid | blocks iOS toolbar auto-collapse |
| Composer: fixed `h-32` textarea, absolutely-pinned control cluster ≈316px wide, Enter submits | `command-composer.tsx:70,73,46` | overlaps textarea on phones; multiline impossible on soft keyboards |
| Terminal geometry: measured cols/rows sent to the PTY, floor `max(2,…)`, converge-once, last-resize-wins | `thread-terminal-grid-pane.tsx:137-206` | **a phone attaching reshapes the PTY to ~40 cols for every viewer** |
| Markdown content is already narrow-safe | `.bud-markdown` rules in `index.css` | timeline content mostly survives; the frame doesn't |
| Neo-brutalist hover-lift idiom partially hover-guarded | `@media (hover:hover)` ×3 | touch targets/interactions otherwise unconsidered |

## 3. Design

### 3.1 Breakpoint model

Two breakpoints, Tailwind-native:

- **`< md` (phone, <768px)**: single-pane shell. One region visible at a
  time: `chat | terminal | web | file`. Bud rail → bottom-sheet/drawer
  entry; thread list → full-screen overlay drawer (it is navigation, not
  a peer pane). Top bar compresses (bud name + view switcher + menu).
- **`md–lg` (tablet, 768–1024px)**: two-pane: chat + one workbench pane,
  thread list as drawer, rail intact.
- **`≥ lg`**: today's layout, unchanged.

### 3.2 Mobile shell mechanics

- Extend `ViewMode` with `'chat'`; below `md` the top-bar switcher gains
  the chat tab and `WorkspaceShell` renders exactly one region. All
  regions stay mounted and hide via the existing `invisible` pattern —
  the terminal/web state-preservation trick becomes the rule.
- Thread panel: reuse `threadPanelOpen` but render as an `absolute
  inset-0 z-*` drawer below `md` instead of an in-flow column. Selecting
  a thread closes it.
- Composer: appears with the `chat` view (and optionally as a slide-up on
  other views). Control cluster moves from absolute-pinned to a flex row
  under the textarea below `md`; textarea auto-grows (max ~40dvh); **soft
  keyboards get a send button, not Enter-submit** (`Enter` inserts a
  newline when `pointer: coarse`).
- Touch affordances: minimum 44px targets on the switcher/drawer
  controls; hover-lift effects already gated behind `(hover: hover)`.

### 3.3 Viewport foundation (highest impact, layout-independent)

1. `h-screen` → `h-dvh` at the app root (`$budId.tsx:204`).
2. `visualViewport` listener → CSS var (`--vvh`) so the composer and
   active pane track the soft keyboard; scroll-into-view for the focused
   textarea.
3. `env(safe-area-inset-*)` padding on the rail/drawer and composer;
   `viewport-fit=cover` in the meta tag.
4. Scroll containment audit: exactly one scroller per visible mobile
   view.

### 3.4 Terminal on mobile: observer geometry (the contract decision)

The grid design doc's "last resize wins + converge-once" breaks down when
a 390px viewer joins: it silently reshapes the shared PTY to ~40 cols for
every other viewer, and the desktop's re-assertion has already latched
off. Options considered:

- **A (chosen): observer mode below `md`** — the pane never calls
  `onResize` and never asserts geometry; it renders whatever size frames
  arrive at, inside an `overflow-auto` container (horizontal pan; pinch
  zoom later). Typing, predictions, and taps still work; the PTY keeps
  the desktop's (or spawn-default) geometry. One flag in the grid pane;
  amend grid design doc §4 with "small viewports are geometry
  observers".
- B: min-cols clamp (e.g. 80) + horizontal pan — still resizes the PTY
  when the phone is the *only* viewer, but re-introduces fights when it
  is not; more moving parts for little gain over A.
- C: per-viewer virtual geometry (server-side reflow per client) — the
  correct endgame for first-class multi-viewer, and explicitly out of
  scope (design non-goal since the grid plan).
- Terminal keyboard entry on touch: tapping the pane focuses the hidden
  IME textarea (needs verification that iOS honors the programmatic
  focus from a tap handler — flagged as a scoping unknown); add
  `touchstart` equivalents for the tap-to-focus path. Touch text
  selection and touch-driven mouse reporting are **out of scope** for v1.

### 3.5 What stays untouched

Desktop layout, the wire contracts, the chat timeline internals
(`.bud-markdown` is already narrow-safe), and the file-viewer/web-view
internals beyond their containers (their control rows already
`flex-wrap`; they inherit the single-pane width).

## 4. Phases

> **Status (2026-08-20)**: phases 1-4 implemented on this branch and
> browser-validated at 390/768/1400 (16 interactive scenarios: single-pane
> shell, drawer open/close, observer-mode pannable grid, composer gating,
> tablet two-pane, desktop unchanged). Remaining for real devices: iOS
> Safari/Android Chrome pass (soft keyboard, toolbar collapse, programmatic
> IME focus from tap).

1. **Viewport foundation** — `dvh`, `visualViewport` var, safe-area,
   scroll audit. Ships alone; improves desktop-in-small-window too.
2. **Mobile shell** — breakpoint, `ViewMode + 'chat'`, drawers, top-bar
   compression, composer responsiveness + Enter semantics.
3. **Terminal observer mode** — no-resize flag, pan container,
   tap-to-IME, grid design doc amendment.
4. **Tablet + polish** — two-pane `md–lg` composition, touch-target
   sweep, landscape safe-areas, real-device validation matrix (iOS
   Safari, Android Chrome; keyboard open/close; toolbar collapse).

Validation: extend the browser harness with mobile-viewport scenarios
(390/768 shells render the right regions, no horizontal overflow, drawer
navigation, composer visible with keyboard-sized `visualViewport`
emulation) — same headless-Chromium pattern as the grid validation.

## 5. Non-Goals

- Native iOS app parity (separate track; the mobile *web* just has to be
  usable).
- Desktop drag-resizable panes (wants doing, separate design).
- Touch text selection / touch mouse-reporting in the terminal.
- Per-viewer virtual terminal geometry (option C above).
- Offline/PWA packaging.

## 6. Decision Record (2026-08-20)

1. **Thread list is a drawer**, not a route. Selecting a thread closes
   it; the browser back button keeps its ordinary navigation meaning.
2. **Tablet two-pane shows chat + the last-used workbench view**
   (persisted `ViewMode`, defaulting to terminal) — preserves the user's
   working context across breakpoint changes instead of forcing a
   default pair.
3. **Predictive echo stays enabled on mobile.** Typing latency matters
   most on mobile networks, and the ghost tail renders adjacent to the
   authoritative cursor regardless of PTY width. Observer mode adds
   keep-cursor-in-view: every local keystroke auto-pans the grid
   container so the cursor (and ghost) stay visible while typing.
   Tap-to-focus drives the hidden IME textarea — typing on mobile is a
   first-class requirement, not an afterthought.

## 7. Remaining Open Questions

- Does the `md` breakpoint switch on width alone, or width + `pointer:
  coarse` (a narrow desktop window arguably wants the mobile shell too —
  width-alone is simpler and probably right)?
