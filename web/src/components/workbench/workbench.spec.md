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
- "New" button for creating threads
- Terminal-sessions action in the header
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

Message list with auto-scroll and collapsible messages.

**Type**: `ChatMessage` - Thread message data keyed by stable `client_id` identity

**Props**:
- `messages` - Array of ChatMessage
- `accentColor` - CSS color for user message accents
- optional upward-pagination props for older transcript loading and scroll-anchor preservation

**Features**:
- Consumes chronologically ordered thread messages directly from `useThreadMessages(...)` instead of re-sorting the full list locally on every render
- Auto-scroll to bottom when new messages arrive or when the last visible message grows during assistant streaming
- "Stick to bottom" behavior with manual scroll override
- Top-of-timeline "Load older messages" control when older history exists
- Supports parent-owned scroll-container refs so route logic can preserve the viewport anchor while prepending older pages
- Collapsible long messages (>500px) with "Show more/less"
- Copy message button (appears on hover, bottom-right)
- Tool payload viewer now lazy-loads `@microlink/react-json-view` only when a payload is expanded, with a plain JSON fallback while the viewer chunk loads
- Per-message expand/copy/payload state now lives inside memoized message rows, so toggling one message does not force the full timeline to churn through list-wide UI state maps
- Overflow detection now measures each message row independently via its own DOM observer/update path instead of rescanning every rendered message after each transcript change
- Role-based avatar colors and styling
- Tool content renderers for specialized display
- Assistant draft rows render as plain text with a live cursor until the canonical persisted assistant row replaces them
- Pending `ask_user_questions` tool rows render an inline response form and submit through a parent-owned callback
- The parent thread route now passes the hook-owned message objects directly, preserving `client_id` identity without an extra route-local remap step
- Assistant messages can expose explicit file-open actions for conservative local path references parsed from Markdown links and inline code; actions call a parent callback and never create file sessions during render

**Note**: Renders only the scrollable message area. Parent component provides the container wrapper.

### `thinking-indicator.tsx`

Animated "thinking" indicator shown when agent is working.

**Props**:
- `isVisible` - Controls visibility with animated enter/exit

**Features**:
- Smooth CSS transitions for enter (slide up, fade in) and exit (slide down, fade out)
- Cycles through 12 playful words every 2 seconds: "Thinking", "Pondering", "Combobulating", etc.
- Random starting word on each appearance
- Delayed unmount allows exit animation to complete
- Spinner icon with `animate-spin`
- Text with `animate-pulse`

**Usage**: Rendered as sibling to ChatTimeline, outside the scroll container, to avoid re-render coupling and scroll interference.

**Message Styling by Role**:
| Role | Avatar | Background |
|------|--------|------------|
| User | "U" | accent color |
| Assistant | "B" | muted |
| Tool | tool icon | accent soft |

### `command-composer.tsx`

Message input form with options.

**Props**:
- `messageText` / `onMessageChange` - Controlled input
- `status` - UI state (idle, dispatching, streaming)
- `onSubmit` - Form submission handler
- `models` / `selectedModel` / `onModelChange` - Model selector
- `reasoningEffort` / `onReasoningChange` - Reasoning level selector
- optional `disabledReason` - Human-readable reason to disable normal message composition while a structured prompt is pending

**Features**:
- Multi-line textarea
- Enter to submit (Shift+Enter for newline)
- The textarea submits with a named form field so route handlers can read the live form payload during submit instead of relying only on possibly stale controlled state
- Model selector dropdown (grouped by provider)
- Reasoning effort dropdown derived from the selected model's `/api/models` metadata, including provider-specific values such as `xhigh` and `max`
- Hides the reasoning selector when a model only exposes `none`
- Submit button with loading state
- Disables text entry, model/reasoning controls, and submit while `disabledReason` is present, such as during `waiting_for_user`
- Consumes shared `ModelInfo[]` from `@/lib/models` rather than owning a route-local model type

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
- keeps unsupported question kinds non-crashing by allowing the user to skip them

### `workspace-shell.tsx`

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
- callbacks for focus, agent cancel, and terminal interrupt actions

**Purpose**:
- renders the terminal pane wrapper, optional injected web-view pane,
  disconnect overlays, truncated-history badge, terminal status bar, and
  terminal options menu
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
- Thread panel toggle (hamburger menu)
- Title display (`New Thread` for compose mode, otherwise the current thread title or `Untitled thread`)
- Status indicator (Idle/Dispatching/Streaming)
- View mode toggle buttons; the file toggle appears only when an active file is available
- Exports the shared `ViewMode` union used by `workspace-shell.tsx`

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
