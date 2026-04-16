# Phase 1: Send-Key Chords And Guidance

## Goal

Make `terminal.send` expressive enough to replace `terminal.interrupt` by teaching the stack to send tmux-native modifier chords such as `C-c`.

## Scope

Primary files:

- `bud/src/main.rs`
- `service/src/agent/agent-service.ts`
- `service/src/agent/agent.spec.md`
- related focused tests

## Problem Statement

The current `terminal.send.keys` path supports:

- Enter
- Escape
- arrows
- single characters

but not the tmux-native interrupt chord the system actually needs:

- `C-c`

Without that support, removing `terminal.interrupt` would be premature because the general send tool would still be missing the most important replacement action.

## Required Changes

### 1. Extend Bud key handling for modifier chords

Update the `send_interaction_key(...)` path so it can dispatch tmux-native modifier chords.

Minimum required support:

- `C-c`
- `C-d`

Recommended implementation direction:

- recognize case-insensitive tmux-style `C-<key>` inputs directly
- preserve existing named-key handling (`Enter`, `Escape`, `Up`, etc.)
- optionally normalize a very small alias set such as `ctrl+c` -> `C-c`

Do not broaden this into a giant keyboard-layout abstraction unless implementation proves it is necessary.

### 2. Standardize the documented form

The active prompt/tool guidance should explicitly say:

- use tmux key notation in `keys`
- example: `C-c` for `Ctrl+C`

This should be reflected in:

- the `terminal.send` tool description
- the agent system-prompt guidance

### 3. Add focused coverage

Add or update focused tests around:

- tmux-native chord acceptance
- any alias normalization that ships
- prompt/tool description updates where automated coverage makes sense

## Acceptance Criteria

- `terminal.send.keys` accepts `C-c`
- Bud dispatches `C-c` via tmux `send-keys` without using the dedicated interrupt path
- active prompt/tool docs mention tmux notation and `C-c`
- no agent guidance still implies that `terminal.interrupt` is the preferred way to send `Ctrl+C`

## Out Of Scope For This Phase

- removing the agent `terminal.interrupt` tool
- browser-route cutover
- deleting dedicated interrupt runtime/protocol code
