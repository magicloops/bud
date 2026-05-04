# workbench

Main application components - the core workspace UI.

## Purpose

Provides the main layout components for the Bud workbench: navigation rail, thread panel, workspace shell, chat timeline, command composer, and terminal/run views.

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

**Features**:
- Multi-line textarea
- Enter to submit (Shift+Enter for newline)
- The textarea submits with a named form field so route handlers can read the live form payload during submit instead of relying only on possibly stale controlled state
- Model selector dropdown (grouped by provider)
- Reasoning effort dropdown derived from the selected model's `/api/models` metadata, including provider-specific values such as `xhigh` and `max`
- Hides the reasoning selector when a model only exposes `none`
- Submit button with loading state
- Consumes shared `ModelInfo[]` from `@/lib/models` rather than owning a route-local model type

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
- handles too-large, unsupported-binary, not-found, denied, expired, offline, content-changed, and generic error states
- provides close, reload, copy-content controls, and pointer/hover/copy feedback on the displayed click-to-copy path text
- places the file identity/action header at the bottom of the pane for the current UI experiment
- in the existing-thread route, renders as an overlay above the still-mounted terminal pane so xterm is preserved while files are open
- stays presentation-only: session creation and file fetch flow live in `web/src/features/threads/use-file-viewer.ts`

### `thread-terminal-pane.tsx`

Terminal presentation component for the existing-thread workspace.

**Props**:
- terminal UI/runtime state from `useTerminalSession(...)`
- agent turn status/error state from the route
- callbacks for focus, agent cancel, and terminal interrupt actions

**Purpose**:
- renders the terminal pane wrapper, web-view placeholder, disconnect overlays, truncated-history badge, terminal status bar, and terminal options menu
- remains mounted underneath the file-viewer overlay in the existing-thread route so the xterm host DOM is not removed during file previews
- keeps terminal menu/open state and terminal-specific JSX out of `/$budId/$threadId`
- stays presentation-only: terminal reconnect policy, xterm lifecycle, and transport remain in `web/src/features/threads/use-terminal-session.ts`

### `workspace-top-bar.tsx`

Header bar with workspace title and view toggle.

**View Modes**:
- `terminal` - Terminal emulator view
- `web` - Web view (placeholder)
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
