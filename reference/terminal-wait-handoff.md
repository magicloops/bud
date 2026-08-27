# Handoff: mobile adoption of `terminal.wait` and `waiting_for_terminal`

> For the mobile team. Everything here is merged and deployed with the
> service; the daemon side ships in the next tagged release (see
> §Compatibility). All changes are **additive** — nothing existing changed
> shape. Wire truth: `docs/proto.md` §3.2, §6.1, §6.6, §6.7, §7.1; plan:
> `plan/terminal-wait-async-wakeup.md`.

## 1. What changed and why

The agent used to spin-poll `terminal.observe` while a program worked in the
terminal (Codex thinking, a build, a REPL evaluating) — one provider call per
poll, dozens of near-identical tool rows per minute in the transcript you
render. It now has a waiting primitive:

- **`terminal.wait { until?: "settled" | "command_finished" }`** — one tool
  call that parks the turn until the daemon reports the fact (screen went
  quiet / the open command finished), then returns what changed. Returns
  immediately if the terminal is already idle. Service budget: 30 minutes;
  expiry is a normal `outcome: "timeout"` result and the model simply calls
  again.
- **`/agent/state.phase: "waiting_for_terminal"`** while parked — the same
  contract as `waiting_for_user` (`ask_user_questions`): the agent is
  **idle**, not loading; the user can keep chatting; cancel still works.

Measured effect (live drill, `sleep 200` task): ~36 spinning observe/wait
rows became `terminal.run` → one `terminal.wait` (blocked 78 s) → answer.

## 2. What mobile needs to handle

### 2.1 `agent.tool_call` with `name: "terminal.wait"`

`args` is `{ until?: "settled" | "command_finished" }` (may be empty — the
service picks a default from terminal state). Render as **"Waiting on
terminal…"** with elapsed time from `started_at`, not as a generic working
spinner. A pending wait legitimately lasts minutes — that is the feature, not
a hang. `started_at` is also on `/agent/state.pending_tool` for reconnects.

### 2.2 `agent.tool_result` for `terminal.wait`

Top-level convenience fields on the event (snake_case), alongside the full
persisted `message`:

```json
{
  "name": "terminal.wait",
  "kind": "wait",
  "until": "command_finished",
  "outcome": "command_finished",
  "waited_ms": 78017,
  "exit_code": 0,
  "output": "adam@mbp ~ % sleep 200; echo waited-ok\nwaited-ok\nadam@mbp ~ %",
  "changed": true,
  "mode": "shell",
  "integration": "osc133",
  "note": null
}
```

- `outcome ∈ settled | command_finished | prompt_ready | idle | closed |
  timeout | interrupted | superseded`.
- `output` is the **delta since the model last looked** (tail-capped at
  32 KiB with `truncated: true`).
- `exit_code` is present only when the wait ended on a real
  `command_finished`.
- The persisted message row (REST `/messages` and `event.message`) carries
  the same payload in `content`/`metadata` — refreshes and live streams
  agree.

Suggested one-liner: `Waited 28s: command finished (exit 0)`. Exact captured
fixtures for all of this are in §6. Web's label
map, if you want parity: settled → "terminal settled", command_finished →
"command finished (exit N)", prompt_ready → "back at the prompt", idle →
"nothing to wait for", closed → "session closed", timeout → "still busy
(budget expired)", interrupted → "interrupted", superseded → "ended by a new
message".

### 2.3 Phase `waiting_for_terminal`

New value in the `/agent/state.phase` union (bootstrap + reconnect source of
truth); on live streams you can also derive it from
`pending_tool.name === "terminal.wait"`. Treat exactly like
`waiting_for_user`:

- composer stays **enabled** (see 2.4),
- Stop/cancel stays available,
- label it "Waiting on terminal", not a loading state,
- hide any "assistant is thinking" indicator while parked.

### 2.4 Follow-up messages supersede the wait

Posting to `/api/threads/:id/messages` while parked ends the wait
server-side, in this exact order (same as superseding a pending question):

1. `agent.tool_result` for the `terminal.wait` with `outcome: "superseded"`,
2. `final { status: "succeeded", reason: "superseded_by_user_message" }` for
   the old turn,
3. the new message's turn starts (the POST response carries its
   `stream_cursor`).

The terminal program keeps running throughout — superseding the *wait* never
touches the *terminal*.

### 2.5 Interrupt button interaction

A human terminal interrupt (your fact-gated Interrupt button, or typing
Ctrl+C in the terminal view) while a wait is pending ends it with
`outcome: "interrupted"`. Nothing else about the interrupt flow changed.

### 2.6 `terminal.run` may report `status: "input_absorbed"`

New value beside `completed | still_running | terminal_busy | interactive`:
the text was typed but no shell command started (a foreground program
consumed it, or the shell ran nothing). Render like `terminal_busy` —
informational, nothing pending, `note` carries the guidance.

### 2.7 Service-restart repair rows

If the service restarts while a tool call is in flight (most visibly
mid-wait), boot now writes a **synthesized tool row** closing the hole, so a
refreshed timeline never shows the agent silently stopping. Recognize it by:

```json
{ "error": "server_restarted", "code": "SERVER_RESTARTED",
  "server_restart_repair": true, "outcome": "interrupted", "note": "..." }
```

Render as a normal failed/interrupted tool row; `note` explains the terminal
kept running. There is no live event for these (they're written at boot);
they appear on the next `/messages` load. Verbatim example: §6.4.

## 3. Terminal SSE side effect

`terminal.event` `settled` now also fires at the first quiet point after a
**programmatic** gesture — including at an idle shell prompt and including
gestures the program ignored (previously an idle prompt never emitted
`settled`). Human keystrokes via `terminal/input` do not trigger this. If you
gate any UI on `settled`, expect it in `mode: "shell"` with no open command
after agent input. No new `terminal.event` kinds exist; `input_absorbed` is a
send/tool outcome only.

## 4. Compatibility

| peer | behavior |
|---|---|
| daemon without awaited observes (≤ v0.1.8) | `terminal.wait` degrades to an immediate snapshot; the result carries a note telling the model to upgrade. Render the wait row normally — `outcome` will be `settled` with tiny `waited_ms`. |
| daemon with the feature (next release) | full blocking behavior as above |
| client that ignores unknown phases/tools | keeps working — a pending `terminal.wait` renders as a generic pending tool and the phase falls through to your default active state |

## 5. Adoption checklist

- [ ] Add `waiting_for_terminal` to your phase union and map it to a
      "Waiting on terminal" (idle, not loading) state.
- [ ] Keep the composer enabled and Stop available while parked.
- [ ] Render `terminal.wait` tool calls with elapsed time; results with the
      outcome labels above.
- [ ] Handle `final.reason: "superseded_by_user_message"` after sending a
      message during a wait (you already do this for questions — same path).
- [ ] Render `status: "input_absorbed"` run results and
      `server_restart_repair` tool rows.
- [ ] Verify nothing breaks on the extra `settled` terminal events.

## 6. Exact captured examples (durable/live parity)

Captured verbatim from a dev-stack run on 2026-08-27 (service + daemon at
current `main`; task: `sleep 150; echo waited-ok`, which rode the 2-minute
run budget and then finished inside one 28-second wait). Use these as
golden fixtures for parity tests. Join keys across surfaces: `client_id`
(same on tool_call, tool_result, and the message row), `call_id` (provider
tool call), `message_id` (tool_result ↔ `/messages` row).

### 6.1 Live `agent.tool_call` (SSE)

```json
{
  "turn_id": "01M127986PH7H8M5G4RRWPSYKV",
  "client_id": "01a04476-8694-752b-be9d-17115e2f1acc",
  "call_id": "call_W5A58TOyS5N081lnECLOfzVC",
  "name": "terminal.wait",
  "args": {
    "until": "command_finished"
  },
  "started_at": "2026-08-27T18:23:33.524Z"
}
```

### 6.2 Live `agent.tool_result` (SSE)

Top-level convenience fields; the event ALSO carries the full persisted row
as `message` (identical to §6.3 — that is the parity you can assert).
`delta` is always `null` for wait results (`output` is the delta text).

```json
{
  "turn_id": "01M127986PH7H8M5G4RRWPSYKV",
  "client_id": "01a04476-8694-752b-be9d-17115e2f1acc",
  "call_id": "call_W5A58TOyS5N081lnECLOfzVC",
  "message_id": "77d1e0e0-0605-4e78-9569-cdc833ef7ee4",
  "name": "terminal.wait",
  "summary": "Waited 28s; command finished (exit 0)",
  "kind": "wait",
  "exit_code": 0,
  "until": "command_finished",
  "outcome": "command_finished",
  "waited_ms": 27837,
  "output": "adam@mbp-m4 ~ % sleep 150; echo waited-ok\nwaited-ok\nadam@mbp-m4 ~ %",
  "output_bytes": 67,
  "truncated": false,
  "delta": null,
  "changed": true,
  "lines_captured": 3,
  "mode": "shell",
  "integration": "osc133",
  "alt_screen": false,
  "cwd": "/Users/adam",
  "output_truncation_reason": null,
  "started_at": "2026-08-27T18:23:33.524Z",
  "finished_at": "2026-08-27T18:24:01.369Z",
  "duration_ms": 27845,
  "duration_source": "service_wall_clock"
}
```

### 6.3 Durable `/messages` row — completed `terminal.wait`

`content` is the JSON-stringified tool payload; `metadata` is that same
payload plus `turn_id`, service timing (`started_at`/`finished_at`/
`duration_ms`/`duration_source`), model-selection fields, `llm_call_id`,
and terminal context (`path_context_*`, `terminal_visibility`). Rule for
parity tests: every model-facing payload field appears identically in
`content` (parsed), `metadata`, and the live event's top level.

```json
{
  "message_id": "77d1e0e0-0605-4e78-9569-cdc833ef7ee4",
  "client_id": "01a04476-8694-752b-be9d-17115e2f1acc",
  "role": "tool",
  "display_role": "Tool",
  "content": "{\"tool\":\"terminal.wait\",\"call_id\":\"call_W5A58TOyS5N081lnECLOfzVC\",\"until\":\"command_finished\",\"summary\":\"Waited 28s; command finished (exit 0)\",\"kind\":\"wait\",\"mode\":\"shell\",\"integration\":\"osc133\",\"alt_screen\":false,\"open_command\":null,\"cwd\":\"/Users/adam\",\"outcome\":\"command_finished\",\"waited_ms\":27837,\"exit_code\":0,\"output\":\"adam@mbp-m4 ~ % sleep 150; echo waited-ok\\nwaited-ok\\nadam@mbp-m4 ~ %\",\"output_bytes\":67,\"lines_captured\":3,\"changed\":true,\"truncated\":false}",
  "metadata": {
    "cwd": "/Users/adam",
    "kind": "wait",
    "mode": "shell",
    "tool": "terminal.wait",
    "model": "gpt-5.5",
    "until": "command_finished",
    "output": "adam@mbp-m4 ~ % sleep 150; echo waited-ok\nwaited-ok\nadam@mbp-m4 ~ %",
    "call_id": "call_W5A58TOyS5N081lnECLOfzVC",
    "changed": true,
    "outcome": "command_finished",
    "summary": "Waited 28s; command finished (exit 0)",
    "turn_id": "01M127986PH7H8M5G4RRWPSYKV",
    "exit_code": 0,
    "truncated": false,
    "waited_ms": 27837,
    "alt_screen": false,
    "started_at": "2026-08-27T18:23:33.524Z",
    "duration_ms": 27845,
    "finished_at": "2026-08-27T18:24:01.369Z",
    "integration": "osc133",
    "llm_call_id": "01M127CZE8E91DCES30SASNMT3",
    "open_command": null,
    "output_bytes": 67,
    "lines_captured": 3,
    "duration_source": "service_wall_clock",
    "reasoning_effort": "low",
    "path_context_after": {
      "schema": "terminal_cwd_v1",
      "source": "terminal_runtime_cache",
      "host_cwd": "/Users/adam",
      "captured_at": "2026-08-27T18:24:01.366Z",
      "reported_by": "prompt_ready_osc7",
      "terminal_session_id": "sess_01M127986RQ1ZB5VY9WH6DGHZS"
    },
    "path_context_before": {
      "schema": "terminal_cwd_v1",
      "source": "terminal_runtime_cache",
      "host_cwd": "/Users/adam",
      "captured_at": "2026-08-27T18:21:31.341Z",
      "reported_by": "prompt_ready_osc7",
      "terminal_session_id": "sess_01M127986RQ1ZB5VY9WH6DGHZS"
    },
    "terminal_visibility": {
      "schema": "terminal_visibility_v1",
      "source": "terminal_send",
      "session_id": "sess_01M127986RQ1ZB5VY9WH6DGHZS",
      "observed_at": "2026-08-27T18:24:01.371Z",
      "observed_cwd": "/Users/adam",
      "observed_output_log_bytes": 855,
      "observed_readiness_version": null
    },
    "model_selection_source": "thread"
  },
  "created_at": "2026-08-27T18:24:01.371Z"
}
```

### 6.4 Durable `/messages` row — service-restart repair

Written at service boot (no live event, no timing/model metadata — the
original turn died with the old process). `metadata.turn_id` is the dead
turn; `server_restart_repair: true` is the discriminator.

```json
{
  "message_id": "58365bb2-efc2-45f2-9c6c-ede4f0d606e7",
  "client_id": "01a04477-7e89-75e5-81fb-4942d0e2949e",
  "role": "tool",
  "display_role": "Tool",
  "content": "{\"tool\":\"terminal.wait\",\"call_id\":\"call_exrepair\",\"until\":\"command_finished\",\"summary\":\"Terminal wait was interrupted by a service restart; the terminal kept running\",\"kind\":\"wait\",\"outcome\":\"interrupted\",\"error\":\"server_restarted\",\"ok\":false,\"code\":\"SERVER_RESTARTED\",\"retryable\":true,\"note\":\"The service restarted before this tool call finished, so no result was recorded. The terminal and any program in it kept running on the Bud — nothing was interrupted there, and a running command may have finished meanwhile. Check the current state with terminal.observe, keep waiting with terminal.wait, or re-run the command if it never started.\",\"server_restart_repair\":true}",
  "metadata": {
    "ok": false,
    "code": "SERVER_RESTARTED",
    "kind": "wait",
    "note": "The service restarted before this tool call finished, so no result was recorded. The terminal and any program in it kept running on the Bud — nothing was interrupted there, and a running command may have finished meanwhile. Check the current state with terminal.observe, keep waiting with terminal.wait, or re-run the command if it never started.",
    "tool": "terminal.wait",
    "error": "server_restarted",
    "until": "command_finished",
    "call_id": "call_exrepair",
    "outcome": "interrupted",
    "summary": "Terminal wait was interrupted by a service restart; the terminal kept running",
    "turn_id": "01M127EXAMPLETURNID0000000",
    "retryable": true,
    "server_restart_repair": true
  },
  "created_at": "2026-08-27T18:24:37.002Z"
}
```

## 7. How to verify against a dev stack

1. Service + daemon from current `main`, thread on the dev bud.
2. Send: *"Run `sleep 200; echo ok` and report the exit code."* → expect
   `terminal.run` → `still_running` at 2 min → one `terminal.wait` parked
   (phase `waiting_for_terminal`) → result `command_finished`, exit 0.
3. While parked, send a follow-up message → expect the superseded sequence
   from §2.4 and a fresh turn.
4. While parked, hit Interrupt → expect `outcome: "interrupted"`.
5. Kill the service mid-wait, restart → expect a `server_restarted` tool row
   on the next `/messages` load.
