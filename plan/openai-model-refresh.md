# Plan: GPT-5.6 and GPT-6 Astra catalog refresh

Status: Implemented locally; rollout verification pending. September 9, 2026.

## Objective

Offer four OpenAI models: GPT-6 Astra and GPT-5.6 Sol, Terra, and Luna. Remove GPT-5.4 (including Mini/Nano) and GPT-5.5 from supported selections. Preserve other providers and historical model attribution.

Related specs: [LLM](../service/src/llm/llm.spec.md), [providers](../service/src/llm/providers/providers.spec.md), [agent](../service/src/agent/agent.spec.md), [routes](../service/src/routes/routes.spec.md).

## Decisions and verified metadata

- Keep `gpt-5.6-luna` as the global default, with its existing reasoning default. Move the obsolete OpenAI provider-default marker off GPT-5.4 onto Luna.
- Add `gpt-6-astra`, displayed as **GPT-6 Astra**, ahead of the GPT-5.6 entries within OpenAI. Use the existing Responses provider and Bud tools.
- Astra supports `low`, `medium`, `high`, `xhigh`, and `max`; it does not support `none`. Proposed Bud default: `medium`. Keep GPT-5.6 reasoning options/defaults unchanged.
- Astra metadata: 1,050,000-token context, 128,000-token maximum output; supports vision, streaming, function calling and structured outputs. Retain Bud's existing 272,000 usable-input cap and 128,000 output reserve policy. The usable cap is a Bud policy, not Astra's hard context limit.

Verified against the [official Astra model page](https://developers.openai.com/api/docs/models/gpt-6-astra) and [model guide](https://developers.openai.com/api/docs/guides/latest-model), September 9, 2026. Live Astra text access with the local service account passed during implementation.

## Implementation

1. Update `service/src/llm/model-catalog.ts`, removing the retired entries and their unused reasoning constant. Check provider registration, model selection, reasoning validation, token budgeting, and environment overrides (`DEFAULT_MODEL`, `OPENAI_MODEL`) for old IDs and dated aliases.
2. Confirm `/api/models` exposes precisely the four OpenAI entries and Astra's supported reasoning levels. Web and mobile should consume the service catalog; inspect cached selections, fallback labels, automation model pickers and test fixtures for hardcoded retired entries. Avoid adding duplicate client catalogs.
3. Audit persisted thread preferences, automation drafts/active revisions, and queued/running invocation model snapshots before rollout. Removing catalog entries alone must not create unexplained automation failures.
4. Update active fixtures and assertions in catalog, models-route, reasoning/provider and model-runner tests. Preserve historical transcripts, provider ledger entries, debug evidence and historical migration documentation.

### Retirement handling to settle during implementation

Recommended minimal behavior: a retired saved chat model requires selection of a supported model, with a clear message; new chats continue to default to Luna. A pinned automation needs a new reviewed revision selecting a supported model. Show an actionable unavailable-model status rather than silently switching unattended work to Astra. Existing historical records retain their original model IDs.

Inventory affected rows first. If none exist, ship without a data migration or legacy aliases. If they do exist, choose explicit replacements before deployment, complete/drain active invocations, and handle queued invocations without rewriting execution history. Do not keep retired models indefinitely in the selectable catalog or silently change an approved automation's model. This is the only expected rollout decision beyond the proposed Astra reasoning default.

## Validation and acceptance

- Catalog/API tests: exactly Astra + Sol/Terra/Luna for OpenAI; Luna remains default; non-OpenAI inventory unchanged.
- Astra accepts every advertised effort and rejects `none`; switching from a GPT-5.6 `none` preference selects a valid Astra effort visibly.
- Provider request tests cover exact model ID, streaming, strict function schemas, tool-result continuation, assistant-phase/reasoning replay and context compaction accounting.
- Smoke test Astra chat, terminal tool call, web retrieval, and an automation approval/continuation with the service account. Account access failures must surface clearly.
- Web/mobile validation: catalog refresh, model/effort switching, old saved preferences, new automation defaults, and historical conversation rendering.
- Run focused service tests and service/web builds; mobile build/tests only if native changes are required.

## Scope and rollout

No new async-tool execution, mid-turn steering, hosted web tools, prompt rewrite or SDK upgrade unless a concrete compatibility failure requires it. No planned schema, SSE or daemon protocol change. Existing owner checks and user-stamping contracts remain unchanged.

Update the LLM/provider specs, affected route/agent specs, and client docs if their behavior changes. A schema change, if discovered necessary, requires the normal Drizzle migration workflow. Deploy service first; clients receive the catalog on refresh. No daemon upgrade expected; both mixed service/daemon pairings use the current tool protocol. Do not claim production readiness until account access and retired-model references have been checked.

## Implementation outcome

- Service catalog and provider routing expose exactly Astra, Sol, Terra and Luna. Luna remains the global/OpenAI default. Astra reasoning and sampling handling use catalog metadata rather than a GPT-5 prefix.
- Retired explicit selections and implicit execution of retired saved chat preferences fail. Read projections remain available and can show the service default; the next explicit supported selection can replace the saved preference. Historical records are untouched.
- Queued retired automation snapshots fail preflight with `invalid_model`, with actionable web/mobile status. Replacement requires a reviewed automation revision. No data migration or automatic retargeting was performed.
- Both client pickers already consume the catalog and normalize unsupported reasoning preferences. Mobile may retain a valid catalog-wide reasoning preference before the model default; all displayed efforts remain supported.
- No daemon contract or schema changes. Old clients show generic Failed for the additive outcome code; updated clients explain recovery. Both daemon/service deployment orders retain existing tools.

## Validation results

Focused catalog, reasoning, provider request/replay/schema, model-runner, context-budget, thread-route and invocation tests passed after updating active fixtures (115 tests). Additional agent/conversation tests passed (24 tests); two database-backed automation suites were skipped because their integration flag was not enabled. Web invocation-state tests and service/web/iOS simulator builds passed. Web build retains its existing bundle-size warning.

Production database inventory succeeded after inbound access was updated; see the audit below. Live Render environment verification, full Bud tool/approval continuation and physical-client picker validation remain open.

Live smoke: Astra text response, forced synthetic function call, encrypted reasoning replay and streamed tool-result continuation passed using the local service OpenAI credential. This does not replace full Bud terminal/web/approval end-to-end validation.

## Production audit — September 9, 2026

Read-only transaction against production, with a statement timeout and aggregate-only output. No database rows were changed.

- Four automation drafts use supported GPT-5.6 models. Three current revision pointers (one enabled, two paused) and all five historical revisions also use GPT-5.6.
- All six automation proposals use GPT-5.6 and are settled; none are pending.
- All 19 invocations use GPT-5.6 and are terminal (16 succeeded, three canceled). No queued/running/waiting invocations require a drain at this snapshot.
- Twelve nondeleted, nonarchived chats retain GPT-5.5 preferences (five none, six low, one medium). Their latest activity is August 26, 2026. No GPT-5.4 chat preferences were found. Preserve these records; existing read projections can show a supported default, while implicit execution of a retired preference rejects until an explicit supported selection is submitted. No bulk preference migration is required for this rollout.
- The imported local `service/.env.production` sets `DEFAULT_MODEL=gpt-5.6-luna` and legacy `OPENAI_MODEL=gpt-5.1-codex`. Config gives DEFAULT_MODEL precedence, so the legacy value is inactive. Remove the obsolete fallback in a future environment cleanup; this audit does not establish Render's live configuration.

The database audit concern is resolved with the documented treatment of older chat preferences. Counts are a point-in-time snapshot, not a lock on subsequent activity.

## Follow-up selection policy

[Automation model inheritance and retirement fallback](automation-model-inheritance-and-fallback.md) scopes the next change: inherited versus explicit selection, retirement fallback to the service default, and web/mobile warnings. Implemented in the working tree, it supersedes this document's retired-model failure policy on deployment. The catalog changes and validation above remain applicable; the follow-up migration is applied locally; coordinated deployment remains pending.
