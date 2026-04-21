# Phase 3: Workspace Shell Deduplication And Bud Layout Cleanup

## Objective

Remove the intentional duplication between the new-thread and existing-thread workspaces, and narrow the Bud-layout route so it owns Bud-scoped state rather than a growing mix of UI and data orchestration.

## Scope

### In scope

- extract a shared workspace shell/layout used by both `/$budId/new` and `/$budId/$threadId`
- extract shared model-loading and composer wiring
- reduce `/$budId.tsx` ownership to Bud-scoped state and composition
- move modal and thread-list helper logic to more appropriate modules where needed

### Out of scope

- deep thread runtime decomposition
- transcript/terminal reconnect logic changes
- render-path optimization

## Proposed Work

### 1. Build a shared workspace shell

The current routes share:

- top bar
- view mode
- terminal pane placement
- composer placement
- debug panel positioning

Extract these into shared primitives so route-specific behavior is passed in explicitly rather than duplicated through comments.

### 2. Share model-loading/default-selection behavior

Model loading currently exists in both routes. Replace that with one shared ownership unit, such as:

- `useAvailableModels()`

This unit should own:

- fetch
- alias filtering
- server-default selection
- current selection preservation

### 3. Narrow `/$budId.tsx`

The Bud route should primarily own:

- Bud selection/navigation
- Bud theming
- Bud-scoped thread summary store
- sessions modal state

It should not keep accumulating unrelated workspace behavior.

As part of this phase, consider whether thread-summary mutation logic should move into a dedicated Bud-route store module instead of staying inline in the route component.

### 4. Standardize Bud-scoped supporting UI ownership

Candidates to review here:

- `BudSessionsModal`
- `ThreadPanel`
- Bud palette/theming helpers

If these stay where they are, the ownership boundary should at least be made explicit in the code and docs.

## Expected File Areas

- `web/src/routes/$budId.tsx`
- `web/src/routes/$budId/new.tsx`
- `web/src/routes/$budId/$threadId.tsx`
- `web/src/components/workbench/`
- `web/src/components/bud-sessions-modal.tsx`
- `web/src/contexts/bud-route-context.tsx`
- any new workspace or Bud feature modules

## Testing Strategy

### Automated

- shared model-loading hook coverage
- Bud-route store/update behavior coverage
- route/component tests proving the new and existing thread pages both compose the shared workspace shell correctly

### Manual

- switch between `/$budId/new` and `/$budId/$threadId` and confirm layout parity
- verify Bud selection, thread selection, sessions modal, and settings navigation still behave correctly

## Exit Criteria

- the new-thread and existing-thread routes no longer rely on comment-based synchronization
- shared workspace and model-loading behavior live in reusable modules
- `/$budId.tsx` is materially smaller and Bud-scoped in responsibility
- Bud-route state ownership is clearer and easier to test
