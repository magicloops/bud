# workbench

Main application components - the core workspace UI.

## Purpose

Provides the main layout components for the Bud workbench: navigation rail,
thread panel, workspace shell, chat timeline, command composer, terminal views,
file viewer, and proxied web-view pane.

## Files

### `bud-rail.tsx`

Left sidebar navigation showing connected buds.

**Types**:
- `BudCapabilities` - Device capabilities (sessions, terminal)
- `BudProfile` - Bud data (id, label, color, status)

**Features**:
- Numbered bud buttons with accent colors
- Online/offline status indicators (green/orange dots)
- Real-time status from `BudStatusContext`
- Theme toggle button (light/dark/system)
- Global account-settings button beneath the theme toggle
- "Add bud" placeholder button

**Styling**:
- Neobrutalist design: thick borders, hard shadows
- Hover lift effect (`-translate-y-0.5`)
- Active state removes shadow

### `thread-panel.tsx`

Thread list sidebar for conversation navigation.

**Type**: `ThreadSummary` - Thread metadata including:
- `thread_id`, `bud_id`, `title`
- `last_activity_at`, `last_message_preview`, `message_count`
- `has_terminal_session`, `session_state`, `session_id`
- stored/effective model selection fields (`model`, `reasoning_effort`, `effective_model`, `effective_reasoning_effort`, `model_selection_source`)

**Features**:
- Sorted by last activity (most recent first)
- "New chat" lives IN the list as the first card-shaped item (dashed border
  + Plus icon; solid accent border when the new-thread route is active) —
  no separate header button
- Header: hamburger (closes the panel via `onToggleOpen`; the workspace top
  bar hides its own hamburger while the panel is open), centered bud name
  (button → Bud settings, General tab) and a gear (→ General tab) via
  `onOpenBudSettings(tab)`. Terminal sessions are a tab inside that modal;
  the former Layers shortcut is gone
- Account settings are intentionally not shown here because this header is Bud-scoped
- Delete button with confirmation dialog
- Delete success/failure now bubble up through `onStatusChange(...)` so the parent Bud layout can show a visible shared mutation-status banner instead of silently logging or only updating local button state
- Terminal session indicators (state dot + icon)
- Message count badges
- Relative timestamps ("just now", "5m ago")
- Titles can update live from `thread.title` stream events because the parent Bud route now patches thread summaries in local state

**Session State Colors**:
| State | Color |
|-------|-------|
| `active` | Green |
| `ready`, `idle` | Blue |
| `creating`, `pending` | Yellow (pulsing) |
| `closed` | Gray |

### `chat-timeline.tsx`

Message list with auto-scroll and full-height message rendering.

**Type**: `ChatMessage` - Thread message data keyed by stable `client_id` identity

**Props**:
- `messages` - Array of ChatMessage
- optional `notices` - Non-transcript timeline markers such as completed or failed context compaction events
- optional `liveTurnId` / `turnOutcomes` - Agent-work projection inputs (active run's turn id; session-local `final`-event outcomes) owned by the thread route
- optional `activityIndicatorVisible` / `activityIndicatorLabel` - Route-owned active-agent footer state rendered after the latest timeline item
- optional upward-pagination props for older transcript loading and scroll-anchor preservation

**Features**:
- Consumes chronologically ordered thread messages directly from `useThreadMessages(...)` instead of re-sorting the full list locally on every render
- Projects messages through `createTimelineProjector()` (features/threads/agent-work-projection): reasoning, non-question tool calls, and intermediate assistant commentary render as one `AgentWorkGroup` row per turn; user/system/final-assistant/question/compaction rows stay top-level
- Work-group and per-item expansion state is ephemeral component state keyed by stable projection ids (turn ULIDs — globally unique, never persisted)
- The bottom-follow `scrollSyncKey` derives from VISIBLE structure only: a collapsed group's hidden detail growth does not trigger auto-scroll; a live group's current step does
- The generic thinking indicator is suppressed while a live work group is on screen (its header already says "Working…"); labeled states (compaction) and the pre-first-work gap keep it
- Auto-scroll to bottom when new messages arrive, when the last visible message grows during assistant streaming, when the active-agent footer appears, and while that footer expands if the user is already stuck to bottom
- "Stick to bottom" behavior with manual scroll override
- Older history loads automatically while scrolling up: a sentinel above the first row is observed (`IntersectionObserver`, root = the scroll container, 600px top margin so the fetch starts before the user hits the top); the observer is re-created after each load so a still-visible sentinel (short page, tall viewport) keeps loading until the pane overflows. Shows "Loading older messages…" while fetching; after a failed fetch auto-loading pauses and a retry control appears; nothing renders once there is no older history
- Supports parent-owned scroll-container refs so route logic can preserve the viewport anchor while prepending older pages
- Copy message button (appears on hover, bottom-right)
- Tool payload viewer now lazy-loads `@microlink/react-json-view` only when a payload is expanded, with a plain JSON fallback while the viewer chunk loads
- Per-message copy/payload state now lives inside memoized message rows, so toggling one message does not force the full timeline to churn through list-wide UI state maps
- Messages render at their natural height without the former 500px clamp or expand/collapse row controls
- Role-based avatar colors and styling
- Reasoning rows render visibly by default with muted Markdown treatment and no assistant file-open actions
- Tool content renderers for specialized display
- Assistant draft rows render through the shared Streamdown-backed role renderer in streaming mode without Streamdown text-reveal animation or caret chrome until the canonical persisted assistant row replaces them
- Pending `ask_user_questions` tool rows render an inline response form and submit through a parent-owned callback
- Context compaction notices render as subtle timeline markers without creating or assuming persisted transcript rows
- Active-agent thinking/compaction feedback renders as a non-transcript footer inside the scrollable timeline so the newest message remains fully visible above it
- The parent thread route now passes the hook-owned message objects directly, preserving `client_id` identity without an extra route-local remap step
- Assistant messages can expose explicit file-open actions for conservative local path references parsed from Markdown links and inline code; actions call a parent callback and never create file sessions during render

**Note**: Renders the scrollable message area plus non-transcript timeline footers. Parent component provides the container wrapper.

### `chat-pane-resize.tsx`

Drag-to-resize for the chat-pane ↔ terminal/web/file divider (md+ only).

**Exports**:
- `useChatPaneWidth()` — `{ width: string | null, setFraction }`; the
  dragged split is stored as a FRACTION of the pane row (localStorage
  `bud:chat-pane-fraction`, shared by the `$threadId` and `new` routes),
  so opening the thread panel or resizing the window shrinks both sides
  proportionally. `width` is the CSS value `clamp(280px, N%, 70%)`; null
  means the responsive defaults (`20rem` md / `24rem` lg).
- `ChatPaneResizeHandle` — absolutely-positioned strip over the pane's
  right border, rendered inside the (relative) chat pane. Pointer capture
  keeps the drag alive over the terminal/iframe; double-click resets to
  the defaults; arrow keys nudge ±24px when focused (`role="separator"`).
- `useComposerColumnAlignment(paneRef, elementRef)` — ResizeObserver-backed
  alignment of a full-width element (composer, top bar) with the transcript
  column: `paddingLeft` (820px centering + 8/15/30px gutter tiers + 3px
  rail) and `controlsRight` (column text edge when chat is the only view;
  classic 12px when a viewer is open).

The pane consumes the width via a CSS variable
(`md:w-[var(--chat-pane-width,20rem)]`), so mobile's `w-full` never sees
custom widths.

### `agent-work-group.tsx`

One turn's agent work as a disclosure row (design/web-agent-work-collapse.md,
Option B — progressive collapse).

**Props**: `row: TimelineWorkRow`, `expanded`, `onToggle(rowId)`,
`expandedItems: ReadonlySet<client_id>`, `onToggleItem(clientId)`.

**Behavior**:
- Live: header `Working… · <elapsed> · <current step>` (1s ticker mounted
  only while live; step label from the pending tool / streaming reasoning);
  only the current step renders beneath the header — finished steps are
  already folded in. Expanding while live shows the full inline history.
- Done: header `Worked for <duration>` (`lib/agent-work-duration`) or
  `Worked`, plus a tool/reasoning count summary; `failed`/`canceled`/
  `no_final` render as badges on the collapsed row.
- Expanded body: chronological sections — intermediate assistant commentary
  as separators, activity items as compact one-line headers (kind label,
  first-line/arg summary, per-item duration chip) with per-item detail
  expansion mounting the existing role/tool renderers lazily. Collapsed
  content is unmounted (deliberate find-in-page stance).
- `aria-expanded`/`aria-controls` on both disclosure levels;
  `motion-reduce:transition-none` on chevrons.

### `thinking-indicator.tsx`

Thinking indicator shown when agent is working.

**Props**:
- `isVisible` - Controls visibility and unmounts immediately when hidden
- optional `label` - Overrides the rotating word while a specific activity, such as context compaction, is active

**Features**:
- Cycles through 12 playful words every 2 seconds: "Thinking", "Pondering", "Combobulating", etc.
- Shows caller-provided activity text such as `Compacting context...` without cycling the generic word list
- Random starting word on each appearance
- Enter-only height animation expands from 0 to the compact open state over 200ms
- Instant unmount on hide so assistant draft text never overlaps a fading indicator
- Compact 40px open-state height cap with a small `animate-spin` spinner
- Text with `animate-pulse`

**Usage**: Rendered by `ChatTimeline` as a non-transcript footer row after the latest message so scroll-to-bottom includes the indicator. The existing-thread route hides it while the agent is paused in `waiting_for_user`.
The existing-thread route also suppresses the generic indicator while assistant draft text is actively streaming, then lets it return after a short post-`message_done` delay if the turn continues.

**Message Styling by Role**:
| Role | Avatar | Background |
|------|--------|------------|
| User | "U" | accent color |
| Assistant | "B" | muted |
| Reasoning | "B" | muted |
| Tool | tool icon | accent soft |

### `command-composer.tsx`

Build tag (`data-testid="web-build-tag"`, first item in the bottom controls row, left of the model selector): shows `shortBuildVersion(buildDescribe())` (e.g. `v0.1.13`); clicking toggles the full git-describe string (`v0.1.13-2-g2a57857`), which is always in the tooltip. The same describe is logged to the console at boot (`main.tsx`); see `lib/build-info.ts`.

Message input form with options.

**Props**:
- `messageText` / `onMessageChange` - Controlled input
- `status` - UI state (idle, dispatching, streaming, waiting_for_user, waiting_for_terminal)
- `onSubmit` - Form submission handler
- optional `onCancelAgentTurn` - Existing-thread cancel action that switches the send button into stop mode while the agent is dispatching, streaming, or waiting on the terminal
- `models` / `selectedModel` / `onModelChange` - Model selector
- `reasoningEffort` / `onReasoningChange` - Reasoning level selector
- optional `disabledReason` - Human-readable reason to disable normal message composition while a structured prompt is pending
- optional `contextBudget` - Thread context budget snapshot shown as the send button radial ring and tooltip
- optional `environment` - Bud environment snapshot used to show composer-level offline status without disabling normal message sends
- `error` - Route-owned runtime/submission error text rendered above the textarea with preserved line breaks for stable diagnostic codes

**Features**:
- Multi-line textarea
- Enter to submit (Shift+Enter for newline)
- The textarea submits with a named form field so route handlers can read the live form payload during submit instead of relying only on possibly stale controlled state
- Model selector dropdown (grouped by provider); both selectors render as
  plain text with a custom chevron (`FitSelect`: `appearance-none` select in a
  relative wrapper + lucide `ChevronDown`, width hugging the selected label)
  instead of bordered buttons, so they blend into the controls row
- Bud-local ds4 options are labeled with a compact local-Bud source marker while
  endpoint/request-mode details remain hidden from the selector
- Reasoning effort dropdown derived from the selected model's `/api/models` metadata, including provider-specific values such as `xhigh`, `max`, and ds4's semantic `Fast`/`Thinking` options
- Hides the reasoning selector when a model only exposes `none`
- Circular context-aware submit button with loading state only during message dispatch
- In existing-thread mode, the circular context-aware submit button becomes a stop control while the agent is dispatching or streaming, calls the route-owned cancel action, and remains enabled even when the textarea is disabled during dispatch
- The submit button renders context-budget usage as a radial border from 0-100%
  starting at the top and moving clockwise, and exposes the context tooltip on
  hover/focus
- Keeps text entry, model/reasoning controls, and submit available during `waiting_for_user` and `waiting_for_terminal` (a follow-up message supersedes a pending terminal wait); `disabledReason` remains available for other caller-owned disable cases
- Shows a compact Bud-offline notice when `/agent/state.environment` or the send response reports `bud_offline`; the composer remains usable because the agent can still respond without Bud-specific tools
- Shows sanitized runtime agent failures from `/agent/state.last_error` or failed `final` events in the existing composer error slot, not in the transcript
- Consumes shared `ModelInfo[]` from `@/lib/models` rather than owning a route-local model type

### `context-send-button.tsx`

Circular composer submit control for the browser-visible context budget snapshot.

**Props**:
- optional `contextBudget` - `ApiContextBudget` from `/agent/state`
- `disabled` - caller-owned form disable state
- `dispatching` - whether to show the loading spinner instead of the send icon
- optional `stopMode` / `onStop` - switch the control to a non-submit stop button for active agent turns

**Features**:
- submits the composer form through a native circular `button type="submit"`
- switches to `button type="button"` with a square stop icon and "Stop response" accessible label in stop mode
- keeps a compact 40px circular footprint with centered send/loading icons
- shows visual percentage against the effective compaction budget, not raw
  model-window usage, as a top-origin clockwise radial border around the button
- uses the context ring as the only button border, with the black progress
  segment growing over a Bud accent-muted track
- clamps the radial border to 100% while preserving raw percentage details in
  the tooltip
- exposes rounded token counts, authoritative basis, provenance, confidence,
  hard model window, Bud usable context window, output reserve, usable input
  window, and stale state in a tooltip
- shows the backend message estimate and normal agent tool-schema overhead in
  the tooltip when tool schemas contribute to the current budget
- does not render provider usage diagnostics in the product tooltip
- handles unknown budget snapshots without crashing the composer
- keeps the tooltip trigger on a wrapper so context details can still be shown
  when the native submit button is disabled

### `context-budget-meter-state.ts`

Pure presentation helpers for the context budget send-button tooltip and ring.

**Responsibilities**:
- map usage percentage to normal/elevated/near/over/unknown tones
- format visual percentages and rounded token counts such as `312k`
- build tooltip copy from available and unknown context budget snapshots,
  including `Context unknown` for invalid or missing context policy
- include the message/tool-schema token split in available-budget details
- keep provider usage diagnostics out of product-facing copy
- clamp radial ring progress from 0-100%

### `context-budget-meter-state.test.ts`

Node-runner coverage for rounded token formatting, radial ring clamping, tone thresholds, compaction-budget labels, and unknown snapshot presentation.

### `question-request-card.tsx`

Inline structured prompt form for pending `ask_user_questions` tool calls.

**Props**:
- `request` - normalized `ApiAskUserQuestionsRequest`
- `onSubmit` - callback receiving the request plus an `ask_user_questions_response_v1` payload
- optional `disabled` / `error`

**Features**:
- renders boolean, single-choice, multi-choice, text, and number question kinds
- supports per-question skip plus skip-all
- generates a browser UUIDv7 `client_response_id`
- submits only normalized answer payloads; labels remain display-only
- delegates default answer state, skip behavior, and response-payload construction to `question-request-response.ts`
- keeps unsupported question kinds non-crashing by allowing the user to skip them

### `question-request-response.ts`

Pure response-state and payload helpers for the structured prompt form.

**Responsibilities**:
- build initial per-question answer state for boolean, single-choice, multi-choice, text, and number questions
- build skip-all and per-question skipped answer payloads
- convert local form state into the `ask_user_questions_response_v1` route payload with a browser `client_response_id`
- keep labels display-only by submitting ids and normalized answer values

### `question-request-response.test.ts`

Node-runner coverage for structured prompt response helpers.

**Coverage**:
- initial answer state for every v1 question kind
- answer payload construction for boolean, single-choice, multi-choice, text, and number questions
- per-question skip and skip-all payload construction

### `workspace-shell.tsx`

Responsive shell (design/responsive-web-layout.md): below `md` it is a
single-pane shell — `ViewMode` gains `'chat'`, the top bar shows the chat
tab, the composer renders only with the chat view, and the debug pill is
hidden. Panes stay MOUNTED and hide via CSS (terminal/iframe state
preservation). Tablet (`md..lg`) shows chat (w-80) + the last-used
workbench view; the thread panel is an overlay drawer below `lg` and the
bud rail lives inside the drawer below `md`. View toggle buttons are
icon-only below `md` with aria-labels.

Shared frame for the two workbench routes.

**Props**:
- `title`
- `view` / `onViewChange`
- optional `fileViewLabel`
- `onToggleThreads`
- `status`
- `leftPane`
- `rightPane`
- `composer`
- optional `debugPanel`

**Purpose**:
- Keeps `/$budId/new` and `/$budId/$threadId` on the same top-bar / split-pane / composer structure
- Reduces divergence between the new-thread workspace and existing-thread workspace while larger runtime decomposition is still pending

### `file-viewer-pane.tsx`

Presentation component for the thread file viewer right-pane mode.

**Purpose**:
- renders create/load/ready/error states from `useFileViewer(...)`
- presents Markdown, source/code, and plain UTF-8 text files
- passes file-open actions into ready Markdown previews so absolute POSIX links can open through the file viewer with `source.kind = "markdown_preview"`
- keeps unsupported local/relative Markdown-preview links inert instead of navigating to same-origin web-app 404s
- handles too-large, unsupported-binary, not-found, denied, expired, offline, content-changed, and generic error states
- renders a compact top header on the app background surface with filename-as-copy-path plus quiet full-opacity copy-content, reload, and close icon controls
- in the existing-thread route, renders as an overlay above the still-mounted terminal pane so xterm is preserved while files are open
- stays presentation-only: session creation and file fetch flow live in `web/src/features/threads/use-file-viewer.ts`

### `web-view-pane.tsx`

Presentation component for the thread Web view right-pane mode.

**Purpose**:
- renders create/load/ready/error states from `useWebView(...)`
- lets users enter a loopback port, optional host/path, and display title for
  an owned proxied site, defaulting the manual host picker to `localhost`
- syncs host/port/path controls from the active proxied site when the active
  site changes, while keeping the Name field as an optional override for the
  next Open action
- keeps the Site/Host/Port/Path/Name/Open controls collapsed by default behind
  a top-header settings icon, preserving the iframe and form state when toggled
- exposes an existing-site picker for the current Bud so multiple threads can
  attach to the same durable proxied site
- renders the private `bud.show`/`proxy.localhost` iframe bootstrap flow and
  shows standalone-open fallback actions when embedded access fails
- includes compact reload, detach, and standalone-open icon controls plus a
  visible in-pane "Open in new tab" action for validating the top-level
  bootstrap path when embedded local HTTP cookies are blocked
- uses the hook-owned reload action as an authoritative Web view/site/transport
  refresh, not just a viewer-grant remint, so stale unavailable proxy transport
  can recover after Bud reconnect
- shows product-visible banners for disabled/expired sites, Bud offline or
  unavailable HTTP proxy transport, and WebSocket/HMR unsupported/degraded
  transport while still allowing static HTTP previews when available
- stays presentation-only: proxied-site creation, thread attachment,
  viewer-grant minting, and iframe URL refresh live in
  `web/src/features/threads/use-web-view.ts`

### `thread-terminal-pane.tsx`

Terminal presentation component for the existing-thread workspace.

**Props**:
- terminal UI/runtime state from `useTerminalSession(...)`
- agent turn status/error state from the route
- `showInterrupt` — fact-gated by the route via `showTerminalInterrupt`
  (`features/threads/terminal-interrupt.ts`)
- callbacks for focus, agent cancel, and terminal interrupt actions

**Purpose**:
- renders the terminal pane wrapper, optional injected web-view pane,
  disconnect overlays, truncated-history badge, terminal status bar (incl.
  the contextual Interrupt button next to the command chip, shown only while
  Ctrl+C is meaningful), and terminal options menu (incl. the always-there
  Interrupt escape hatch and the renderer toggle: bytes/xterm ↔ grid beta,
  persisted to localStorage + reload)
- when `terminalRenderer` is `grid`, renders the injected `gridPane` in place
  of the xterm container

### `thread-terminal-grid-pane.tsx`

`assertGeometry` prop (default true): when false the pane is a geometry
OBSERVER (small viewports) — it never sends resizes or re-asserts, renders
arrival-size frames in a pannable `overflow-auto` container, and keeps the
cursor in view on local activity (grid design doc 2026-08-20 amendment).
Grid-sync renderer (plan/terminal-grid-sync phase 2): draws
`TerminalGridState` as DOM rows of styled run spans — no VT parsing, native
selection/copy. Owns geometry: measures its cell box, calls `onResize`, and
re-asserts the measured size against mismatched frames **until the stream
converges on it once** (the mount-time resize races session creation and
404s; converge-once prevents two differently-sized viewers fighting over the
PTY — last resize wins, and a reconnect re-arms the assertion to cover daemon
respawns at the stale spawn hint). Keyboard/paste capture via
`lib/terminal-input` translation into `onInput`, bottom-pinned scrolling with
scrollback above the live grid, and a `ch`-positioned cursor overlay.
Run spans render as cell-height inline-blocks so app background colors
paint the full cell rect (inline font-boxes left dark gaps between lines
under vim themes); rows are memoized on run-array identity so delta frames
re-render only dirty rows (the reducer preserves row identity for
content-equal rewrites, so full-frame streams leave unchanged DOM — and any
native selection in it — untouched; scrollback rows key on
`scrollbackStart + index` absolute indexes so cap trims never remount
survivors). Click-to-focus is selection-aware: a click that completes a
drag-selection inside the pane focuses the container (which never owns a
text selection) instead of the IME textarea, so the highlight survives and
the platform copy shortcut works; collapsed-selection clicks focus the IME
as before.
Mouse support (§6.8.4): press/release/drag/motion/wheel encoded via
`terminal-mouse.ts` only while the app enabled reporting (Shift bypasses to
native selection; contextmenu suppressed while reporting); wheel falls back
to alternate-scroll arrows in the alt screen and native scrollback scrolling
on the primary screen; cursor-key bytes are rewritten to SS3 under DECCKM.
The cursor renders per DECSCUSR facts (block/underline/beam, blink) with a
blinking-block default for older daemons — but only while the pane owns
keyboard focus; unfocused it draws a hollow non-blinking cell outline
(xterm parity), so a filled/blinking cursor unambiguously means keystrokes
go to the terminal rather than the message composer. Focus is tracked via
focus/blur on the container (child↔child moves filtered by `relatedTarget`). Keyboard focus lives on a hidden
cursor-positioned textarea: IME composition (compositionend), dead keys, and
non-keyboard insertions (emoji picker → input events) commit as ordinary
text; mid-composition keydowns (keyCode 229) are never translated; the
textarea is pointer-transparent and focused programmatically.
Renders the predictive-echo ghost tail (dotted underline, dimmed) after the
authoritative cursor, with the cursor block sitting after the ghost.
Known v1 limitation: wide-glyph cursor positioning assumes CJK glyphs render
at exactly 2ch. Validated by the automated browser E2E
(plan/terminal-grid-sync/browser-validation.md).
- renders typed `terminal.event` status chips in the header: the mode chip
  (`shell`/`tui`/`repl`), a command lifecycle chip (pulsing "running" dot from
  `command_started`, then green `exit 0` / red `exit N` from
  `command_finished`, persisting until the next command), and an "input
  queued" chip while typed input is buffered during a disconnect — no
  heuristic activity inference
- the truncated-history badge only appears on the byte-tail history fallback
  path; the emulator-scrollback snapshot path never sets it
- renders the terminal status/menu bar as a compact 2rem top header above the xterm host for visual testing
- bottom-anchors the injected xterm element inside its measured host so whole-row fit remainder pixels collect above the terminal screen instead of below it
- remains mounted underneath file-viewer and web-view overlays in the
  existing-thread route so the xterm host DOM is not removed during previews
- keeps the injected web-view pane mounted while hidden on the Terminal tab so
  the iframe is not recreated with a consumed one-time bootstrap grant
- keeps terminal menu/open state and terminal-specific JSX out of `/$budId/$threadId`
- stays presentation-only: terminal reconnect policy, xterm lifecycle, and transport remain in `web/src/features/threads/use-terminal-session.ts`

### `workspace-top-bar.tsx`

Header bar with workspace title and view toggle.

**View Modes**:
- `terminal` - Terminal emulator view
- `web` - Proxied web view for an owned loopback site
- `file` - Thread file viewer pane for user-clicked transcript paths

**Components**:
- Thread panel toggle (hamburger menu) — hidden while the thread panel is
  open (`threadsOpen` prop; the panel header hosts the hamburger then)
- Title display (`New Thread` for compose mode, otherwise the current thread title or `Untitled thread`)
- Title aligns with the transcript column's text edge (composer geometry via
  `useComposerColumnAlignment` + the exported row-text padding constant); the
  title's natural left edge is *measured* from the DOM (it depends on the
  responsive padding/gap and whether the hamburger is rendered), never
  hardcoded, and the title only shifts right, never left of its natural spot
- View mode toggle buttons: square icon-only (`size="icon-sm"`, label kept
  as aria-label + title tooltip); the file toggle appears only when an
  active file is available
- Exports the shared `ViewMode` and `WorkbenchStatus` unions used by the workbench frame and child controls

## Dependencies

| Import | Purpose |
|--------|---------|
| `@/components/ui/button` | Button component |
| `@/components/theme-provider` | Theme context |
| `@/contexts/bud-status-context` | Real-time bud status |
| `@/components/message-renderers` | Tool/role renderers |
| `@/lib/utils` | `cn()` utility |
| `@/lib/theme-colors` | Color utilities |
| `lucide-react` | Icons |
| `@microlink/react-json-view` | JSON viewer (chat-timeline) |

---

*Referenced by: [../components.spec.md](../components.spec.md)*
