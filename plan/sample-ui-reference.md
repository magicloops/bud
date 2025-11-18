# Sample Next.js UI Reference

This document captures the structure of `sample_nextjs_UI/`, which we are porting into the Vite app for Phase 4.

## Layout Overview
- **Sidebar (`components/sidebar.tsx`)** – vertical Bud/session rail with numbered avatars, add button, and theme toggle (cycles `system → light → dark`). Each entry displays `Session.id`, `name`, and `color`.
- **Conversation selector (`components/conversation-selector.tsx`)** – left drawer listing per-Bud conversations with title + relative timestamp, header action for settings, and “New” button.
- **Top bar (`components/top-bar.tsx`)** – shows active session name, menu toggle for the conversation drawer, and view toggle (`terminal` vs `web`).
- **Chat column (`components/chat-column.tsx`)** – list of messages styled per role using `getMutedColor` to derive assistant/system backgrounds.
- **Terminal column (`components/terminal-column.tsx`)** – scrollable stdout view (mock data) that swaps to a placeholder web preview when the UI is in `web` mode.
- **Composer (in `app/page.tsx`)** – textarea plus send button that currently logs to the console.

## Data Shapes
- `Session`: `{ id: number; name: string; color: string }`.
- `Conversation`: `{ id: number; title: string; timestamp: Date }`.
- `Message`: `{ id: number; content: string; timestamp: string; isUser: boolean }`.
- `view`: union `'terminal' | 'web'`.

The sample UI keeps everything client-local; there is no backend fetch, but the schema names map cleanly to Bud concepts:

| Concept            | Sample Shape               | Bud counterpart                                   |
|--------------------|----------------------------|---------------------------------------------------|
| Session/Bud        | `Session`                  | Bud metadata (`bud_id`, label, status)            |
| Conversation       | `Conversation`             | Thread summary (`thread_id`, title, timestamps)   |
| Message            | `Message`                  | Thread message rows (`message_id`, role, content) |
| Terminal log view  | `terminalLines: string[]`  | Run log stream + SSE events                       |

## Interaction Flow
1. User selects a Bud/session on the rail; the chat + terminal panes colorize using that session’s palette.
2. Conversation drawer lists past chats; selecting one updates the chat column state.
3. Top bar toggles between the terminal log and a placeholder web preview.
4. Sending a message currently performs a no-op (placeholder for posting to backend).

## Adaptation Notes
- We should rename `Session` → `BudProfile`, `Conversation` → `ThreadSummary`, and `Message` → `ThreadMessage` to mirror backend schema names.
- Theme variables (`--avatar-*`, `--chat-bg`, `--terminal-*`) must be defined in `index.css` so the ported components render with the neobrutalist palette.
- The composer should eventually include metadata controls (CWD, run labels, etc.) that align with `/api/threads/:id/messages`.
- Web preview pane will need SSE/WS data once Bud exposes browser streaming; for now it remains a placeholder.
- Drawer toggles (`Menu` button) and theme cycling should continue to work in the Vite build by reusing the `ThemeProvider`.
