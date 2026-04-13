# Plan: Portable AGENTS Template

## Context
- Request: review the current repository operating guide and extract a reusable `AGENTS.md` template for other repositories.
- Source workflow docs: [AGENTS.md](../AGENTS.md), [bud.spec.md](../bud.spec.md)

## Objective
- Produce a project/domain/language-agnostic `AGENTS` template that preserves this repo's strongest process rules.
- Keep the distinction between intent documents and current-state documents explicit:
  - `design/`, `plan/`, and `debug/` capture why, what, and investigation before code changes.
  - `*.spec.md` files capture the current shape of the codebase while code changes are made.

## Design / Approach
- Extract the portable workflow from Bud's repo-specific operating rules.
- Remove stack, protocol, architecture, and language assumptions.
- Preserve the design-to-phased-plan workflow used in Bud:
  - `design/<topic>.md` captures the design decision
  - `plan/<topic>/implementation-spec.md` captures the rollout
  - `plan/<topic>/phase-N-*.md` files capture staged execution
- Keep placeholders for:
  - root architecture/spec document
  - repo layout
  - build/test commands
  - code conventions
  - hard contracts and auth/ownership rules
- Add a `design/` template alongside `plan/` and `debug/` so the pre-code intent workflow is complete in one file.

## Spec Files to Update
- [x] [bud.spec.md](../bud.spec.md)

## Impacted Contracts
- [ ] External protocol/API contracts
- [ ] Event/stream contracts
- [ ] Database/storage schema
- [ ] Background job/tooling contracts
- [ ] User-facing UI contracts

## Test Plan
- Review the template for Bud-specific nouns, stack details, or commands that should not travel to other repos.
- Confirm the template preserves the repo's core operating loop:
  1. document intent before implementation
  2. read specs before modifying folders
  3. split larger features into phased implementation plans when needed
  4. update specs alongside code

## Rollout
- Use [AGENTS.template.md](../AGENTS.template.md) as the starting point for new repositories.
- Customize placeholders first, then delete sections that do not apply to the target repository.
