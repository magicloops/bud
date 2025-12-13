# workbench

Main application components - the core workspace UI.

## Purpose

Provides the main layout components for the Bud workbench: navigation rail, thread panel, chat timeline, command composer, and terminal/run views.

## Files

### `bud-rail.tsx`

Left sidebar navigation showing connected buds.

**Types**:
- `BudCapabilities` - Device capabilities (sessions, tmux, terminal)
- `BudProfile` - Bud data (id, label, color, status, lastRun)

**Features**:
- Numbered bud buttons with accent colors
- Online/offline status indicators (green/orange dots)
- Real-time status from `BudStatusContext`
- Theme toggle button (light/dark/system)
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

**Features**:
- Sorted by last activity (most recent first)
- "New" button for creating threads
- Settings button (opens sessions modal)
- Delete button with confirmation dialog
- Terminal session indicators (state dot + icon)
- Message count badges
- Relative timestamps ("just now", "5m ago")

**Session State Colors**:
| State | Color |
|-------|-------|
| `active` | Green |
| `ready`, `idle` | Blue |
| `creating`, `pending` | Yellow (pulsing) |
| `closed` | Gray |

### `chat-timeline.tsx`

Message list with auto-scroll and collapsible messages.

**Type**: `ChatMessage` - Message data (id, role, displayRole, content, metadata)

**Features**:
- Auto-scroll to bottom when new messages arrive
- "Stick to bottom" behavior with manual scroll override
- Collapsible long messages (>500px) with "Show more/less"
- JSON payload viewer for tool messages
- Role-based avatar colors and styling
- Tool content renderers for specialized display

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
- `reasoningEffort` / `onReasoningChange` - Reasoning level selector
- `durablePreferred` / `onDurablePreferredChange` - tmux toggle
- `durableSupported`, `sessionsSupported` - Capability flags

**Features**:
- Multi-line textarea
- Enter to submit (Shift+Enter for newline)
- Reasoning effort dropdown (Fast/Think/Deep/Max)
- "Keep running" tmux checkbox
- Submit button with loading state

### `workspace-top-bar.tsx`

Header bar with bud label and view toggle.

**View Modes**:
- `terminal` - Terminal emulator view
- `web` - Web view (placeholder)

**Components**:
- Thread panel toggle (hamburger menu)
- Bud label display
- Status indicator (Idle/Dispatching/Streaming)
- View mode toggle buttons

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
