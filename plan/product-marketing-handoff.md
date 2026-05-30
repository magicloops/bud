# Plan: Product Marketing Handoff

## Context
- Link to issue(s): none
- Related spec files:
  - [bud.spec.md](../bud.spec.md)
  - [bud/bud.spec.md](../bud/bud.spec.md)
  - [bud/src/src.spec.md](../bud/src/src.spec.md)
  - [service/service.spec.md](../service/service.spec.md)
  - [service/src/src.spec.md](../service/src/src.spec.md)
  - [web/web.spec.md](../web/web.spec.md)
  - [web/src/src.spec.md](../web/src/src.spec.md)

## Objective
- Create a product-level overview in `reference/` that a design team can use to build a marketing site for Bud.
- Keep the language accessible to technical users beyond developers while preserving the real product model.

## Design / Approach
- Review the architectural specs for the daemon, service, and web client.
- Summarize Bud around the positioning line: "Bud turns any machine into an agent."
- Describe product surfaces at a high level: machine setup, chat/workbench, live terminal, files, permissions, streaming, continuity, and deployment model.
- Separate customer-facing language from internal implementation details.

## Spec Files to Update
- [x] [bud.spec.md](../bud.spec.md) related-documentation index

## Impacted Contracts
- [ ] WSS protocol
- [ ] SSE events
- [ ] DB schema (`pnpm db:push` + checked-in migration if deployable)
- [ ] Agent tools
- [ ] Web UI

No product contracts are expected to change.

## Test Plan
- Docs review only.
- Verify the new handoff does not claim unsupported product capabilities.

## Rollout
- Add `reference/product-marketing-handoff.md`.
- Hand the document to design/marketing as source material for a marketing site.
