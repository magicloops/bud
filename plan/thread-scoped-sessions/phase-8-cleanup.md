# Phase 8: Cleanup & Migration

_Status: Not Started_

## Overview

Remove legacy code and complete the migration to thread-scoped terminal sessions.

---

## Tasks

### 1. Remove Legacy Terminal Routes

**File:** `service/src/routes/terminals.ts`

Delete the entire file and remove registration from server setup:

```typescript
// Remove from server setup:
import { registerTerminalRoutes } from "./routes/terminals.js";
// ...
await registerTerminalRoutes(server, terminalManager);
```

Legacy endpoints being removed:
- `POST /api/terminals/:budId/ensure`
- `GET /api/terminals/:budId`
- `GET /api/terminals/:budId/history`
- `POST /api/terminals/:budId/input`
- `POST /api/terminals/:budId/interrupt`
- `POST /api/terminals/:budId/resize`
- `GET /api/terminals/:budId/metrics`
- `GET /api/terminals/metrics`

### 2. Remove Legacy TerminalManager

**File:** `service/src/runtime/terminal-manager.ts`

Delete after confirming all usages migrated to `TerminalSessionManager`.

### 3. Remove Legacy Database Tables

**Migration:** Create `0007_remove_legacy_terminal.sql`

```sql
-- Remove legacy terminal tables (replaced by terminal_session tables)
DROP TABLE IF EXISTS "terminal_input_log" CASCADE;
DROP TABLE IF EXISTS "terminal_output" CASCADE;
DROP TABLE IF EXISTS "bud_terminal" CASCADE;
```

Note: The Phase 1 migration already drops these tables, so this may not be needed.

### 4. Remove Legacy SSE Stream Route

**File:** `service/src/routes/buds.ts` (if exists)

Remove any bud-based terminal stream endpoint:
- `GET /api/buds/:budId/terminal/stream`

### 5. Update Server Setup

**File:** `service/src/server.ts` (or main setup file)

- Remove `TerminalManager` instantiation
- Remove `registerTerminalRoutes` call
- Ensure `TerminalSessionManager` is used everywhere
- Ensure `registerThreadTerminalRoutes` is called

### 6. Clean Up Imports

Search and remove any remaining imports of:
- `TerminalManager` (use `TerminalSessionManager`)
- `budTerminalTable` (use `terminalSessionTable`)
- `terminalOutputTable` (use `terminalSessionOutputTable`)
- `terminalInputLogTable` (use `terminalSessionInputLogTable`)

### 7. Update Type Exports

**File:** `service/src/terminal/types.ts`

Remove any bud-specific terminal types if no longer needed.

### 8. Rename Event Bus (Optional)

Consider renaming `TerminalEventBus` to `TerminalSessionEventBus` for clarity, or keep as-is since it's already session-keyed after Phase 5.

---

## Implementation Checklist

- [ ] Delete `service/src/routes/terminals.ts`
- [ ] Remove terminal routes registration from server setup
- [ ] Delete `service/src/runtime/terminal-manager.ts`
- [ ] Remove TerminalManager instantiation from server setup
- [ ] Verify legacy tables already dropped (Phase 1 migration)
- [ ] Remove any bud-based terminal SSE routes
- [ ] Search codebase for remaining legacy imports
- [ ] Update/clean type exports
- [ ] Run full test suite
- [ ] Manual testing of terminal functionality

---

## Verification

Before marking complete, verify:

1. **No legacy routes accessible:**
   ```bash
   curl -X POST http://localhost:3000/api/terminals/test/ensure
   # Should return 404
   ```

2. **New routes work:**
   ```bash
   curl -X POST http://localhost:3000/api/threads/{threadId}/terminal
   # Should create/ensure session
   ```

3. **No TypeScript errors:**
   ```bash
   npx tsc --noEmit
   ```

4. **No runtime errors in logs**

---

## Notes

- This phase should be done LAST, after all other phases are complete and tested
- Keep legacy code until confident the new system works end-to-end
- Consider a feature flag or gradual rollout if needed
