# terminal

Terminal-related type definitions and REPL program registry.

## Purpose

Provides TypeScript types for terminal protocol messages and a registry of known interactive programs for context-aware agent behavior.

## Files

### `types.ts`

Type definitions for the terminal protocol (v0.2).

**State Types**:

```typescript
export const TERMINAL_STATES = ["none", "creating", "ready", "active", "idle", "closed"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];
```

**Prompt Detection Types**:

```typescript
export type TerminalPromptType =
  | "shell" | "python" | "node" | "ruby"
  | "confirmation" | "password" | "pager"
  | "database" | "unknown";

export type TerminalReadyTrigger =
  | "prompt_detected" | "quiescence" | "timeout" | "activity_stable"
  | "changed" | "settled";

export type TerminalWaitFor =
  | "none" | "shell_ready" | "changed" | "settled";
```

**Message Types**:

| Type | Direction | Purpose |
|------|-----------|---------|
| `TerminalEnvelope` | Base | Common fields: `type`, `proto`, `id`, `ts`, `ext` |
| `TerminalEnsureMessage` | → Bud | Create/verify tmux session |
| `TerminalInputMessage` | → Bud | Send input with await_ready options |
| `TerminalInterruptMessage` | → Bud | Send Ctrl+C |
| `TerminalResizeMessage` | → Bud | Resize terminal |
| `TerminalCloseMessage` | → Bud | Close session |
| `TerminalStatusMessage` | ← Bud | Session state report |
| `TerminalOutputMessage` | ← Bud | Output chunk with byte offset |
| `TerminalReadyMessage` | ← Bud | Readiness assessment |
| `TerminalSendMessage` / `TerminalSendResultMessage` | ↔ | Primary send-first terminal input with fast post-send delta |
| `TerminalObserveMessage` / `TerminalObserveResultMessage` | ↔ | Explicit delta/screen/history observation |
| `TerminalDelta` / `TerminalDeltaMessage` | Internal / Wire | Minimal additive delta payload for send/observe |
| `TerminalScreenStateMessage` | Wire | Exact visible-screen metadata for `view: "screen"` |
| `BrowserTerminalBootstrap` | Service/Web | Rich `/terminal/state` bootstrap union (`grid` / `text` / `unavailable`) |

**Readiness Types**:

```typescript
export interface ReadinessHints {
  looks_like_prompt: boolean;
  looks_like_confirmation: boolean;
  looks_like_password: boolean;
  looks_like_pager: boolean;
  looks_like_error: boolean;
  may_still_be_processing: boolean;
}

export interface ReadinessAssessment {
  ready: boolean;
  confidence: number;        // 0.0 - 1.0
  trigger: TerminalReadyTrigger;
  prompt_type?: TerminalPromptType;
  hints: ReadinessHints;
  quiet_for_ms?: number;
  activity_checks?: number;  // For activity-based detection
  stable_checks?: number;
}
```

**Terminal Request/Response Types**:

```typescript
export interface TerminalSendObserve {
  after_ms?: number;
  wait_for?: TerminalWaitFor;
  timeout_ms?: number;
}

export interface TerminalSendMessage extends TerminalEnvelope {
  type: "terminal_send";
  session_id: string;
  request_id: string;
  text?: string;
  submit?: boolean;
  keys?: string[];
  observe?: TerminalSendObserve | null;
}

export interface TerminalSendResultMessage extends TerminalEnvelope {
  type: "terminal_send_result";
  session_id: string;
  request_id: string;
  submitted: boolean;
  delta?: TerminalDeltaMessage | null;
  readiness: ReadinessAssessment;
  error: string | null;
}

export interface TerminalObserveMessage extends TerminalEnvelope {
  type: "terminal_observe";
  session_id: string;
  request_id: string;
  view?: "delta" | "screen" | "history";
  lines?: number;
  wait_for?: TerminalWaitFor;
  timeout_ms?: number;
}
```

**Command Tracking Types**:

```typescript
export type TerminalInputSource = "agent" | "human" | "emulator_protocol" | "system";

export interface PendingCommand {
  input: string;      // Raw input, e.g., "claude\n"
  command: string;    // Parsed name, e.g., "claude"
  sentAt: number;
  source: "agent" | "human" | "emulator_protocol" | "system";
}

export type TerminalContextMode = "shell" | "repl" | "unknown";

export interface TerminalContext {
  mode: TerminalContextMode;
  pendingCommand?: PendingCommand;
  program?: string;
  programDisplayName?: string;
  interactionStyle?: string;
  hints?: string[];
}
```

**Await Ready Options** (in TerminalInputMessage):

```typescript
await_ready: {
  enabled: boolean;
  quiescence_ms?: number;     // Default: 1500ms
  max_wait_ms?: number;       // Default: 30000ms
  activity_based?: boolean;   // Use capture-pane comparison
  activity_interval_ms?: number;      // Default: 5000ms
  activity_stable_count?: number;     // Default: 2
  activity_initial_delay_ms?: number; // Default: 2000ms
}
```

**Phase 6/7 Interactive Wait Notes**:
- `terminal.send` now supports optional nested `observe`; when present it defaults to a fast post-send delta capture after `1000ms`
- omitting `observe` produces a dispatch-only acknowledgement with no post-send delta capture
- `terminal.send` is now the primary tool for both shell commands and interactive input, including normal browser typing through the service `/terminal/send` surface
- agent-facing explicit waits are now `changed` and `settled`
- `terminal.send` and `terminal.observe` share the same immediate-start screen wait engine for `changed` / `settled`
- `settled` means "screen has been quiet for a short window", not the older blind `screen_stable` loop
- `submitted` means Bud dispatched at least one text/key/Enter event to tmux
- `delta.changed` is the main signal for whether the foreground program visibly reacted right away
- `readiness.trigger: "dispatch_only"` marks sends where Bud returned after dispatch without measuring the resulting screen state
- default `terminal.observe` now uses `view: "delta"` and only returns full current screen/history when explicitly requested
- `terminal.observe(view: "screen")` can now carry `screen_state` with capture scope, pane geometry, cursor position, and exact visible rows so `/terminal/state` can bootstrap xterm without replaying raw history
- low-level `terminal_input` / `terminal_interrupt` readiness can still surface `activity_stable`, but that is no longer the primary agent-facing wait mode

### `known-programs.ts`

Registry of interactive programs the agent might encounter.

**ProgramInfo Type**:

```typescript
export interface ProgramInfo {
  name: string;
  displayName: string;
  interactionStyle: InteractionStyle;
  exitCommands: string[];
  hints: string[];
}

export type InteractionStyle = "natural_language" | "code" | "sql" | "commands";
```

**Registered Programs**:

| Program | Display Name | Style | Example Hints |
|---------|--------------|-------|---------------|
| `claude` | Claude Code | natural_language | "Use natural language requests, not shell commands" |
| `python` | Python REPL | code | "Send Python code, not shell commands" |
| `python3` | Python 3 REPL | code | Same as python |
| `ipython` | IPython | code | "Magic commands start with %" |
| `node` | Node.js REPL | code | "Send JavaScript code" |
| `deno` | Deno REPL | code | "Send TypeScript/JavaScript code" |
| `irb` | Ruby IRB | code | "Send Ruby code" |
| `psql` | PostgreSQL | sql | "Meta-commands start with backslash" |
| `mysql` | MySQL | sql | "Commands ending with semicolon" |
| `sqlite3` | SQLite | sql | "Dot-commands for meta operations" |
| `redis` | Redis CLI | commands | "Commands are case-insensitive" |
| `mongosh` | MongoDB Shell | code | "Use db.collection.find()" |
| `ghci` | GHCi (Haskell) | code | "Commands start with colon" |
| `erl` | Erlang Shell | code | "Expressions end with period" |
| `iex` | Elixir IEx | code | "Exit with Ctrl+C twice" |
| `scala` | Scala REPL | code | "Commands start with colon" |
| `lua` | Lua REPL | code | "Use print() for output" |
| `R` | R Console | code | "Use print() or expression" |
| `julia` | Julia REPL | code | "Package mode with ]" |

**Helper Functions**:

```typescript
export function isKnownReplProgram(command: string): boolean;
export function getProgramInfo(command: string): ProgramInfo | undefined;
```

### `context-sync-service.ts`

Pre-flight terminal context synchronization service.

**Purpose**: Detects terminal state changes before user messages are processed and injects context update messages to keep the agent informed. This solves the "stale context" problem where the agent thinks it's in a REPL when it's actually back at a shell prompt.

**Key Method**:
```typescript
async checkAndSync(sessionId: string, threadId: string, ownerUserId?: string | null): Promise<string | null>
```

**Workflow**:
1. Capture current terminal state (last 30 lines via `capturePane`)
2. Compute SHA256 hash of screen content
3. Detect mode heuristically (shell/repl/tui/unknown)
4. Compare to last snapshot stored in `terminalSessionTable.stateSnapshot`
5. If mode or prompt changed:
   - Generate human-readable summary using Haiku
   - Insert system message into thread
6. Update snapshot in database

**Mode Detection Heuristics**:
| Pattern | Detected Mode |
|---------|---------------|
| Line ends with `$`, `#`, `%`, `❯`, `➜`, `>` | shell |
| Line starts with `>>>`, `...`, `In [N]:` | repl (Python/IPython) |
| Screen contains box drawing chars (`╭╰`) + "Claude" | tui (Claude Code) |
| Screen has vim-style line numbers | tui |

**Integration Points**:
- Clears `pendingCommands` when shell detected so inferred send-context stays aligned after REPL exit
- `refreshSnapshot(...)` now also clears `pendingCommands` when the captured state already looks like shell, so inferred context is less likely to outlive an observed REPL exit
- Uses `claude-haiku-4-5` for fast, cheap LLM summaries
- Injects messages with `role: "system"` (transformed in provider layer for Anthropic)
- Stamps injected system messages with the owning user's `created_by_user_id`
- Stamps injected system messages with a generated UUIDv7 `message.client_id` so context-sync rows share the same public-identity model as user/assistant/tool messages

## Usage

The agent service uses these types for:
1. Sending correctly-typed terminal messages to buds
2. Understanding readiness assessments from buds
3. Detecting when agent enters a REPL and adjusting guidance

Example context usage:
```typescript
const context = await terminalSessionManager.getContext(sessionId);
if (context.mode === "repl" && context.program === "claude") {
  // Agent is inside Claude Code - use natural language
}
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `../config.js` | `TERMINAL_PROTO_VERSION` constant |
| `../db/client.js` | Database access (context-sync-service) |
| `../db/message-client-id.js` | UUIDv7 generation for injected system-message `client_id` values |
| `../db/schema.js` | Table schemas (context-sync-service) |
| `../llm/index.js` | LLM provider registry (context-sync-service) |
| `../runtime/terminal-session-manager.js` | capturePane access (context-sync-service) |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
