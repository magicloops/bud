# Validation Checklist: Fortify LLM Call Handling

Manual validation pending. Automated validation completed for the implemented service/web surfaces.

## Automated Verification

- [x] `pnpm --dir /Users/adam/bud/service exec node --import tsx --test src/llm/providers/providers.test.ts src/llm/provider-ledger.test.ts src/agent/model-runner.test.ts src/agent/conversation-loader.test.ts src/agent/transcript-writer.test.ts`
- [x] `pnpm --dir /Users/adam/bud/service build`
- [x] `pnpm --dir /Users/adam/bud/web test`
- [x] `pnpm --dir /Users/adam/bud/web build`

## Provider Adapter Fixtures

- [x] OpenAI fixture with reasoning then text then function call preserves order
- [x] OpenAI fixture with text before function call preserves text
- [x] OpenAI fixture with multiple function calls emits every tool call
- [x] OpenAI fixture with text/function/text ordering reconstructs exactly
- [ ] Anthropic fixture with thinking signature preserves complete block
- [x] Anthropic fixture with redacted thinking preserves complete block
- [ ] Anthropic fixture with text and tool-use blocks preserves provider order
- [x] Anthropic no-tool tool choice lowers to an actual no-tool request

## Provider Ledger

- [x] Every provider invocation creates one `llm_call` row
- [x] Every provider input/output item creates ordered `llm_call_item` rows
- [x] Reasoning rows are marked provider-only
- [x] Redacted reasoning rows are marked provider-only
- [x] Visible text rows can link to product `message` rows
- [x] Tool calls and tool results retain matching provider call IDs
- [x] Browser-facing transcript routes do not expose provider payloads

## Agent Loop

- [x] Text in a tool-call response is not dropped
- [x] Text between tool calls is not dropped
- [ ] Reasoning continuity survives service restart for new calls
- [x] Multiple tool calls are parsed and handled deterministically
- [x] Terminal tool calls execute serially in provider output order
- [x] Provider-native reconstruction uses durable provider payloads for same-provider calls
- [ ] Provider-switch reconstruction uses canonical fallback and logs degradation

## Product Transcript

- [ ] Live streamed text before a tool call appears in the timeline
- [ ] The same text remains after refresh
- [ ] Live streamed text between tool calls appears in the timeline
- [ ] The same intermediate text remains after refresh
- [x] Tool calls no longer delete visible assistant drafts
- [x] Persisted intermediate assistant rows have stable `client_id`
- [x] Reasoning is not shown in the web UI

## Cache Observability

- [x] OpenAI cached-token usage is recorded when returned
- [x] OpenAI reconstruction mode is recorded per call
- [ ] OpenAI prompt cache key policy is documented
- [x] Anthropic cache-control strategy is documented
- [ ] Provider switches are distinguishable from cache/reconstruction bugs

## Migration And Docs

- [x] `pnpm --dir /Users/adam/bud/service db:push` completed locally
- [x] `pnpm --dir /Users/adam/bud/service db:generate` generated checked-in migration files
- [x] Migration SQL was reviewed
- [x] `service/src/db/db.spec.md` updated
- [x] `service/drizzle/migrations/migrations.spec.md` updated
- [x] `docs/proto.md` updated
- [x] Service specs updated
- [x] Web specs updated
- [x] `bud.spec.md` updated
