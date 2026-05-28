# Phase 2: Terminal Visibility Watermarks

## Objective

Make terminal freshness accurate and durable enough to avoid noisy hints by persisting model-visible terminal watermarks on terminal tool result messages.

This phase turns the coarse Phase 1 freshness snapshot into a unified comparison between current terminal state and the latest terminal facts shown to the model.

## Scope

- Persist `message.metadata.terminal_visibility` for `terminal.observe` results.
- Persist `message.metadata.terminal_visibility` for `terminal.send` results.
- Advance the model-visible watermark even when `terminal.send` has no visible output, if readiness/context/cwd/dispatch facts were shown to the model.
- Include cached cwd and readiness/context in the same watermark model as output bytes.
- Include human-origin terminal input as a dirty signal.
- Keep all freshness state internal.
- Avoid a new database table unless a later performance review proves it is needed.

## Metadata Shape

Tool result messages should include metadata like:

```json
{
  "tool": "terminal_send",
  "terminal_visibility": {
    "session_id": "bud-...-thread-...",
    "observed_output_log_bytes": 123456,
    "observed_cwd": "/Users/adam/bud/service",
    "observed_readiness_version": "ready:shell:prompt_detected:123456",
    "observed_at": "2026-05-28T18:44:21.000Z",
    "source": "terminal_send"
  }
}
```

The exact `observed_readiness_version` format can be internal. It only needs to be stable enough to compare whether the model-visible readiness/context differs from current session state.

## Dirty Decision

The resolver should compare:

- current `terminal_session.output_log_bytes`
- current cached `terminal_session.cwd`
- current readiness/context version available to the service
- latest human-origin `terminal_session_input_log` timestamp

against the latest `message.metadata.terminal_visibility` for the thread/session.

Dirty reasons:

- `new_output`: current output bytes are greater than model-visible output bytes
- `human_input`: human input occurred after the latest model-visible terminal watermark
- `cwd_changed`: cached cwd differs from the model-visible cwd
- `status_changed`: readiness/context version differs from the latest watermark
- `unknown_watermark`: a session exists but the service cannot establish a reliable latest model-visible watermark

`cwd_changed` and `status_changed` should produce the same single freshness hint as `new_output`; they should not create separate prompt text paths.

## Expected Code Changes

- `service/src/agent/transcript-writer.ts`
  - include `terminal_visibility` metadata when persisting terminal tool result rows
  - preserve existing metadata such as timing and path context

- `service/src/agent/terminal-tool-executor.ts`
  - continue returning readiness/context facts in terminal tool results

- `service/src/runtime/terminal-session-manager.ts`
  - expose safe current session/readiness reads for an authorized session
  - avoid daemon access in watermark reads

- freshness helper from Phase 1
  - query latest terminal visibility metadata for the thread/session
  - query current session state and human input state
  - produce clean/dirty/unknown snapshot with reasons

## Ownership And Authorization

Freshness lookup must be scoped through the already-authorized thread and its owned terminal session.

Rules:

- never trust raw `session_id` from the client
- use the thread row authorized by `requireAuthorizedThreadAccess(...)`
- only inspect terminal sessions belonging to that thread
- message metadata queries must filter by thread id
- human input log queries must filter by the resolved session id from the owned thread

## Tests

- `terminal.observe` result persists terminal visibility metadata.
- `terminal.send` result with visible output persists terminal visibility metadata.
- `terminal.send` result with no visible output still advances the watermark when readiness/context/cwd/dispatch facts are shown.
- New output bytes after the latest watermark produce `new_output`.
- Human input after the latest watermark produces `human_input`.
- Cached cwd change after the latest watermark produces `cwd_changed`.
- Readiness/context change after the latest watermark produces `status_changed`.
- Equal current/model-visible watermark produces `clean`.
- Missing or malformed terminal visibility metadata produces `unknown_watermark`, not a daemon observe.
- Freshness lookup cannot read another user's terminal/session data.

## Specs To Update

- `service/src/agent/agent.spec.md`
- `service/src/runtime/runtime.spec.md`
- `service/src/terminal/terminal.spec.md`
- `service/src/routes/threads/threads.spec.md`
- `design/terminal-freshness-hints.md` if the exact metadata shape changes

## Acceptance Criteria

- [x] Freshness is derived from a unified model-visible terminal watermark.
- [x] No-visible-output sends can still mark the terminal as model-visible.
- [x] cwd/readiness changes participate in the same dirty decision as output bytes.
- [x] All freshness reads are scoped through the thread/session resolved by the agent.
- [x] No new browser/mobile API fields are introduced.
