# Phase 6: Agent Tools And Generated UI

## Objective

Give the assistant a product-level way to open, list, and detach web views
without exposing raw proxy-session power. This phase also lays the groundwork
for future agent-created ephemeral web UIs that can appear as message content or
standalone apps.

## Scope

- Add `web_view` agent tools.
- Update agent prompt/tool guidance.
- Wire tool results to thread web-view attachments and client events.
- Add user-visible message affordances for opened web views.
- Define the boundary for future generated UI hosting.

## Non-Goals

- No public sharing by agent.
- No direct raw gateway/session control by agent.
- No automatic arbitrary port scanning.
- No browser observation or screenshot tool unless explicitly added in a later
  design.

## Tool Surface

Recommended first tools:

```ts
web_view.open({
  port: number,
  path?: string,
  title?: string,
  reuse_existing?: boolean
})
```

Behavior:

- Uses the current thread's authorized Bud.
- Creates or reuses a private-owner proxied site.
- Attaches that proxied site as the current thread web view.
- Returns view metadata and a product URL.

```ts
web_view.close({
  proxied_site_id?: string,
  disable?: boolean
})
```

Behavior:

- Detaches the current thread by default.
- Only disables the proxied site when `disable: true` is explicitly supplied.
- Cannot affect sites outside the current thread/Bud ownership boundary.

```ts
web_view.list()
```

Behavior:

- Lists private-owner proxied sites for the current Bud that the thread owner
  can access.
- Includes enabled/offline/expired state and target metadata safe for the user.

## Agent Policy

Prompt guidance should say:

- Use `web_view.open` only when there is evidence a local server is running or
  when the agent has just started one.
- Prefer `reuse_existing: true`.
- Use a human-readable title when it improves the Web view tab.
- Do not make a proxied site public.
- Do not guess or scan broad port ranges.
- If a port is unavailable or the Bud is offline, explain the specific state and
  continue with terminal-based debugging.
- Closing a thread view should detach by default, not destroy durable owner
  resources.

Phase-start decision gate:

- Decide whether durable site creation by an assistant requires explicit user
  confirmation. The implementation can start without confirmation if sites stay
  private-owner, visible in UI, disableable by owner, and cannot be shared by
  the agent.

## Tool Implementation Path

Use product routes and helpers instead of low-level proxy sessions:

1. Resolve current run/thread owner.
2. Resolve authorized thread and Bud.
3. Validate daemon capability and target input.
4. Call the same create/reuse service helper used by REST routes.
5. Attach the resulting proxied site to the thread.
6. Emit lifecycle and attachment events.
7. Return a structured tool result for the assistant and UI.

Tool results should include:

- `proxied_site_id`
- `display_name`
- `target_host`
- `target_port`
- `path`
- `view_url`
- `enabled`
- `bud_connected`
- supported capabilities such as `http`, `request_bodies`, `websocket`

Do not include:

- viewer grants
- proxy viewer cookies
- raw daemon stream IDs
- Bud app auth data

## Message And Web-View Integration

When the agent opens a web view:

- The thread Web view tab should switch to or indicate the opened site.
- The message stream can render a compact attachment or link to the opened
  site.
- The message should not embed a grant-bearing bootstrap URL.
- If embedded message iframes are added later, they must use the same
  `bud.show` private auth bootstrap and fallback behavior as the workbench.

## Future Generated UI Direction

The eventual generated UI system can build on proxied sites in two ways:

- Agent starts a local dev server or static app on the daemon host, then calls
  `web_view.open`.
- Agent emits app files into a workspace and starts a known runner, with the
  proxied site becoming the user-facing surface.

Future additions likely need:

- generated app lifecycle metadata
- stronger cleanup and quotas
- explicit user controls for persistence
- optional static artifact serving
- message-embedded iframe policy
- `web_view.observe` or browser automation only after security review

## Tests

Add tests for:

- `web_view.open` creates/reuses site for current Bud.
- `web_view.open` attaches current thread.
- `web_view.open` rejects invalid ports/paths.
- `web_view.open` rejects disconnected or unsupported Bud with structured
  result.
- `web_view.close` detaches without disabling by default.
- `web_view.close` disables only with explicit flag and ownership.
- `web_view.list` filters by current Bud/owner.
- Tool results do not expose viewer grants/cookies.
- Client receives attachment events after tool execution.

## Spec Files To Update During Implementation

- `service/src/agent/agent.spec.md`
- relevant runtime/thread specs for tool execution and events
- `docs/proto.md` if tool result events or SSE payloads change
- web specs for message/web-view rendering changes

## Acceptance Criteria

- Assistant can open a running local web server into the thread Web view tab.
- Assistant can list existing proxied sites for the current Bud.
- Assistant can detach the current thread web view without destroying the site.
- Agent tools use product authorization and never expose raw proxy authority.
- UI and message surfaces react to tool-created attachments.
