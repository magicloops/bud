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
| 4.1 | Review all spec files for consistency | ⬜ Pending |
| 4.2 | Consolidate and prioritize TODOs | ⬜ Pending |
| 4.3 | Update this plan with final status | ⬜ Pending |

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

All spec files have been created:
- **Phase 1**: 2 specs (`/bud`)
- **Phase 2**: 12 specs (`/service`)
- **Phase 3**: 14 specs (`/web`)
- **Root**: 1 spec (`/bud.spec.md`)

Ready for **Phase 4: Review & Cleanup** when desired.
