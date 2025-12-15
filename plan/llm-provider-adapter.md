# Plan: LLM Provider Adapter Implementation

> Multi-phase plan to add provider abstraction layer enabling OpenAI and Anthropic model support.

**Status**: Active
**Created**: 2025-12-14
**Design Doc**: [design/llm-provider-adapter-implementation.md](../design/llm-provider-adapter-implementation.md)

---

## Context

- **Issue**: Bud's AgentService is tightly coupled to OpenAI's Responses API
- **Goal**: Enable multi-provider support (OpenAI + Anthropic) with model-agnostic threads
- **Constraint**: Must not break existing functionality during refactor

### Related Spec Files

| Spec File | Relevance |
|-----------|-----------|
| `service/src/agent/agent.spec.md` | Core agent logic being refactored |
| `service/src/src.spec.md` | New `llm/` folder will be added |
| `service/service.spec.md` | High-level service architecture |
| `docs/proto.md` | New SSE events for reasoning |

---

## Objective

1. **Extract** LLM-specific logic from AgentService into a provider abstraction layer
2. **Maintain** full functionality with OpenAI throughout the refactor
3. **Add** Anthropic provider support with feature parity
4. **Enable** per-request model selection and mid-thread provider switching
5. **Support** reasoning/thinking features for both providers

### Success Criteria

- [ ] All existing OpenAI functionality works after refactor
- [ ] Can invoke Claude models with tool calling
- [ ] Can switch models mid-thread without data loss
- [ ] Reasoning summaries stream to UI for both providers
- [ ] Multi-turn tool loops preserve reasoning context

---

## Phase Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Core Types & Interface                                             │
│ - Define canonical types (messages, tools, events)                          │
│ - Define LLMProvider interface                                              │
│ - Create ProviderRegistry                                                   │
│ - NO behavior changes - types only                                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 2: OpenAI Provider Extraction                                         │
│ - Implement OpenAIProvider class                                            │
│ - Extract transformation logic from AgentService                            │
│ - Update AgentService to use provider registry                              │
│ - VALIDATION: App works exactly as before                                   │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 3: OpenAI Reasoning Support                                           │
│ - Add reasoning types to canonical format                                   │
│ - Update OpenAI provider for o1/o3/o4 models                                │
│ - Add reasoning streaming events                                            │
│ - Update AgentService for reasoning blocks                                  │
│ - VALIDATION: Reasoning models work with new abstraction                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 4: Anthropic Provider                                                 │
│ - Implement AnthropicProvider class                                         │
│ - Handle Anthropic message/tool formats                                     │
│ - Add extended thinking support                                             │
│ - VALIDATION: Can use Claude models with tool calling                       │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Phase 5: API & Configuration                                                │
│ - Add per-request model selection to API                                    │
│ - Add /api/models endpoint                                                  │
│ - Update web UI for model selection                                         │
│ - VALIDATION: Users can select models in UI                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase Documents

| Phase | Document | Focus |
|-------|----------|-------|
| 1 | [phase-1-core-types.md](./llm-provider-adapter/phase-1-core-types.md) | Type definitions, no behavior change |
| 2 | [phase-2-openai-extraction.md](./llm-provider-adapter/phase-2-openai-extraction.md) | Extract OpenAI logic, maintain parity |
| 3 | [phase-3-openai-reasoning.md](./llm-provider-adapter/phase-3-openai-reasoning.md) | Add reasoning support for OpenAI |
| 4 | [phase-4-anthropic-provider.md](./llm-provider-adapter/phase-4-anthropic-provider.md) | Add Anthropic/Claude support |
| 5 | [phase-5-api-configuration.md](./llm-provider-adapter/phase-5-api-configuration.md) | API endpoints and UI integration |

---

## Risk Analysis

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Breaking existing OpenAI flow | Medium | High | Phase 2 maintains exact behavior, extensive testing |
| Streaming event mismatch | Medium | Medium | Unit tests for event transformation |
| Multi-turn reasoning data loss | Medium | High | Preserve providerData through full loop |
| Performance regression | Low | Medium | Benchmark before/after Phase 2 |
| Type errors during refactor | High | Low | TypeScript strict mode catches issues |

---

## Spec Files to Update

### Phase 1
- [ ] `service/src/src.spec.md` - Add `llm/` folder reference

### Phase 2
- [ ] `service/src/agent/agent.spec.md` - Document provider usage
- [ ] Create `service/src/llm/llm.spec.md` - New folder spec

### Phase 3
- [ ] `service/src/llm/llm.spec.md` - Add reasoning types
- [ ] `docs/proto.md` - Add reasoning SSE events

### Phase 4
- [ ] `service/src/llm/llm.spec.md` - Add Anthropic provider

### Phase 5
- [ ] `service/src/routes/routes.spec.md` - Add /api/models endpoint
- [ ] `web/src/src.spec.md` - Model selector component

---

## Dependencies

### External Packages

```json
{
  "openai": "^4.x",           // Already installed
  "@anthropic-ai/sdk": "^0.x" // Add in Phase 4
}
```

### Environment Variables

```bash
# Existing
OPENAI_API_KEY=sk-...

# New (Phase 4)
ANTHROPIC_API_KEY=sk-ant-...

# New (Phase 5)
DEFAULT_MODEL=gpt-4o
```

---

## Rollback Strategy

Each phase is designed to be independently rollbackable:

1. **Phase 1**: Delete `llm/` folder - no behavior impact
2. **Phase 2**: Revert AgentService changes, delete provider classes
3. **Phase 3**: Revert reasoning additions, works without reasoning
4. **Phase 4**: Don't register Anthropic provider - falls back to OpenAI
5. **Phase 5**: Revert API/UI changes - uses default model

---

## Definition of Done

- [ ] All phases completed and validated
- [ ] All spec files updated
- [ ] Unit tests for each provider
- [ ] Integration tests for multi-turn flows
- [ ] SSE events documented in proto.md
- [ ] README updated with multi-provider configuration
- [ ] No regression in existing functionality

---

## Progress Tracking

| Phase | Status | Started | Completed | Notes |
|-------|--------|---------|-----------|-------|
| 1 | Not Started | - | - | - |
| 2 | Not Started | - | - | - |
| 3 | Not Started | - | - | - |
| 4 | Not Started | - | - | - |
| 5 | Not Started | - | - | - |

---

*Last Updated: 2025-12-14*
