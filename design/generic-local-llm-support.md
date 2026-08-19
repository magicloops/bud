# Design: Generic Local LLM Support (beyond ds4)

> Scoping document for letting a Bud advertise and serve *any*
> OpenAI-compatible local model — not just DeepSeek v4 — while keeping the
> agent honest about which models are actually validated for agentic use.

**Related Docs**:
- [local-ds4-llm-over-bud.md](./local-ds4-llm-over-bud.md) — the ds4-specific
  foundation this generalizes
- [managed-daemon-lifecycle.md](./managed-daemon-lifecycle.md) — `bud llm`
  verb surface this extends

---

## 1. Executive Summary

The local-LLM pipeline is ds4-shaped end to end: the daemon probes for the
`deepseek-v4-flash` family, the service has exactly one bud-local catalog
entry, and requests are built in the `ds4_openai_responses` mode. Users
running any other local model (llama, Qwen, Kimi, …) get an honest
"serves no DeepSeek v4 model" refusal from `bud llm enable`.

The plumbing shipped with the ds4 verbs is already ~90% model-agnostic —
probe `/v1/models`, pick a served id, persist a URL, translate ids at the
edge. What is *not* generic is everything that makes the agent work well:
catalog capabilities, request shape, and tool-calling quality.

### Recommendation

Generalize in four phases, keeping the ds4 path byte-compatible throughout.
The gate for each model is not "does it answer HTTP" but "can the agent
loop trust it" — unvalidated models surface as **experimental**, validated
families graduate into curated defaults.

## 2. Current Coupling Inventory

| Layer | ds4-specific piece | Generic already |
|---|---|---|
| daemon probe | family filter `deepseek-v4-flash(-*)` | `/v1/models` fetch, served-id capture, edge id rewrite |
| daemon capability | one hardcoded `servers[0]` (`id:"ds4"`, `request_mode:"ds4_openai_responses"`, canonical model entry) | `llm.servers[].models[]` schema is additive by design |
| daemon config | `BUD_LOCAL_LLM_DS4_URL` + ds4 token limits | env-file upsert machinery (`bud llm enable`) |
| service | `getHealthyBudLocalDs4Server` matches `id==="ds4"` + request mode + `/v1/responses`; single catalog entry `ds4-deepseek-v4-flash`; `providerModel` constant | models route already merges bud-local models per bud; picker handles `source.kind:"bud_local"` |
| request path | OpenAI **Responses** API only (`/v1/responses`, validated in the daemon's open-frame path check) | body streaming, header sanitization, backpressure |
| agent | reasoning/prompt policy from the catalog entry | — |

## 3. Design

### 3.1 Wire contract (additive)

The daemon advertises what the server actually serves instead of one
canonical entry:

```json
"llm": {
  "local_api": true,
  "servers": [{
    "id": "local",                     // "ds4" retained for the ds4 family
    "provider": "bud_local",
    "compatibility": ["openai_chat_completions", "openai_responses"],
    "request_mode": "openai_chat_completions",
    "generation_path": "/v1/chat/completions",
    "models": [
      { "id": "llama-3.3-70b-instruct", "display_name": "llama-3.3-70b-instruct",
        "context_window_tokens": 131072, "max_model_len_source": "probe",
        "validated": false }
    ],
    "concurrency": 1,
    "healthy": true
  }]
}
```

- `validated` marks families with curated catalog overrides (ds4 today).
- `context_window_tokens` comes from the probe when the server reports it
  (vllm's `max_model_len`), else omitted.
- The existing ds4 server entry is emitted UNCHANGED when the ds4 family is
  detected — older services keep working with zero changes.

### 3.2 Daemon

- Config: `BUD_LOCAL_LLM_URL` + optional `BUD_LOCAL_LLM_MODEL` (generic),
  with `BUD_LOCAL_LLM_DS4_URL` honored forever as the ds4-family alias.
- `bud llm probe` lists every served model (already true) and stops
  filtering to the ds4 family for *reporting* — the family only decides
  which capability shape is advertised.
- `bud llm enable <url>` stores the URL only — no `--model`: the daemon
  advertises **all** served models and selection happens per thread in the
  web picker (decided 2026-08-20). One enable serves however many models
  the server loads.
- Request forwarding generalizes the path allowlist to the advertised
  `generation_path` (`/v1/responses` | `/v1/chat/completions`). With all
  models advertised, the service sends the served id directly, so the edge
  model-id rewrite shrinks to the ds4 canonical-id compatibility case.

### 3.3 Service

- **Catalog template**: unknown bud-local models synthesize an entry
  **`bud-local:<bud_id>:<served-id>`** (decided 2026-08-20: per-bud
  namespace, so two Buds on one account — even one machine — serving
  different models never collide, and a persisted thread-model selection
  is unambiguous). Conservative defaults — tools *assumed* (the agent
  requires them), streaming on, structured outputs off, one reasoning
  level ("default"). Template entries are flagged `experimental: true`.
- **Context is dynamic per model** (decided 2026-08-20): the input window
  comes from the probe (`max_model_len` on vllm and friends) advertised in
  the capability per model; the service's context policy derives usable
  input/reserved output from it exactly as for catalog models. A
  conservative fallback applies only when the server reports nothing.
- **Family overrides**: a small registry keyed by served-id prefix
  (ds4 today; future validated families) supplies curated capabilities and
  reasoning policy. ds4 keeps its existing catalog entry and product id.
- **Request modes**: add `openai_chat_completions` alongside
  `ds4_openai_responses` — adapter translating the agent's message/tool
  state to the chat-completions shape (tool calls, streaming deltas).
  Mode chosen from the server's advertised `request_mode`.
- **Reasoning normalization** (decided 2026-08-20: follow the settled
  industry conventions): the adapter maps the structured
  `reasoning_content` delta/message field (DeepSeek API convention,
  emitted by vllm/SGLang) — and the `reasoning` field used by
  OpenRouter-compatible servers — into the agent's reasoning stream,
  keeping `content` clean. Fallback normalization: inline
  `<think>…</think>` blocks (emitted by R1/Qwen-style models when the
  server does not split them) are extracted into reasoning rather than
  rendered as answer text.
- **Reasoning replay is turn-scoped** (refined 2026-08-20 for vllm
  prefix-cache economics): the current turn's reasoning IS replayed
  through that turn's tool loop — dropping it would invalidate the KV
  cache exactly at the freshly generated tokens (often the longest part
  of an agentic step) and diverge from what tool-capable reasoning
  templates render for the in-flight turn. Once a turn completes, its
  reasoning is dropped: chat templates for the DeepSeek/Qwen families
  strip prior-turn thinking on re-render (the models are trained without
  it), and identical re-rendering is what keeps the long conversation
  prefix cache-hot — cross-turn replay would only add context bloat.
  This matches the hosted-provider shape (Anthropic preserves thinking
  within the tool-use turn; OpenAI Responses replays reasoning items
  within a turn).
- `getHealthyBudLocalDs4Server` generalizes to `getHealthyBudLocalServers`
  with the ds4 matcher preserved as a compatibility case.

### 3.4 Product surface

- Model picker: every advertised model appears (per-thread choice is the
  selection mechanism); experimental models render with an "experimental"
  badge and a one-line disclosure ("unvalidated for agentic tool use").
- `bud status` llm line already prints the served id; add `(experimental)`
  when the family is unvalidated.
- Installer probe stays family-agnostic in *detection* but only
  auto-offers enabling for validated families; for others it prints
  `bud llm enable <url> --model <id>` as a suggestion instead of prompting
  (avoids teeing users into a bad agent experience from the installer).

### 3.5 Validation gate (what "validated" means)

A family graduates from experimental when:
1. a tool-call smoke passes (scripted: one forced tool call + one
   multi-turn tool loop through the real adapter);
2. context accounting is verified against the server's real limits;
3. someone has dogfooded an agent session on it.

Optional later: `bud llm enable` runs the tool-call smoke inline and
reports the result (nice UX, not required for phase 1).

## 4. Phases

> **Status (2026-08-20)**: phases 1-3 implemented on this branch — daemon
> advertise-all capability + generic env keys + `--require-validated`
> probe, service dynamic catalog + `bud_local` chat-completions provider +
> per-bud product ids + cross-bud 424 guard, web experimental marker,
> installer validated-only auto-offer. Phase 4 (tool-call smoke harness)
> remains open; until it exists every generic model is experimental.

1. **Wire + daemon**: advertise served models with `validated` flags,
   generic env keys (+ ds4 alias), `--model` selection, generation-path
   generalization. Ships alone — service ignores unknown servers today.
2. **Service**: catalog template + family-override registry +
   chat-completions request mode; models route exposes experimental models.
3. **Product**: picker badge, status annotation, installer suggestion
   behavior.
4. **Validation tooling**: tool-call smoke harness; graduate families as
   they pass (each graduation is a small override-registry PR).

## 5. Non-Goals

- Native non-OpenAI protocols (ollama's `/api/*`): OpenAI-compat only;
  ollama exposes one at `/v1` anyway.
- Multiple simultaneous local servers per Bud (schema supports it; product
  scope stays one).
- Silent auto-enable of anything, validated or not.
- Provider keys/remote endpoints through this path — this is for
  loopback/LAN local inference only.

## 6. Decision Record (2026-08-20)

The original open questions were resolved:

1. **Product model ids are per-bud namespaced**: `bud-local:<bud_id>:<served-id>`.
   Two Buds under one account (even on one machine) serving different models
   never collide, and persisted per-thread selections stay unambiguous.
2. **Reasoning is normalized to the industry conventions**: structured
   `reasoning_content` (DeepSeek/vllm/SGLang) and `reasoning` (OpenRouter
   style) map into the agent's reasoning stream; inline `<think>` blocks are
   extracted as a fallback. Replay is turn-scoped: current-turn reasoning is
   replayed through its tool loop (KV-cache continuity on vllm + template
   expectations); completed turns drop it (templates strip it anyway, and
   identical re-rendering keeps the conversation prefix cache-hot).
3. **The daemon advertises all served models; the web picker chooses per
   thread.** `bud llm enable <url>` takes no model argument.
4. **Context windows are dynamic per model** from the probe's
   `max_model_len`-class metadata, flowing through the existing context
   policy; a conservative fallback applies only when the server reports
   nothing.

## 7. Remaining Open Questions

- Fallback context default when the server reports no length metadata
  (probe coverage varies outside vllm) — proposal: 8k with the experimental
  badge calling it out.
- Whether the tool-call smoke (§3.5) should gate picker visibility or only
  the badge.
