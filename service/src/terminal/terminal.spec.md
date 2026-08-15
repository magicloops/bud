# terminal

Terminal-related type definitions plus legacy context-sync/freshness helpers.

## Purpose

Provides TypeScript types for the terminal proto `0.3` wire contract (docs/proto.md §6.7) and service-side helpers that read cached terminal state. The 0.2 REPL program registry (`known-programs.ts`) was deleted in the stem cutover: mode facts now come from the daemon (`mode_changed` events / status info) instead of service-side command inference.

## Files

### `freshness.ts`

Internal terminal freshness and model-visible watermark helper.

**Responsibilities**:
- derive a compact readiness version from readiness-shaped facts (accepts loose `Record<string, unknown>` input; since the Phase 2.5 agent-tool rework the agent always passes `null`, so new watermarks carry `observed_readiness_version: null` and compare on output bytes + cwd)
- build `message.metadata.terminal_visibility` for `terminal.send` and `terminal.observe` tool result rows
- load the latest model-visible terminal watermark from terminal tool message metadata
- load the latest human-origin terminal input timestamp from `terminal_session_input_log`
- compare current session output bytes, cwd, and readiness-version against the latest watermark
- define transient freshness instruction text for future append-only prompt work; the normal agent loop currently does not inject these notes into provider context

Freshness never contacts the Bud daemon. It reads service-owned DB/runtime state.

### `freshness.test.ts`

Focused tests for terminal freshness decisions and terminal visibility metadata parsing.

### `types.ts`

Type definitions for the terminal protocol (proto `0.3`).

**Proto 0.3 vocabulary**:

```typescript
export type TerminalMode = "shell" | "tui" | "repl" | "unknown";
export type TerminalIntegration = "osc133" | "sentinel" | "none";
export type TerminalObservationView = "delta" | "screen" | "history";
export type TerminalSendAwait = "command" | "settled"; // omitted = dispatch-only ack
export interface TerminalEventOutcome { event: string; data: Record<string, unknown>; }
```

`TERMINAL_EVENT_NAMES` lists the known `terminal_event` vocabulary (`prompt_ready`, `command_started`, `command_finished`, `mode_changed`, `settled`, `output_gap`, `child_exited`); unknown event values must be tolerated (additive evolution). `isTerminalMode(...)` / `isTerminalIntegration(...)` are shared guards used by the gateways and runtime state.

**Message Types (0.3)**:

| Type | Direction | Purpose |
|------|-----------|---------|
| `TerminalEnvelope` | Base | Common fields: `type`, `proto`, `id`, `ts`, `ext` |
| `TerminalEnsureMessage` | → Bud | Create/verify the stem session; carries `resume_from_offset` (highest durably stored end offset) so the daemon backfills ring output |
| `TerminalInputMessage` | → Bud | Raw browser input: `{ session_id, data }` (base64); the 0.2 `await_ready` readiness options are retired |
| `TerminalResizeMessage` | → Bud | Resize terminal |
| `TerminalCloseMessage` | → Bud | Close session |
| `TerminalStatusMessage` | ← Bud | Session state report; `info` carries `pid`, `cwd`, `cols`, `rows`, `ring_next_offset`, `mode`, `integration` (`output_log_bytes` retired) |
| `TerminalOutputMessage` | ← Bud | Output chunk: `{ session_id, data, byte_offset }` — `byte_offset` is the sole ordering/dedup/resume coordinate (no `seq`) |
| `TerminalEventMessage` | ← Bud | Semantic event stream: `{ session_id, event, data }` |
| `TerminalSendMessage` / `TerminalSendResultMessage` | ↔ | One structured gesture (`text` + optional `submit`, or one semantic `key`) with optional `await`; result carries `dispatched`, mirrored `outcome` event or `null`, and `error` |
| `TerminalObserveMessage` / `TerminalObserveResultMessage` | ↔ | Explicit grid-backed delta/screen/history observation; result carries text, `lines_captured`, `changed`, plus `mode` / `integration` / `alt_screen` / cursor facts |

Retired from the wire in 0.3: `terminal_ready`, readiness/confidence/hints payloads, `wait_for` / `timeout_ms` / `observe_after_ms`, the one-entry `keys` alias, `host_cwd` (replaced by `prompt_ready.cwd`), `output_bytes` / `truncated` on observe results, and `seq` on output frames.

**Legacy 0.2 types** (the Phase 2.5 agent-tool rework removed every `src/agent/**` use; nothing on the wire, in the terminal runtime, or in the agent tool layer uses them anymore): `ReadinessHints`, `ReadinessAssessment`, `TerminalReadyTrigger`, `TerminalPromptType`, `TerminalWaitFor`, `TerminalDelta`, `TerminalDeltaMessage`. The only remaining reference is `freshness.ts` accepting a readiness-shaped record in its watermark helpers (the agent now always passes `null`); these types can be deleted alongside a small freshness cleanup.

**Other exports**: `TERMINAL_STATES` / `TerminalState`, `TerminalStateSnapshot` and `StateChangeDetails` (context-sync), and `normalizeTerminalSendKeyName(...)` for backend-neutral key names (`ctrl+c`, `enter`, `escape`, ...).

### `context-sync-service.ts`

Legacy terminal context synchronization service.

**Purpose**: Maintains legacy terminal state snapshots and can summarize observed state changes. Normal `POST /messages` sends do not call `checkAndSync(...)`; the agent can call `terminal.observe` explicitly when terminal state matters. As of the Phase 2.5 agent-tool rework, the agent loop no longer calls `refreshSnapshot(...)` either — daemon `mode_changed` / observe-result facts are the mode source for the model — so this service has no remaining runtime callers (server.ts still constructs it and passes it to `AgentService`, which ignores it).

**Key Method**:
```typescript
async checkAndSync(sessionId: string, threadId: string, ownerUserId?: string | null): Promise<string | null>
```

**Workflow**:
1. Capture current terminal state (last 30 lines via `capturePane`, a history-view observe)
2. Compute SHA256 hash of screen content
3. Detect mode heuristically (shell/repl/tui/unknown)
4. Compare to last snapshot stored in `terminalSessionTable.stateSnapshot`
5. If mode or prompt changed: generate a summary (Haiku, deterministic fallback) and insert a `role: "system"` context message stamped with the owning user's `created_by_user_id` and a UUIDv7 `client_id`
6. Update snapshot in database

The 0.2-era pending-command clearing hooks were removed along with the runtime's pending-command tracking; daemon `mode_changed` events are now the mode source of truth for the terminal runtime. Phase 2.5 evaluated this service as required by the earlier TODO: daemon mode facts are now surfaced to the model directly and the agent loop's `refreshSnapshot(...)` call was removed, leaving `checkAndSync(...)` and `refreshSnapshot(...)` with zero runtime callers. <!-- SPEC:TODO Delete context-sync-service.ts, its tests, the server.ts wiring, and the TerminalStateSnapshot/StateChangeDetails types once the terminal-folder owner confirms nothing else will adopt the snapshot heuristics. -->

### `context-sync-service.test.ts`

Mode-detection heuristic tests.

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
