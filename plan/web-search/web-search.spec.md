# Web search

Shared Bud agent search and page retrieval. Firecrawl implementation is in the
working tree, locally enabled and validated with two cloud providers on
September 8, 2026. Hands-on acceptance and the Bud-hosted backend remain open.

## Files

- [implementation-spec.md](implementation-spec.md): tool contracts, ownership,
  backend boundary, persistence, privacy, and rollout decisions.
- [phases.md](phases.md): ordered implementation and acceptance checklist,
  including the deferred Bud-hosted backend.

- [validation.md](validation.md): executed checks, measurements, local rollout
  and remaining manual acceptance.

## References

- Local design input: `reference/WEB_SEARCH_ARCHITECTURE.md`
- [Agent spec](../../service/src/agent/agent.spec.md)
- [Provider contracts](../../service/src/llm/llm.spec.md)
- [Protocol](../../docs/proto.md)

This plan uses ordinary canonical function tools, independent of the selected
LLM provider. It does not require OpenAI's hosted search or alpha endpoint.
