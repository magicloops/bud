# Mobile Handoff: Terminal Events, Offset Resume, and Snapshot Rendering

Practical contract summary for the iOS client consuming the proto `0.3`
terminal surface after the `stem` cutover. The wire source of truth is
[docs/proto.md](../docs/proto.md) §6 (Bud ⇄ Service terminal protocol) and §7
(browser/mobile SSE contracts); this doc summarizes the client-facing shapes
and the rules a native client must follow, and cites those sections rather
than duplicating every wire example. iOS implementation itself is out of
scope.

What changed vs. the retired `0.2` surface (details in proto §6 intro):

- Output is **offset-addressed only** (`seq` is gone). Byte offsets are
  absolute from session start, monotonic, and never reset across daemon
  restarts or reattach.
- The readiness-confidence vocabulary (`terminal_ready`, `confidence`,
  `hints`, `wait_for`) is retired. Clients render **typed facts** from
  `terminal.event` instead of inferring activity from elapsed time.
- Commands have real lifecycle events with exit codes and output byte ranges
  (`terminal_command` rows service-side).

---

## 1. Terminal SSE stream

```
GET /api/threads/:thread_id/terminal/stream
```

Authorized, thread-scoped (same cookie/token auth as other thread routes; a
signed-in viewer asking for another user's thread gets `404`). Events (proto
§7.2):

| SSE event | Payload summary | Notes |
|---|---|---|
| `terminal.output` | `{ session_id, data (base64), byte_offset }` | `byte_offset` addresses the FIRST byte of `data`. The SSE `id:` is the chunk's **end offset** (`byte_offset + decoded length`), so `Last-Event-ID` always names the next byte the client needs. Chunks are ≤ 16 KiB and may split UTF-8 code points — feed a **streaming** decoder, never decode per-chunk. |
| `terminal.event` | `{ session_id, event, data, ts }` | Proto §6.4 frames forwarded verbatim. Carries **no SSE `id`**, so output offsets stay the resume cursor. Unknown `event` values must be ignored (additive evolution). |
| `terminal.status` | `{ session_id, state, info? }` | `state ∈ ready|active|idle|closed`; `info` may carry `pid`, `cwd`, `cols`, `rows`, `ring_next_offset`, `mode`, `integration` (proto §6.2). |
| `terminal.bud_offline` | `{ bud_id, reason }` | Owning Bud disconnected; expect no output until `bud_online`. |
| `terminal.bud_online` | `{ bud_id }` | Owning Bud reconnected. |
| `heartbeat` | — | Keep-alive; valid even when nothing else flows. Drive staleness/reconnect policy from heartbeats + events, not from output silence. |

### `terminal.event` vocabulary (proto §6.4)

| `event` | `data` | Client rendering guidance |
|---|---|---|
| `prompt_ready` | `{ cwd? }` | Shell is back at a prompt; safe input state. `cwd` from OSC 7 when available. |
| `command_started` | `{ command_id, output_byte_start }` | Start a "running" chip keyed by `command_id`. |
| `command_finished` | `{ command_id, exit_code?, duration_ms?, output_byte_start, output_byte_end }` | Finish the chip with the real exit code. `exit_code`/`duration_ms` are **omitted** (not null) when unknown. The byte range slices this command's output. |
| `mode_changed` | `{ mode, integration }` | `mode ∈ shell|tui|repl|unknown`; `integration ∈ osc133|sentinel|none`. Drive a mode indicator and an honest "waiting on TUI" state. `osc133` means live shell-integration markers (exact lifecycle); `sentinel` means the daemon appends an invisible exit-code trailer to submitted commands so `command_finished` still carries a real exit code; `none` means neither — expect `settled` instead of command lifecycle. |
| `settled` | `{ mode, quiet_ms }` | Output went damage-quiet in `tui`/`repl`/`unknown` modes (or mid-command inline TUIs). "Output stopped changing", not "command done". |
| `output_gap` | `{ from_offset, resume_offset }` | The daemon's ring discarded bytes at the requested resume offset. Treat as a hard gap: full re-render (snapshot, then resume from the new offset), never splice. |
| `child_exited` | `{ exit_code?, signal? }` | Session root process exited; expect `terminal.status` `closed`. |

An event's byte references never point past output the service has not yet
sent.

## 2. Resume rules

- **First attach for a thread view:** fetch the snapshot (§3), render it, then
  connect the stream resuming from the snapshot's `ring_next_offset` via the
  `from_offset` query parameter on the stream URL
  (`GET .../terminal/stream?from_offset=N`). The server backfills durably
  stored output from exactly that offset before live forwarding. When both
  `from_offset` and `Last-Event-ID` are present the server resumes from the
  HIGHER cursor, so a reconnect that reuses the original URL (stale query
  param) with a fresher header never duplicates output.
- **Reconnects:** send SSE `Last-Event-ID` with the last **applied** end
  offset (that is what the server stamped as `id:` on the last output chunk
  you rendered). The server replays from that offset; no client-side reset is
  needed on routine reconnects.
- Buffer live events that arrive while a backfill/snapshot is being applied,
  then apply them in offset order — offsets make replay idempotent
  (at-least-once delivery; drop chunks whose end offset ≤ what you've
  applied).
- Full terminal reset only on `output_gap` (or a `closed` → new session
  transition), never on routine reconnects.

## 3. Snapshot endpoint

```
GET /api/threads/:threadId/terminal/snapshot?lines=N
```

Returns a render-ready snapshot of the session's emulator state:

```json
{
  "session_id": "sess_01H...",
  "mode": "shell",
  "integration": "osc133",
  "alt_screen": false,
  "history_text": "…scrollback lines…",
  "screen_text": "…current screen…",
  "cols": 120,
  "rows": 40,
  "ring_next_offset": 84213
}
```

Render `history_text` + `screen_text`, then resume the output stream from
`ring_next_offset` (§2) — no duplication, no gap. This replaces the old
byte-tail history replay for initial render: raw byte-tails produce ~no
visible scrollback after TUI-heavy sessions, so use the line-oriented snapshot
for first paint and offsets for everything after.

## 4. Other REST routes

- **Interrupt** (proto §3.4.1): `POST /api/threads/:thread_id/terminal/interrupt`
  — thread-scoped human Ctrl+C through the normal send path (dispatch-only).
  Success: `{ ok, session_id, submitted, rejected_pending_requests }`; missing
  session: `404 { "error": "no_terminal_session" }`.
- **History byte range**: `GET /api/threads/:thread_id/terminal/history` with
  `bytes=<max>` (default 4096) and optional `since_offset=<start>` →
  `{ session_id, bytes, start_offset, end_offset, truncated, next_offset,
  total_bytes_available, data_base64 }`. Without `since_offset` it returns the
  tail. Bulk backfill only — prefer §3 snapshot + §2 offsets for rendering.

## 5. Agent tool args on the agent stream (for tool chips)

Terminal tool calls surfaced through `agent.tool_call` on
`GET /api/threads/:thread_id/agent/stream` mirror the model-facing schemas
(proto §6.7, §7.1):

- `terminal.run` — `{ "command": "whoami" }`; result carries `exit_code`,
  `duration_ms`, `command_id`, sliced `output`, `mode`, `integration`, `cwd`.
  A non-zero exit code is a normal result, not an error; on service timeout
  the result reports still-running, never a fabricated failure.
- `terminal.send` — exactly one gesture: `{ "raw_text": "partial" }` or
  `{ "key": "ctrl+c" }`, optional `submit` (raw text presses Enter afterward
  by default; `submit: false` types without submitting).
- `terminal.observe` — `{ "view": "delta" | "screen" | "history", "lines"? }`
  (tool default `delta`).

`wait_for` and legacy `text`/`submit`/`command`-on-send fields do not exist in
tool args. Terminal transport failures arrive as structured tool results
(`code: "BUD_DISCONNECTED"`, `retryable: true`), not stream errors.

## 6. Validation

Mirrors the mobile row of
[plan/native-terminal-session-manager/validation-checklist.md](../plan/native-terminal-session-manager/validation-checklist.md) §B:

- [ ] This doc reviewed against a captured SSE transcript from a live thread
      (shapes match `docs/proto.md` §§6–7): output offsets/`id:` stamping,
      each `terminal.event` type, status, bud_online/offline, heartbeats.
- [ ] Snapshot → stream resume drill: render snapshot, resume from
      `ring_next_offset`, kill the connection mid-stream, reconnect with
      `Last-Event-ID` — no lost or duplicated bytes (verify against a
      numbered `seq 1 10000` output), no spurious full reset.
- [ ] Multi-byte/emoji output split across chunk boundaries renders without
      U+FFFD (streaming decoder in place).
- [ ] `output_gap` handling: flood past the ring cap while disconnected, then
      resume — client performs a clean full re-render, no spliced garbage.
- [ ] Command chips: running → exit-code from `command_started`/`command_finished`;
      TUI mode indicator appears in vim; `settled` never rendered as "done".
