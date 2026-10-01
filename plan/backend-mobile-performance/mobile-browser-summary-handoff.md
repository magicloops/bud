# Mobile handoff: browser operation summaries

Implemented in `2605fb1`; deployment is not confirmed. Related [implementation and rollout](../browser-operation-summaries.md).

`browser_exec` now asks the calling LLM for `{summary, code}`. The summary is a
short description of intended work, such as “Find the pricing page and compare
plans.” New executions require a nonempty summary (trimmed, at most 200 characters).
It replaces the generic “Browser operation completed.” on successful results.

## Where to read it

| State | Intent summary | JavaScript |
|---|---|---|
| `agent.tool_call` with `name: "browser_exec"` | `args.summary` | `args.code` |
| Pending tool in agent state | `pending_tool.args.summary` | `pending_tool.args.code` |
| Canonical message from REST or live events | `tool_payload.args.summary` | `tool_payload.args.code` |

Canonical rows still use `tool_payload.tool: "browser_exec"` and
`presentation.kind: "generic"`. No new presentation kind or event is introduced.

Example canonical message excerpt (illustrative; other fields omitted):

```json
{
  "content": "Find the pricing page and compare plans",
  "tool_payload": {
    "tool": "browser_exec",
    "args": {
      "summary": "Find the pricing page and compare plans",
      "code": "var tab = await browser.tabs.current(); console.log((await tab.snapshot()).format());"
    },
    "ok": true,
    "outcome": "completed",
    "summary": "Find the pricing page and compare plans"
  }
}
```

## Rendering and outcome semantics

- For web parity, show a globe plus the intent summary in the collapsed row.
  Expanded details show the tool name, summary, and a JavaScript code block;
  keep full payload inspection available. Treat code as display text, never execute it.
- Intent is model-authored, not evidence that the goal was achieved. Execution
  status comes from `tool_payload.ok`, `outcome`, and `error`, not the wording.
- Successful result `tool_payload.summary` and message `content` contain the intent.
  Rejected/unknown results retain service-written outcome guidance there; preserve
  that guidance in details even when the row title uses `args.summary`.
- Historical rows are not backfilled. Summary/code may be absent, including on
  invalid-argument results. Fall back to the existing result summary or “Browser
  operation”; do not require these fields to decode stored messages.
- `browser_request_handoff` is unchanged and still uses `reason`.

No mobile-generated summary, extra LLM request, database migration, or daemon
upgrade is needed for this change. Adopt with the coordinated service/client
release; no mobile build number has been assigned here.
