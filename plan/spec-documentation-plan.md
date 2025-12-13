# Spec Documentation Plan

This document outlines the systematic approach for adding spec documentation (`folder-name.spec.md`) files throughout the `/service`, `/bud`, and `/web` project directories.

## Approach

We will document from **leaf nodes up** to ensure that parent spec files can reference child spec summaries. Each spec file should:

1. Summarize the folder's purpose
2. List and describe each file in the folder
3. Reference any child folder spec files
4. Note any TODOs, technical debt, or areas needing attention

**Naming convention**: `folder-name.spec.md` (e.g., `agent.spec.md` for `/service/src/agent/`)

**Skip folders that only contain other folders** (no direct files).

---

## Markers for Phase 4 Review

When writing spec files, use these markers for items that need revisiting:

| Marker | Usage |
|--------|-------|
| `<!-- SPEC:UNKNOWN -->` | Reference to code/module we haven't documented yet |
| `<!-- SPEC:TODO -->` | Something that needs further investigation or clarification |
| `<!-- SPEC:VERIFY -->` | Assumption that should be verified once more context is available |

### Finding Markers

Run this command from the repo root to find all markers:

```bash
grep -rn "SPEC:\(UNKNOWN\|TODO\|VERIFY\)" --include="*.spec.md" bud service web
```

Or count by type:

```bash
grep -roh "SPEC:\(UNKNOWN\|TODO\|VERIFY\)" --include="*.spec.md" bud service web | sort | uniq -c
```

---

## Project Structure Overview

```
bud/
├── bud/                    # Rust daemon (bud CLI)
│   └── src/               # Single main.rs file
├── service/               # Node.js backend service
│   ├── drizzle/          # Database migrations
│   │   └── migrations/   # SQL migration files
│   ├── scripts/          # Standalone utility scripts
│   └── src/              # Main source code
│       ├── agent/        # Agent service (LLM integration)
│       ├── db/           # Database layer
│       ├── routes/       # HTTP API routes
│       ├── runtime/      # Runtime managers
│       ├── scripts/      # DB utility scripts
│       ├── terminal/     # Terminal utilities
│       └── ws/           # WebSocket gateways
└── web/                   # React frontend
    ├── public/           # Static assets
    └── src/              # Main source code
        ├── assets/       # Images, fonts, etc.
        ├── components/   # React components
        │   ├── message-renderers/
        │   │   ├── roles/    # Role-based renderers
        │   │   └── tools/    # Tool renderers
        │   ├── ui/           # Base UI components
        │   └── workbench/    # Main app components
        ├── contexts/     # React contexts
        ├── lib/          # Utilities and helpers
        └── routes/       # TanStack Router routes
            └── $budId/   # Nested routes
```

---

## Phase 1: `/bud` (Rust Daemon)

Simple project with single source file.

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 1.1 | `/bud/src/` | `src.spec.md` | ✅ Complete |
| 1.2 | `/bud/` | `bud.spec.md` | ✅ Complete |

---

## Phase 2: `/service` (Node.js Backend)

Work from deepest folders up.

### 2a. Leaf folders (src subfolders)

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 2.1 | `/service/src/agent/` | `agent.spec.md` | ✅ Complete |
| 2.2 | `/service/src/db/` | `db.spec.md` | ✅ Complete |
| 2.3 | `/service/src/routes/` | `routes.spec.md` | ✅ Complete |
| 2.4 | `/service/src/runtime/` | `runtime.spec.md` | ✅ Complete |
| 2.5 | `/service/src/scripts/` | `scripts.spec.md` | ✅ Complete |
| 2.6 | `/service/src/terminal/` | `terminal.spec.md` | ✅ Complete |
| 2.7 | `/service/src/ws/` | `ws.spec.md` | ✅ Complete |

### 2b. Parent folders

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 2.8 | `/service/src/` | `src.spec.md` | ✅ Complete |
| 2.9 | `/service/drizzle/migrations/` | `migrations.spec.md` | ✅ Complete |
| 2.10 | `/service/drizzle/` | `drizzle.spec.md` | ✅ Complete |
| 2.11 | `/service/scripts/` | `scripts.spec.md` | ✅ Complete |
| 2.12 | `/service/` | `service.spec.md` | ✅ Complete |

---

## Phase 3: `/web` (React Frontend)

Work from deepest folders up.

### 3a. Deepest leaf folders

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 3.1 | `/web/src/components/message-renderers/roles/` | `roles.spec.md` | ✅ Complete |
| 3.2 | `/web/src/components/message-renderers/tools/` | `tools.spec.md` | ✅ Complete |
| 3.3 | `/web/src/components/ui/` | `ui.spec.md` | ✅ Complete |
| 3.4 | `/web/src/components/workbench/` | `workbench.spec.md` | ✅ Complete |
| 3.5 | `/web/src/routes/$budId/` | `budId.spec.md` | ✅ Complete |

### 3b. Mid-level folders

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 3.6 | `/web/src/components/message-renderers/` | `message-renderers.spec.md` | ✅ Complete |
| 3.7 | `/web/src/components/` | `components.spec.md` | ✅ Complete |
| 3.8 | `/web/src/contexts/` | `contexts.spec.md` | ✅ Complete |
| 3.9 | `/web/src/lib/` | `lib.spec.md` | ✅ Complete |
| 3.10 | `/web/src/routes/` | `routes.spec.md` | ✅ Complete |
| 3.11 | `/web/src/assets/` | `assets.spec.md` | ✅ Complete |

### 3c. Parent folders

| Order | Path | Spec File | Status |
|-------|------|-----------|--------|
| 3.12 | `/web/src/` | `src.spec.md` | ✅ Complete |
| 3.13 | `/web/public/` | `public.spec.md` | ✅ Complete |
| 3.14 | `/web/` | `web.spec.md` | ✅ Complete

---

## Phase 4: Review & Cleanup

After all spec files are written:

| Order | Task | Status |
|-------|------|--------|
| 4.1 | Review all spec files for consistency | ✅ Complete |
| 4.2 | Consolidate and prioritize TODOs | ✅ Complete |
| 4.3 | Update this plan with final status | ✅ Complete |

### 4.1 Consistency Review

All 29 spec files verified:
- ✅ Consistent header format (`# folder-name`)
- ✅ Parent/child references present (except root `bud.spec.md`)
- ✅ Standard sections: Purpose, Files, Dependencies
- ✅ Markdown tables for structured data

### 4.2 Consolidated TODOs

Found **9 files** with `SPEC:TODO` markers. Organized by priority:

#### High Priority - Legacy Code Cleanup

| Location | Issue |
|----------|-------|
| `service/src/runtime/runtime.spec.md` | `SessionManager` (legacy PTY) may be redundant with `TerminalSessionManager` |
| `service/src/ws/ws.spec.md` | `term-gateway.ts` is for legacy PTY sessions; deprecate once thread-scoped stable |
| `service/src/agent/agent.spec.md` | Legacy `shell.run` path still exists but appears unused |
| `bud/src/src.spec.md` | Legacy `SessionManager` (non-tmux PTY) may be redundant |
| `web/src/components/workbench/workbench.spec.md` | `run-view.tsx` may be deprecated in favor of terminal view |

#### Medium Priority - Code Quality

| Location | Issue |
|----------|-------|
| `bud/src/src.spec.md` | Single-file architecture (~2900 lines); consider splitting into modules |
| `bud/src/src.spec.md` | `#[allow(dead_code)]` on several struct fields suggests unused protocol features |
| `bud/src/src.spec.md` | Environment passthrough for `terminal_ensure` noted as "not yet implemented" |
| `service/src/agent/agent.spec.md` | Type assertions could be improved with proper OpenAI response types |
| `service/src/ws/ws.spec.md` | No rate limiting on WebSocket messages |
| `service/src/ws/ws.spec.md` | Dev token bypass should be removed for production |

#### Low Priority - Known Limitations

| Location | Issue |
|----------|-------|
| `bud/bud.spec.md` | Reconnection can leave orphaned tmux sessions if daemon crashes |
| `bud/bud.spec.md` | No graceful shutdown handling for terminal sessions |
| `bud/bud.spec.md` | Identity file permissions not verified on load |

#### Future Features

| Location | Feature |
|----------|---------|
| `bud.spec.md` | Multi-tenant support (schema ready, not implemented) |
| `bud.spec.md` | User authentication (columns exist but unused) |
| `bud.spec.md` | File transfer capabilities |
| `bud.spec.md` | Multiple terminal windows per thread |
| `bud.spec.md` | Session sharing/collaboration |
| `service/src/db/db.spec.md` | Multi-tenant isolation not implemented |
| `web/src/components/message-renderers/tools/tools.spec.md` | Additional tool renderers (capture, interrupt, file ops) |

---

## Spec File Template

```markdown
# folder-name

Brief description of this folder's purpose.

## Files

### `filename.ts`
Description of what this file does, key exports, and dependencies.

### `another-file.ts`
Description...

## Subfolders

### `subfolder/` → [subfolder.spec.md](./subfolder/subfolder.spec.md)
Brief summary of the subfolder's purpose.

## Dependencies

- External packages used
- Internal modules referenced

## TODOs / Technical Debt

- [ ] Any identified issues or improvements
```

---

## Progress Tracking

- **Total spec files**: 28 (+ 1 root spec)
- **Completed**: 29 (root + Phase 1 + Phase 2 + Phase 3)
- **Remaining**: 0 (Phase 4 review pending)

### Root Spec

| Path | Spec File | Status |
|------|-----------|--------|
| `/` | `bud.spec.md` | ✅ Complete |

Last updated: 2025-12-12

---

## Summary

All phases complete:

| Phase | Scope | Specs | Status |
|-------|-------|-------|--------|
| 1 | `/bud` (Rust Daemon) | 2 | ✅ Complete |
| 2 | `/service` (Node.js Backend) | 12 | ✅ Complete |
| 3 | `/web` (React Frontend) | 14 | ✅ Complete |
| 4 | Review & Cleanup | - | ✅ Complete |
| Root | Project overview | 1 | ✅ Complete |

**Total**: 29 spec files

### Key Findings from Review

1. **Legacy code identified**: Multiple components (SessionManager, term-gateway, shell.run, run-view) are candidates for deprecation once thread-scoped terminals are stable.

2. **Architecture debt**: The Rust daemon's single-file design (~2900 lines) should be modularized.

3. **Security items**: Dev token bypass and missing rate limiting should be addressed before production.

4. **Schema readiness**: Multi-tenant and user auth columns exist but are not yet implemented.

### Next Steps

1. Prioritize legacy code cleanup after thread-scoped sessions are validated
2. Address security items before production deployment
3. Consider Rust daemon modularization in next refactor cycle
