# Bud Product Overview And Marketing Handoff

Audience: design, brand, product marketing, and web teams creating a public marketing site for Bud.

Working positioning line:

> Bud turns any machine into an agent.

## Executive Summary

Bud is a device-agent platform. A user installs a small daemon on a machine, signs in through the browser, claims that machine as their Bud, and then works with it through a chat-based web workspace. The agent can use the machine's real terminal, inspect terminal state, run commands, open private previews of local web apps, and help the user inspect files that are referenced during the work.

The product is not a generic chatbot in a sandbox. Bud connects an AI assistant to the user's own computer, server, dev box, lab machine, or always-on workstation. The core promise is simple: the agent works where the user's real tools, files, environment variables, running processes, local servers, and terminal state already live.

Bud should feel powerful, transparent, and grounded. The user can see the terminal, take over input, interrupt long-running work, switch between parallel work threads, preview local applications, and keep a durable transcript of what happened.

## Target Audience

Bud is technical, but not only for developers.

Primary audience:
- Developers who want an agent working inside their real project environment.
- PMs and designers who want to inspect local prototypes, run scripts, and ask an agent to operate project workflows.
- Sysadmins and operators who want AI help on remote machines without handing over a full desktop.
- Hobbyists and power users who automate personal machines, home servers, media workflows, experiments, and scripts.

The marketing site should assume visitors understand concepts like "terminal", "local app", "server", "script", and "repo", but it should not require them to understand WebSockets, SSE, tmux, Drizzle, protobuf, or provider tool-call internals.

## The Core Product Idea

Most AI tools either chat about work or run code in an isolated environment. Bud gives the agent a persistent, observable handle on a real machine.

In Bud:
- A machine becomes a named, owned device in the user's workspace.
- Each conversation thread gets its own persistent terminal session.
- The agent can run commands and observe the result before deciding what to do next.
- The user can watch and intervene through a browser terminal.
- Local web servers can be opened as private web views.
- Referenced files can be opened in a built-in viewer.
- Long-running conversations can continue with context compaction instead of losing the visible transcript.

The simplest explanation:

1. Install Bud on a machine.
2. Claim it with your signed-in account.
3. Start a thread.
4. Ask the agent to work.
5. Watch the real terminal and results stream back live.

## Product Surface Areas

### 1. Connected Machines

The "Bud" is the machine-side agent runtime. It is currently a Rust daemon that runs on the user's machine and connects back to the Bud service.

Customer-facing description:

Bud gives each machine a secure presence in the web app. Once claimed, a machine appears in the Bud rail with online/offline status, a display name, and an accent color. Users can switch between machines and see which ones are currently reachable.

What happens under the hood:
- The daemon starts a browser-mediated claim flow.
- The user signs in and approves the claim through a URL or QR code.
- The daemon receives a long-lived device secret and reconnects securely.
- The service treats Bud inventory as user-owned; another signed-in user should not be able to browse someone else's devices.

Marketing angle:

Your machines become addressable workspaces for AI. The agent does not need a fake sandbox when the right environment is already on your computer.

### 2. The Workbench

The web client is the main product workspace. It combines machine navigation, threads, chat, terminal, file preview, and local web preview in one screen.

Current workbench surfaces:
- Bud rail: machine switcher, device status, theme/account controls.
- Thread panel: conversation list for the selected machine.
- Workspace shell: split layout with chat on the left and terminal/web/file surface on the right.
- Chat timeline: user, assistant, and tool activity, including streaming assistant text.
- Composer: message input, model selector, reasoning selector, context budget meter, and Bud-offline status.
- Terminal pane: live xterm.js terminal for the current thread.
- Web view pane: private preview of a local loopback app running on the Bud.
- File viewer pane: user-clicked file previews from assistant output or Markdown content.

Marketing angle:

Bud is not just a chat window. It is a cockpit for machine work: conversation, execution, observation, and artifacts stay together.

### 3. Thread-Scoped Workstreams

Threads are the main unit of work. Each thread belongs to one Bud and owns its own terminal session.

Why this matters:
- Users can run separate projects or tasks in parallel without terminal state colliding.
- The agent keeps command history, working directory, process state, and context scoped to that thread.
- Revisiting a thread can restore the relevant terminal history and transcript.

Customer-facing description:

Each thread is a durable workstream. One thread can debug a local web app while another watches a server process or explores a different folder. The terminal state stays with the conversation that created it.

Marketing angle:

Parallel agent work without the usual terminal confusion.

### 4. The Agent

Bud's agent runs through the backend service and uses configured LLM providers. Today the product supports OpenAI and Anthropic provider paths behind a shared model catalog, with opt-in ds4 support for local development and Bud-local machines that advertise a healthy ds4 Responses API.

What the agent can do:
- Read the conversation history.
- Use the selected model and reasoning level for the thread.
- Send commands or interactive input to the Bud terminal.
- Observe the terminal before making terminal-dependent claims.
- Open, list, and close private local web views.
- Ask the user structured, skippable questions when a decision is risky.
- Continue operating when the Bud is offline by answering without Bud-specific terminal/web tools.

Important product behavior:
- Terminal sends are "settled" by default: the system waits for visible output to stabilize before giving the result back to the model.
- The agent gets readiness hints, such as "prompt visible", "confirmation prompt", "password prompt", "pager", or "still processing".
- The agent understands common REPL/TUI contexts, such as Python, Node, psql, and Claude Code, so it does not always treat the terminal as a plain shell.
- Long conversations can be compacted internally while keeping the visible transcript intact.
- When a Bud-local ds4 model is selected, model execution happens on the user's machine, but prompt and transcript context still route through the Bud service before being forwarded to the local daemon. Do not describe this as end-to-end private, offline, or invisible to the hosted service.

Marketing angle:

Bud gives the agent a working sense of place. It can see whether a command finished, whether a program is waiting for input, and when it should ask the user instead of guessing.

### 5. Persistent Terminal

The terminal is Bud's core primitive. It is backed by tmux today, which gives each thread a persistent terminal session that can survive browser refreshes and service reconnects.

Customer-facing behavior:
- Commands run in the user's real shell environment.
- Terminal output streams live to the browser.
- The browser terminal can be used as an escape hatch for human input.
- The user can send Ctrl+C, resize the terminal, or inspect history.
- The agent and the human share the same session, so there is no hidden second terminal.

Why this matters:

The agent works with real state: current directory, environment, running dev servers, interactive programs, and the output of prior commands.

Marketing angle:

Real terminal. Real machine. Real state.

### 6. Local Web Views

Bud can expose a loopback web app running on the user's machine as a private web view in the thread.

Customer-facing behavior:
- The user or agent can open a local port, such as a dev server.
- The workbench attaches that site to the current thread.
- The site can render in an iframe-like pane or be opened in a standalone tab.
- Existing owned sites can be reattached across threads.
- The system reports whether static HTTP preview and WebSocket/HMR support are available.

Security posture:
- Targets are limited to loopback hosts like `localhost`, `127.0.0.1`, or `::1`.
- Viewer access is owner-private and cookie/grant based.
- Public sharing is not the current product claim.

Marketing angle:

The agent can help with work that has a visual result, not just a terminal log. Designers and PMs can inspect the same local prototype the agent is running.

### 7. File Viewer

Bud includes a read-only file viewer for user-clicked file references.

Customer-facing behavior:
- Assistant messages can surface file-open actions for local-looking file paths.
- The user clicks a file reference to create a short-lived file session.
- Bud previews Markdown, source/code, and plain UTF-8 text files.
- Markdown previews can open high-confidence absolute POSIX links through the same safe flow.

Security posture:
- The file viewer is user-initiated.
- Sessions are short-lived, scoped to the owner, and read-only.
- Paths are normalized and revalidated on the daemon side.
- Symlinks, root escapes, unsafe path forms, over-limit reads, and changed-content range reads are rejected.

Marketing angle:

When the agent points to a file, the user can inspect it in context without leaving the workbench.

### 8. Identity, Ownership, And Trust

Bud is built around signed-in, user-owned resources.

Current product trust model:
- Browser users sign in with GitHub or Google through Better Auth.
- Bud device claims are approved by an authenticated human.
- Buds, threads, messages, terminal sessions, file sessions, and web views are scoped to the owner.
- Cross-user resource reads return not found rather than leaking existence.
- SSE streams authorize before attaching or replaying buffered events.

User-facing trust story:

Bud should feel transparent and permissioned. Users explicitly claim machines, see where the agent is working, and can interrupt or take over. The system should not be positioned as a hidden remote-control layer.

### 9. Model Choice And Long Context

Bud exposes a product model catalog and per-thread model preferences. Current catalog behavior includes OpenAI and Anthropic models with model-specific reasoning levels, plus Bud-scoped local ds4 models only when the selected Bud advertises a healthy local ds4 capability.

Customer-facing behavior:
- Users can pick a model for a new or existing thread.
- Reasoning controls are shown only when they make sense for the selected model.
- The composer includes a context budget meter so users can see how full the model-visible conversation is.
- Automatic compaction can preserve long-running work without rewriting the visible transcript.

Marketing angle:

Bud is built for long-running work, not just one-off prompts.

### 10. Mobile And Notifications Foundation

The current codebase includes hosted mobile OAuth routes, native-client OAuth foundations, APNs push endpoint registration, unread-thread attention math, and device-claim callback support for iOS handoff.

Marketing guidance:

Do not lead with a fully shipped mobile app unless product confirms it. It is accurate to say Bud's backend is being built with mobile clients and notifications in mind. The public site can hint at "web today, mobile-ready foundations" only if that matches launch strategy.

## How Bud Works

High-level system flow:

1. A user runs the Bud daemon on a machine.
2. The daemon prints a claim URL or QR code.
3. The user signs in, approves the machine, and the daemon stores its identity.
4. The daemon keeps a live connection to the service.
5. The user opens the web workbench and chooses a Bud.
6. A thread creates or resumes a persistent terminal session on that Bud.
7. The user asks for work in chat.
8. The service runs the agent loop with the selected LLM provider.
9. The agent calls tools such as terminal send, terminal observe, web-view open, or ask-user questions.
10. The web app streams chat, terminal output, tool activity, and artifacts back to the user.

Simple public explanation:

Bud runs a small connector on your machine. The connector keeps a secure terminal session available to your agent. You talk to the agent in the browser, and Bud streams back what happens on the real machine.

## Customer Scenarios

### Developer

"Run the test suite, inspect the failure, patch the likely file, start the dev server, and show me the local app."

Bud can use the terminal, preserve the project environment, open a local web preview, and let the developer inspect files and terminal output as the work happens.

### Product Manager

"Pull up the local prototype, check the onboarding flow, and tell me what changed."

Bud can run a local app, expose it through a private web view, and keep the conversation tied to the actual machine where the prototype is running.

### Designer

"Start the app, open the prototype view, and help me compare behavior after this branch."

Bud can coordinate terminal work and a visual web preview so design review does not depend on screenshots or hand-written setup steps.

### Sysadmin / Operator

"Check the service logs, restart the process if needed, and ask before anything destructive."

Bud keeps terminal work visible, supports human interruption, and can ask structured questions before risky choices.

### Hobbyist / Power User

"Organize these scripts, run the backup job, and explain anything that fails."

Bud brings agentic help to personal machines and self-hosted workflows without requiring the user to move everything into a hosted sandbox.

## Suggested Marketing Site Structure

### Hero

Headline options:
- Bud turns any machine into an agent.
- Put an AI agent inside your real terminal.
- Give your computer an agent that can actually work there.

Subhead options:
- Install Bud on a machine, claim it in the browser, and work with an AI agent that can use the real terminal, preview local apps, and keep context across long-running tasks.
- Bud connects AI to the computers where your work already lives: projects, scripts, servers, local apps, and terminal state.
- A persistent agent workbench for your own machines.

Primary CTA ideas:
- Install Bud
- Connect a machine
- Start a workstream

Secondary CTA ideas:
- See how it works
- View product tour
- Read the technical overview

### Section: How It Works

Use a simple three-step visual:

1. Install the Bud daemon.
2. Claim the machine from the browser.
3. Chat with an agent that can use its terminal.

Keep protocol details out of this section.

### Section: Product Tour

Feature cards:
- Connected machines: all your agent-ready devices in one rail.
- Persistent threads: one terminal per workstream.
- Live terminal: watch, interrupt, and take over.
- Local web previews: inspect apps running on the Bud.
- File viewer: open referenced files in context.
- Model controls: choose the model and reasoning level per thread.
- Context meter: see when long conversations are nearing the budget.
- Ask-before-risky: structured questions when the agent needs human input.

### Section: Built For Real Work

Show multi-audience examples:
- "Debug a repo."
- "Review a local prototype."
- "Operate a server."
- "Automate a personal machine."
- "Keep long tasks alive."

### Section: Transparent By Design

Suggested copy:

Bud does not hide the work. The terminal is visible. Tool activity is visible. The transcript is durable. The user can interrupt the terminal or cancel the agent when needed.

### Section: Under The Hood

Keep this concise and technical enough for credibility:

Bud has three parts:
- a lightweight daemon on the machine,
- a service that coordinates auth, streams, persistence, and model calls,
- a web workbench for chat, terminal, files, and previews.

Mention "persistent terminal sessions" and "owner-scoped resources"; avoid protocol acronyms unless needed for a technical page.

## Voice And Copy Guidance

Tone:
- Clear, grounded, capable.
- More "practical machine agent" than "magical AI companion".
- Confident about terminal and workflow power.
- Careful about security and control.

Use:
- "your machine"
- "real terminal"
- "persistent session"
- "workstream"
- "local app preview"
- "watch and take over"
- "agent-ready machine"

Avoid:
- "full computer control" unless GUI automation is intentionally added.
- "browse your whole filesystem" because the current file viewer is scoped and user-initiated.
- "publicly share localhost apps" because current proxied sites are owner-private.
- "collaborative sessions" because current ownership is single-user per Bud.
- "works on every OS" unless launch packaging confirms daemon and tmux availability for that OS.

## Visual Design Guidance

First viewport should show the product, not an abstract AI gradient:
- Left: Bud rail with online machines.
- Center: chat thread with an agent executing a task.
- Right: live terminal or local web preview.

Useful visual motifs:
- Machine cards or device rail.
- Thread/workstream list.
- Streaming terminal output.
- Local app preview surface.
- File preview side pane.
- Clear online/offline status.
- Human interruption/control affordances.

Avoid making Bud look like a generic chatbot. The product's difference is that the agent is attached to a real machine and the user can see the work.

## What Is Current vs. Future

Good current claims:
- Bud connects an AI agent to a real machine through a small daemon.
- Bud supports persistent, thread-scoped terminal sessions.
- Bud streams terminal output and agent activity to the browser.
- Users can see and type into the terminal.
- Bud supports private local web previews for loopback apps.
- Bud supports read-only, user-clicked file previews.
- Bud supports GitHub/Google sign-in and browser-mediated machine claiming.
- Bud supports per-thread model and reasoning selection through a product catalog.
- Bud supports long-running conversations with internal context compaction.
- Bud can expose an opt-in Bud-local ds4 model for machines that already run a compatible local ds4 API, with prompt context still routed through the Bud service.

Claims to hold unless product scope changes:
- GUI desktop control.
- Broad filesystem browsing.
- Shared team Buds or collaborative sessions.
- Public localhost sharing.
- Production mobile app availability.
- Full OS-agnostic install coverage.

## Glossary

Bud: A machine running the Bud daemon and claimed by a user.

Daemon: The small local process that connects the machine to the Bud service and manages terminal/file/proxy work.

Workbench: The web UI where users chat, observe terminal output, inspect files, and preview local apps.

Thread: A durable workstream tied to one Bud and one persistent terminal session.

Terminal session: The real, thread-scoped shell environment used by both the agent and the user.

Web view: A private preview of a local loopback web app running on the Bud.

File viewer: A read-only preview surface for user-clicked file references.

Ask-user questions: Structured prompts the agent can use when it needs a human decision before continuing.

Context budget: A visible estimate of how much model-visible conversation context remains before compaction.

## Source Areas Reviewed

This handoff is based on the current specs and code layout for:
- `bud/`: device daemon, terminal runtime, file adapter, and localhost proxy adapter.
- `service/`: auth, routes, agent loop, terminal runtime, LLM provider abstraction, file/proxy bridges, notifications, and persistence.
- `web/`: routes, workbench components, thread runtime hooks, terminal/file/web-view panes, model controls, and auth flows.

Primary source specs:
- `bud.spec.md`
- `bud/bud.spec.md`
- `bud/src/src.spec.md`
- `service/service.spec.md`
- `service/src/src.spec.md`
- `service/src/routes/routes.spec.md`
- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/files/files.spec.md`
- `service/src/proxy/proxy.spec.md`
- `web/web.spec.md`
- `web/src/src.spec.md`
- `web/src/routes/routes.spec.md`
- `web/src/components/workbench/workbench.spec.md`
- `web/src/features/threads/threads.spec.md`
