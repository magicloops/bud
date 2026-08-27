# Mobile Team Handoff — platform changes, Aug 18–20 2026

Summary of the stem/terminal, local-LLM, lifecycle, and responsive-web work
as it affects the native app and the contracts it consumes. Wire changes
are all additive; nothing existing broke.

## 1. Models API — new model kinds in the picker

`GET /api/models?bud_id=…` can now return **dynamically synthesized
bud-local models** alongside the static catalog:

- **Ids**: `bud-local:<bud_id>:<served_model_id>` (per-bud namespaced —
  the same served model on two Buds yields two distinct product ids; ids
  can contain further colons, split on the first two only).
- **New field**: `experimental?: boolean` — true for locally served models
  that have not passed agentic tool-call validation. UI guidance (matching
  web): render a badge plus a one-line disclosure ("unvalidated for
  agentic tool use"). Absent/false for all curated models.
- `provider: "bud_local"`, `request_mode: "openai_chat_completions"`,
  `source: { kind: "bud_local", bud_id }` — same `source` shape already
  used by the curated bud-local ds4 entry.
- **Context windows are per-model and dynamic** (probed from the local
  server, e.g. vllm `max_model_len`) — read
  `capabilities.context_window_tokens` / `usable_*` per entry rather than
  assuming family constants.
- The curated `ds4-deepseek-v4-flash` entry is unchanged; versioned server
  ids (e.g. `deepseek-v4-flash-0731`) are handled daemon-side and never
  surface in product ids for the curated family.

## 2. Model selection errors

`424 local_model_unavailable` (thread create, model-preference PATCH,
message send) now also fires when:
- a `bud-local:…` model's embedded bud id differs from the thread's bud
  (cross-bud selection is rejected — treat as "model not available on this
  Bud", do not retry), or
- the owning Bud is offline or no longer serving that model id.

Handle it as a prompt to re-pick a model; the model list for the thread's
bud is the source of truth.

## 3. Device claim & daemon lifecycle (context, mostly FYI)

- The claim flow the app drives (`/api/device-auth/*`, claim deep links)
  is **unchanged**.
- Daemons now install as background services (launchd/systemd) with
  `bud start|stop|restart|status|logs`, self-update via `bud upgrade`
  (checksum-verified, from get.bud.dev stable), and report their release
  tag in `bud --version` (e.g. `bud v0.1.7 (…)`) as of v0.1.7. If the app
  ever displays daemon versions from the bud record, expect `vX.Y.Z`
  strings going forward (older daemons report crate `0.1.0`).
- Supported install targets now include **Linux arm64**.

## 4. Terminal (if/when native adopts the new renderer)

The web now renders terminals from **server-authoritative grid frames**
(`docs/proto.md` §6.8: styled runs, deltas, scroll-hint `row_shift`,
predictive echo, cursor/mouse facts) instead of parsing raw bytes. This is
exactly the contract a native renderer would want — frames are additive
and transport-agnostic, and "mobile adopts later" was an explicit design
assumption. When native terminal work is scheduled, start from
`design/terminal-grid-sync-and-predictive-echo.md` + proto §6.8; the
service side needs nothing new.

One geometry rule to respect (refined 2026-08-21 now that native ships
mobile-only sessions where the phone owns geometry): the invariant is
**never resize the shared PTY under other concurrent viewers** — a
sole-viewer mobile session may own geometry with converge-once
discipline; a session shared with desktop viewers is rendered
observer-style at arrival size (see the grid design doc's 2026-08-20/21
amendments).

## 5. Mobile web is now usable (parity context)

The web app got a responsive shell (`design/responsive-web-layout.md`):
single-pane chat/terminal/web switching below 768px, thread list as a
drawer, one-line autogrowing composer, visual-viewport keyboard handling.
Relevant to the parity story in
`design/web-app-overview-and-ios-feature-parity.md`: mobile *web* is now a
credible fallback for flows the native app doesn't cover yet, and its
decisions (drawer navigation, per-thread view switching, observer-mode
terminal) are reasonable references for native UX where parity is wanted.

## 6. Pointers

- `design/generic-local-llm-support.md` — model-agnostic local LLM design
  + decision records (per-bud ids, reasoning conventions, advertise-all).
- `docs/proto.md` — hello `llm.servers[]` capability shape (additive),
  local-LLM stream frames, grid frames.
- `TODO.md` — open items incl. the tool-call validation harness that will
  graduate models out of `experimental` (the flag's meaning may narrow
  once that ships).
