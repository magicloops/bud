# terminal

Terminal-related type definitions and REPL program registry.

## Purpose

Provides TypeScript types for terminal protocol messages and a registry of known interactive programs for context-aware agent behavior.

## Files

### `freshness.ts`

Internal terminal freshness and model-visible watermark helper.

**Responsibilities**:
- derive a compact readiness version from readiness facts shown to the model
- build `message.metadata.terminal_visibility` for `terminal.send` and `terminal.observe` tool result rows
- load the latest model-visible terminal watermark from terminal tool message metadata
- load the latest human-origin terminal input timestamp from `terminal_session_input_log`
- compare current session output bytes, cwd, readiness, and human input against the latest watermark
- return one transient freshness instruction for provider context when terminal state may be stale

Freshness never contacts the Bud daemon. It reads service-owned DB/runtime state and lets the model call `terminal.observe` when terminal state matters.

### `freshness.test.ts`

Focused tests for terminal freshness decisions and terminal visibility metadata parsing.

**Current Coverage**:
- unknown watermarks with existing terminal state produce a freshness hint
- `terminal.send` visibility can clear the dirty hint even when no new output bytes were shown
- cwd-only changes participate in the same watermark path
- human terminal input after the last model-visible terminal result uses the stronger hint
- visibility metadata is parsed only from tool message metadata

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
  | "prompt_detected" | "quiescence" | "timeout" | "error" | "activity_stable"
  | "changed" | "settled";

export type TerminalWaitFor =
  | "none" | "shell_ready" | "changed" | "settled";
```

`shell_ready` is compatibility-only below the model schema during the rollout. The model-facing agent tools advertise only `none`, `changed`, and `settled`; legacy `screen_stable` payloads are normalized to `settled` before replay/dispatch where supported.

**Message Types**:

| Type | Direction | Purpose |
|------|-----------|---------|
| `TerminalEnvelope` | Base | Common fields: `type`, `proto`, `id`, `ts`, `ext` |
| `TerminalEnsureMessage` | → Bud | Create/verify tmux session |
| `TerminalInputMessage` | → Bud | Send input with await_ready options |
| `TerminalResizeMessage` | → Bud | Resize terminal |
| `TerminalCloseMessage` | → Bud | Close session |
| `TerminalStatusMessage` | ← Bud | Session state report |
| `TerminalOutputMessage` | ← Bud | Output chunk with byte offset |
| `TerminalReadyMessage` | ← Bud | Readiness assessment |
| `TerminalSendMessage` / `TerminalSendResultMessage` | ↔ | Primary send-first terminal input with settled-by-default output quiescence, additive delta evidence, and optional daemon-reported cwd |
| `TerminalObserveMessage` / `TerminalObserveResultMessage` | ↔ | Explicit delta/screen/history observation with optional daemon-reported cwd |
| `TerminalDelta` / `TerminalDeltaMessage` | Internal / Wire | Minimal additive delta payload for send/observe |

`TerminalStatusMessage.info` now carries backend-neutral runtime facts such as `pid`, `cwd`, `cols`, `rows`, and `output_log_bytes`; tmux session identity is no longer part of the normal service/browser contract.

`TerminalSendResultMessage.host_cwd` and `TerminalObserveResultMessage.host_cwd` are optional result-time cwd reports from the daemon; the runtime caches them on `terminal_session.cwd` for message-time file path resolution.

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

export interface TerminalSendMessage extends TerminalEnvelope {
  type: "terminal_send";
  session_id: string;
  request_id: string;
  text?: string;
  submit?: boolean;
  key?: string;
  keys?: string[];  // compatibility alias during rollout
  observe_after_ms?: number;
  wait_for?: TerminalWaitFor;
  timeout_ms?: number;
}

export interface TerminalSendResultMessage extends TerminalEnvelope {
  type: "terminal_send_result";
  session_id: string;
  request_id: string;
  submitted: boolean;
  delta?: TerminalDeltaMessage | null;
  readiness: ReadinessAssessment;
  error: string | null;
  host_cwd?: string;
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
export interface PendingCommand {
  input: string;      // Raw input, e.g., "claude\n"
  command: string;    // Parsed name, e.g., "claude"
  sentAt: number;
  source: "agent" | "user" | "system";
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
- `terminal.send` now defaults to `wait_for: "settled"` and the service resolves settled waits to a one-hour timeout budget before sending `timeout_ms` to Bud
- settled waits are now driven by `pipe-pane` output quiescence, not repeated `capture-pane` polling
- Bud starts settled `terminal.send` quiescence/readiness sampling after dispatch plus a short guard delay; the model-facing delta still compares the pre-send capture to the final capture, so command echo remains visible when it is part of the rendered change
- settled quiescence is evidence-based: prompt/confirmation/password/pager evidence can be high-confidence ready, but weak settled captures do not become high-confidence ready solely because output is quiet
- `terminal.send` still supports the older fast path, but only when `wait_for: "none"` is requested explicitly
- `terminal.send` is now the primary tool for both shell commands and interactive input
- `terminal.send` is now a single-gesture contract: either `text` with optional `submit`, or one semantic `key`
- `terminal.send.key` uses backend-neutral key names such as `ctrl+c`, `enter`, and `escape`
- `terminal.send.keys` remains a one-entry compatibility alias during rollout
- agent-facing explicit waits are now `changed` and `settled`
- model-facing wait modes are now limited to `none`, `changed`, and `settled`; `shell_ready` remains an internal compatibility mode until production-launch cleanup
- `terminal.send` and `terminal.observe` still share the same delta engine, but only `changed` stays on the immediate-start screen wait engine
- `terminal.observe(wait_for: "settled")` receives the same one-hour settled timeout budget as default `terminal.send`
- `terminal.observe(wait_for: "settled")` shares the same conservative settled-readiness semantics for weak captures
- model-facing agent tool schemas no longer advertise `timeout_ms`; `timeout_ms` remains on the wire so the service can pass the effective product policy to Bud and tolerate older payloads
- human interrupt controls call the service terminal interrupt route, which sends `TerminalSendMessage.key = "ctrl+c"` with a fast `wait_for: "none"` interrupt send and rejects older pending terminal waits as `interrupted`
- `submitted` means Bud dispatched the requested gesture to the current terminal backend
- `delta.changed` is the main signal for whether the foreground program visibly reacted right away
- default `terminal.observe` now uses `view: "delta"` and only returns full current screen/history when explicitly requested
- low-level `terminal_input` readiness can still surface `activity_stable`, but that is no longer the primary agent-facing wait mode
- browser/server Ctrl+C escape hatches should route through `TerminalSendMessage.key = "ctrl+c"` rather than a dedicated interrupt message

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

Legacy terminal context synchronization service.

**Purpose**: Maintains legacy terminal state snapshots and can summarize observed state changes. Normal `POST /messages` sends no longer call `checkAndSync(...)` or run a Bud `terminal_observe` preflight; terminal freshness hints supersede that path for normal sends. `refreshSnapshot(...)` remains useful after state-changing terminal tools to keep snapshot state and pending-command cleanup aligned.

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
| Bare `>` without Claude UI markers | repl (Node.js REPL) |
| Line ends with `$`, `#`, `%`, `❯`, `➜`, `>` | shell |
| Line starts with `>>>`, `...`, `In [N]:` | repl (Python/IPython) |
| Screen contains box drawing chars (`╭╰`) + "Claude" | tui (Claude Code) |
| Screen has vim-style line numbers | tui |

The Node.js REPL check runs before the generic shell `>` matcher so plain `>` prompts are not misclassified as shell.

**Integration Points**:
- Clears `pendingCommands` when shell detected so inferred send-context stays aligned after REPL exit
- `refreshSnapshot(...)` now also clears `pendingCommands` when the captured state already looks like shell, so inferred context is less likely to outlive an observed REPL exit
- `checkAndSync(...)` is not part of the normal user-message send path; it is retained for legacy/debug flows only
- Uses `claude-haiku-4-5` for fast, cheap LLM summaries
- Falls back to deterministic local summaries when no provider is available or summary generation fails
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
| `../db/schema.js` | Table schemas (context-sync-service and freshness helper) |
| `../llm/index.js` | LLM provider registry (context-sync-service) |
| `../runtime/terminal-session-manager.js` | capturePane access (context-sync-service) |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
