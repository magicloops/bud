# Phase 3: Agent Runtime Ownership Split

## Objective

Split `AgentService` into smaller ownership units so conversation loading, model invocation, terminal tool execution, transcript persistence, and cancellation coordination are no longer bundled in one runtime service.

## Scope

### In scope

- extract conversation-loading ownership
- extract model-runner ownership
- extract terminal tool execution ownership
- extract transcript persistence/runtime event emission ownership
- extract cancellation coordination as its own concern

### Out of scope

- deeper route/gateway decomposition beyond any small plumbing needed for new agent seams
- new tool types or product-level changes to the agent behavior model
- redesign of thread-title semantics beyond using the provider/bootstrap behavior fixed earlier

## Proposed Work

### 1. Extract conversation-loading ownership

Move conversation-building responsibilities out of `AgentService`:

- transcript queries
- system/tool/assistant/user message normalization
- context assembly before model invocation

### 2. Extract model-runner ownership

Create a dedicated runner that owns:

- provider resolution
- request model resolution
- reasoning-effort normalization against the actual selected model/provider
- streaming aggregation
- model-level abort behavior

This is also the right place to clean up any remaining model-capability assumptions that are currently tied too closely to `config.defaultModel`.

### 3. Extract terminal tool execution ownership

Move terminal tool orchestration into a dedicated executor that owns:

- `terminal.observe`
- `terminal.send`
- context-before/context-after snapshots
- readiness normalization for tool results
- mapping terminal runtime errors into agent tool results

### 4. Extract transcript writer and runtime emission ownership

Move persistence/emission responsibilities behind a clearer seam:

- assistant/tool/system message persistence
- runtime event emission and cursor advancement
- final message aggregation
- error/failure message persistence behavior

### 5. Extract cancellation coordination

Create an explicit component that owns:

- per-thread turn cancellation registries
- coordination between model abort and terminal wait abort
- cleanup after success/failure/cancel

## Expected File Areas

- `service/src/agent/agent-service.ts`
- new files under `service/src/agent/`
- `service/src/runtime/agent-runtime-state.ts`
- `service/src/runtime/terminal/` if tool execution needs new runtime hooks

## Testing Strategy

### Automated

- direct tests for conversation loading and normalization
- direct tests for reasoning/model capability normalization against the selected model
- direct tests for terminal tool executor result shaping
- direct tests for cancellation coordinator cleanup and abort behavior

### Manual

- send a normal user message and verify assistant/tool/system transcript behavior remains correct
- run a terminal-heavy turn and confirm tool call / tool result / final assistant streaming still behaves correctly

## Exit Criteria

- `AgentService` becomes a thin composition layer or orchestrator instead of a monolithic implementation
- conversation loading, model invocation, tool execution, transcript persistence, and cancellation each have clear ownership
- model and reasoning normalization are driven by the actual selected model/provider
- direct agent seam tests exist for the extracted units
