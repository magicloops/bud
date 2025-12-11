# Assistant Message Rendering Spec

## Overview

Deep-dive analysis of how AI/assistant ("Bud Agent") messages are generated on the backend and rendered on the frontend, with the goal of improving markdown rendering and consistency with the message-renderers architecture.

---

## Current Implementation: Backend

### System Prompt (agent-service.ts:64-121)

The agent is instructed to always produce **strict JSON**:

```
You are Bud Agent, coordinating terminal access to a user's machine. Always produce STRICT JSON.
...
When done, respond with {"type":"final","status":"succeeded","message":"..."} (or "failed").
```

### Message Flow

1. **LLM Response**: Agent outputs JSON like `{"type":"final","status":"succeeded","message":"Task completed successfully."}`

2. **Parsing** (agent-service.ts:589-658):
   ```typescript
   private parseResponse(response: OpenAIResponse): AgentDirective {
     // Parse JSON, extract message field
     if (type === "final") {
       const message = typeof payload.message === "string" ? payload.message : "";
       return { type: "final", status, message };
     }
   }
   ```

3. **Fallback**: If JSON parsing fails, raw text becomes the message:
   ```typescript
   return {
     type: "final",
     status: "succeeded",
     message: trimmed  // Raw LLM output
   };
   ```

4. **Storage** (agent-service.ts:366-372):
   ```typescript
   await db.insert(messageTable).values({
     threadId,
     role: "assistant",
     displayRole: "Bud Agent",
     content: directive.message,  // The message text
     metadata: { status: directive.status }
   });
   ```

5. **SSE Event** (agent-service.ts:376-380):
   ```typescript
   this.events.emit(sessionId, {
     event: "agent.message",
     data: { text: directive.message },
   });
   ```

### Key Observations - Backend

| Aspect | Current State |
|--------|--------------|
| Output format | Strict JSON required |
| Message field | Can be any text (no format constraint) |
| displayRole | Always "Bud Agent" |
| Metadata | Contains `{ status: "succeeded" \| "failed" }` |
| Markdown in prompts? | No explicit instruction to use markdown |

---

## Current Implementation: Frontend

### Message Reception ($threadId.tsx:420-437)

```typescript
source.addEventListener('agent.message', (evt) => {
  const data = JSON.parse(evt.data) as { text: string }
  setMessages((prev) => [
    ...prev,
    {
      message_id: `streaming_${Date.now()}`,
      role: 'assistant',
      display_role: 'Assistant',  // Note: Different from "Bud Agent"
      content: data.text,
      created_at: new Date().toISOString()
    }
  ])
})
```

### Message Rendering (chat-timeline.tsx:165-178)

```typescript
const contentNode = isTool ? (
  // ... tool rendering with message-renderers system
) : (
  <div className="space-y-2">
    {isAssistant && message.content ? (
      <Suspense fallback={<pre className="whitespace-pre-wrap text-sm">{message.content}</pre>}>
        <Markdown remarkPlugins={[remarkBreaks]}>{message.content}</Markdown>
      </Suspense>
    ) : (
      <p>{message.content}</p>
    )}
  </div>
)
```

### Memoization (chat-timeline.tsx:238)

```typescript
export const ChatTimeline = memo(ChatTimelineComponent)
```

Only the entire timeline is memoized, not individual messages.

### Key Observations - Frontend

| Aspect | Current State | Issue |
|--------|--------------|-------|
| Markdown library | `react-markdown` | Working |
| Plugins | `remarkBreaks` only | No GFM, no syntax highlighting |
| Lazy loading | Yes (Suspense) | Good for bundle size |
| Typography styling | None | Markdown renders unstyled |
| @tailwindcss/typography | Not installed | No `prose` classes |
| Individual message memoization | None | All messages re-render on any change |
| Uses message-renderers? | No | Inconsistent with tool messages |

---

## Problems Identified

### 1. No Markdown Styling

The `react-markdown` output has no visual styling. Elements render with browser defaults:
- Headings are just bold text
- Code blocks have no background/border
- Lists have no proper spacing
- Links are unstyled

### 2. Missing Markdown Features

Current plugins: `[remarkBreaks]`

Missing:
- `remark-gfm` - GitHub Flavored Markdown (tables, strikethrough, task lists)
- Syntax highlighting for code blocks (e.g., `react-syntax-highlighter`)

### 3. No Message-Level Memoization

When a new message arrives, ALL messages re-render:
```typescript
{orderedMessages.map((message) => {
  // Expensive computations happen for EVERY message
  const payload = isTool ? resolveToolPayload(message) : null
  const ToolContentRenderer = ...
  // ... render logic
})}
```

### 4. Architectural Inconsistency

Tool messages use the new `message-renderers` system:
```typescript
{ToolContentRenderer && payload && (
  <ToolContentRenderer payload={payload} />
)}
```

But assistant messages are rendered inline, not through a renderer.

### 5. displayRole Mismatch

- Backend stores: `"Bud Agent"`
- Streaming frontend creates: `"Assistant"`

---

## Open Questions

### Q1: Markdown Styling Approach?

**Option A: Install @tailwindcss/typography**
```bash
pnpm add @tailwindcss/typography
```
```tsx
<div className="prose prose-sm dark:prose-invert">
  <Markdown>{content}</Markdown>
</div>
```
- Pros: Well-tested, comprehensive styling, responsive
- Cons: Large CSS payload, may conflict with existing styles

**Option B: Custom CSS for Markdown**
```css
.chat-markdown h1 { @apply text-lg font-bold; }
.chat-markdown code { @apply bg-muted px-1 rounded; }
/* ... */
```
- Pros: Minimal, controlled, matches design system
- Cons: Manual maintenance, might miss edge cases

**Option C: Component mapping with react-markdown**
```tsx
<Markdown
  components={{
    h1: ({ children }) => <h1 className="text-lg font-bold">{children}</h1>,
    code: ({ children }) => <code className="bg-muted px-1 rounded">{children}</code>,
  }}
>
```
- Pros: Full control, no extra CSS, type-safe
- Cons: Verbose, but explicit

### Q2: Should Assistant Use message-renderers?

**Option A: Yes - Create AssistantContent Renderer**
```typescript
// message-renderers/roles/assistant.tsx
export function AssistantContent({ message }: MessageRendererProps) {
  return (
    <div className="prose-sm">
      <Markdown ...>{message.content}</Markdown>
    </div>
  )
}
```
- Pros: Consistent architecture, easier to customize
- Cons: More files, slightly more indirection

**Option B: No - Keep Inline**
- Pros: Simpler, one less abstraction
- Cons: Special-cased logic in chat-timeline

### Q3: Memoization Strategy?

**Option A: Memoize Message Item Component**
```typescript
const MessageItem = memo(function MessageItem({
  message,
  isExpanded,
  onToggle,
}: MessageItemProps) {
  // render logic
})
```
- Pros: Prevents re-renders of unchanged messages
- Cons: Requires stable callbacks (useCallback), careful prop design

**Option B: Memoize Content Renderers Only**
```typescript
export const AssistantContent = memo(function AssistantContent(...) { ... })
export const TerminalRunContent = memo(function TerminalRunContent(...) { ... })
```
- Pros: Targeted, less refactoring
- Cons: Message shell still re-renders

**Option C: Virtualization (react-window)**
- Pros: Handles 1000s of messages
- Cons: Overkill for current use case, complexity

### Q4: What Markdown Features Do We Need?

| Feature | Priority | Plugin/Approach |
|---------|----------|-----------------|
| Basic formatting (bold, italic) | Must have | Built-in |
| Line breaks | Must have | `remarkBreaks` (already have) |
| Code blocks | Must have | Component mapping or syntax highlighter |
| Inline code | Must have | Component mapping |
| Lists (ul, ol) | Should have | Built-in |
| Links | Should have | Component mapping (target="_blank") |
| Tables | Nice to have | `remarkGfm` |
| Task lists | Nice to have | `remarkGfm` |
| Syntax highlighting | Nice to have | `react-syntax-highlighter` |

### Q5: Should We Prompt the Agent to Use Markdown?

Currently, the system prompt doesn't mention output formatting. Options:

**Option A: Add to System Prompt**
```
When writing messages, use markdown formatting for clarity:
- Use **bold** for emphasis
- Use `code` for commands, file paths, and technical terms
- Use code blocks with language tags for multi-line code
```

**Option B: Leave As-Is**
- Agent will naturally use markdown when appropriate
- Less prompt bloat

---

## Proposed Implementation

### Phase 1: Style Markdown (Minimal)

1. Use react-markdown `components` prop for styling
2. Add custom styles for common elements
3. No new dependencies

### Phase 2: Extend message-renderers

1. Add `roles/` subdirectory
2. Create `AssistantContent` renderer with memoization
3. Update `chat-timeline.tsx` to use it

### Phase 3: Add Markdown Features

1. Install `remark-gfm` for tables, task lists
2. Consider syntax highlighting if code-heavy

### Phase 4: Memoize Messages (If Needed)

1. Profile first to confirm performance issue
2. Extract `MessageItem` component with `memo()`
3. Stabilize callbacks with `useCallback`

---

## Files to Modify

| File | Change |
|------|--------|
| `chat-timeline.tsx` | Add component mapping to Markdown, use role renderer |
| `message-renderers/types.ts` | Add `MessageRendererProps` for full messages |
| `message-renderers/roles/index.ts` | New - role renderer registry |
| `message-renderers/roles/assistant.tsx` | New - memoized assistant renderer |
| `message-renderers/index.ts` | Export new role renderer lookup |

---

## Decision Needed

Before implementation, please decide:

1. **Styling approach**: Typography plugin vs component mapping vs custom CSS?
2. **Architecture**: Should assistant use message-renderers or stay inline?
3. **Features**: Do we need GFM (tables, task lists)? Syntax highlighting?
4. **Prompt changes**: Should we guide the agent to use markdown?
