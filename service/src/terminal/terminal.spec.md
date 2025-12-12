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
  | "prompt_detected" | "quiescence" | "timeout" | "activity_stable";
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

---

*Referenced by: [../src.spec.md](../src.spec.md)*
