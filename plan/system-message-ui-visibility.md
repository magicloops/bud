# Plan: System Message UI Visibility

**Status:** ✅ **IMPLEMENTED** (2025-12-16) - Used simplified env var approach

## Context

Context sync injects `role: "system"` messages into threads to inform the agent about terminal state changes. These messages are stored in the database but we haven't decided how (or if) to display them in the web UI.

**Example system message:**
> "Claude Code has exited and the terminal shows a shell prompt."

**Questions to answer:**
1. Should users see these messages?
2. If configurable, where does the setting live?
3. How should they be styled differently from user/assistant messages?

---

## Current State

- Messages with `role: "system"` and `displayRole: "Terminal Status"` are stored in DB
- `GET /api/threads/:threadId/messages` returns all messages including system
- Web UI currently renders messages based on `role` field
- No existing user preferences system in web UI

---

## Options

### Option 1: Always Hidden

**Description:** System messages are never shown in the UI. They exist only for the agent's context.

**Implementation:**
```typescript
// web/src/components/chat/message-list.tsx
const visibleMessages = messages.filter(m => m.role !== "system");
```

**Pros:**
- Simplest implementation (one line filter)
- Clean UI - users see only their conversation
- No configuration complexity

**Cons:**
- Users can't see what context the agent received
- Harder to debug when agent behavior seems off
- "Magic" happening behind the scenes

**Effort:** Minimal (~10 min)

---

### Option 2: Always Visible (Styled Differently)

**Description:** System messages always appear in the chat, with distinct styling to differentiate them.

**Implementation:**
```tsx
// New component or conditional styling
{message.role === "system" && (
  <div className="system-message bg-muted/50 border-l-2 border-muted-foreground/30
                  text-sm text-muted-foreground italic px-3 py-2 my-2">
    <span className="font-medium">System:</span> {message.content}
  </div>
)}
```

**Pros:**
- Full transparency - users see exactly what agent knows
- Helps users understand agent behavior
- Educational - shows how context tracking works

**Cons:**
- Adds visual noise to conversation
- May confuse non-technical users
- Can't be turned off if distracting

**Effort:** Small (~30 min)

---

### Option 3: Collapsible (Visible but Minimized)

**Description:** System messages appear as a subtle inline indicator that can be expanded to see details.

**Implementation:**
```tsx
const [expanded, setExpanded] = useState(false);

{message.role === "system" && (
  <button
    onClick={() => setExpanded(!expanded)}
    className="w-full text-left text-xs text-muted-foreground
               hover:bg-muted/30 px-3 py-1 my-1 rounded"
  >
    <ChevronRight className={cn("inline h-3 w-3", expanded && "rotate-90")} />
    <span className="ml-1">Terminal status update</span>
    {expanded && (
      <div className="mt-1 pl-4 text-muted-foreground/80">
        {message.content}
      </div>
    )}
  </button>
)}
```

**Pros:**
- Best of both worlds - visible but not intrusive
- Users can inspect when curious
- Keeps main conversation clean

**Cons:**
- More complex UI logic
- Extra clicks to see content
- State management per message

**Effort:** Medium (~1-2 hours)

---

### Option 4: User Preference Toggle

**Description:** Add a setting to show/hide system messages. Default to hidden.

**Implementation:**

1. Add setting to localStorage or app state:
```typescript
// web/src/hooks/use-settings.ts
export function useSettings() {
  const [showSystemMessages, setShowSystemMessages] = useLocalStorage(
    "bud:showSystemMessages",
    false
  );
  return { showSystemMessages, setShowSystemMessages };
}
```

2. Add toggle in settings UI:
```tsx
// In settings panel or dropdown
<label className="flex items-center gap-2">
  <Switch checked={showSystemMessages} onCheckedChange={setShowSystemMessages} />
  <span>Show system messages</span>
</label>
```

3. Filter in message list:
```tsx
const { showSystemMessages } = useSettings();
const visibleMessages = showSystemMessages
  ? messages
  : messages.filter(m => m.role !== "system");
```

**Pros:**
- User control - power users can enable
- Clean default experience
- Flexible for different user types

**Cons:**
- Need to build/add to settings UI
- Another preference to maintain
- Users may not know the option exists

**Effort:** Medium (~2-3 hours, depends on existing settings infra)

---

### Option 5: Debug Mode Integration

**Description:** System messages only appear when a "debug mode" is enabled, either via URL param, keyboard shortcut, or developer tools.

**Implementation:**

1. Debug mode detection:
```typescript
// web/src/hooks/use-debug-mode.ts
export function useDebugMode() {
  const [enabled, setEnabled] = useState(() => {
    return new URLSearchParams(window.location.search).has("debug");
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        setEnabled(prev => !prev);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return enabled;
}
```

2. Conditional rendering:
```tsx
const debugMode = useDebugMode();
// Show system messages only in debug mode
```

**Pros:**
- Clean production experience
- Power users can access via shortcut
- Natural fit with other debug features
- No UI clutter for settings

**Cons:**
- Discoverability is poor
- Feels like a "hidden" feature
- May want debug mode for other things too

**Effort:** Medium (~1-2 hours)

---

## Comparison Matrix

| Option | User Control | Clean UI | Transparency | Effort | Discoverability |
|--------|--------------|----------|--------------|--------|-----------------|
| 1. Always Hidden | ❌ | ✅ | ❌ | Minimal | N/A |
| 2. Always Visible | ❌ | ❌ | ✅ | Small | ✅ |
| 3. Collapsible | ✅ | ✅ | ✅ | Medium | ✅ |
| 4. User Preference | ✅ | ✅ | ✅ | Medium | ⚠️ |
| 5. Debug Mode | ⚠️ | ✅ | ⚠️ | Medium | ❌ |

---

## Recommendation

**Option 3 (Collapsible)** or **Option 4 (User Preference)** seem like the best balance.

- If we want minimal UI changes: **Option 3** - subtle indicator that expands
- If we're building a settings system anyway: **Option 4** - toggle with default off

**Option 1** is fine as a quick starting point if we want to ship fast and revisit later.

---

## Implementation (Chosen Approach)

We chose a simplified approach using a **Vite environment variable** that can be turned into a user setting later.

### Changes Made

1. **`web/.env.example`** - Added `VITE_SHOW_SYSTEM_MESSAGES=false`

2. **`web/src/lib/config.ts`** - Created new config helper:
```typescript
export const config = {
  showSystemMessages: toBool(import.meta.env.VITE_SHOW_SYSTEM_MESSAGES),
  routerDevtools: toBool(import.meta.env.VITE_ROUTER_DEVTOOLS),
}
```

3. **`web/src/components/workbench/chat-timeline.tsx`**:
   - Filter system messages in `orderedMessages` when `config.showSystemMessages` is false
   - Render system messages with distinct styling (dashed border, muted, italic)

### Usage

To enable system messages in the UI:
```bash
# In web/.env or environment
VITE_SHOW_SYSTEM_MESSAGES=true
```

### Future Enhancement

This env var approach can be upgraded to a user preference by:
1. Adding a settings toggle in the UI
2. Storing preference in localStorage
3. Replacing `config.showSystemMessages` with a reactive hook

---

*Created: 2025-12-16*
