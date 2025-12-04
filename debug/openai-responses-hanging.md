# OpenAI Responses API Hanging

**Date:** 2025-12-03
**Issue:** OpenAI Responses API calls hang indefinitely, not returning even with low reasoning effort

## Symptoms

1. Service logs show request initiated but never completes:
   ```
   [20:40:49.639] INFO: Calling OpenAI Responses
       component: "agent"
       entries: 339
       lastRole: "user"
       reasoningEffort: "low"
   ```
   No subsequent "OpenAI response received" log.

2. When user cancels, we see abort error (expected):
   ```
   [13:50:06.749] ERROR: Agent flow failed
       err: {
         "type": "APIUserAbortError",
         "message": "Request was aborted."
       }
   ```

3. Request should complete in seconds with `reasoningEffort: "low"`, but hangs for 60+ seconds.

## Current Implementation

**File:** `service/src/agent/agent-service.ts` (lines 532-563)

```typescript
private async invokeModel(
  input: InputItem[],
  reasoningEffort: ReasoningEffortSetting,
  signal?: AbortSignal
): Promise<OpenAIResponse> {
  const last = input.at(-1);
  const lastRole = last && "type" in last && last?.type === "message" ? last.role : "n/a";
  this.debug("Calling OpenAI Responses", {
    entries: input.length,
    lastRole,
    reasoningEffort
  });
  const response = await this.client.responses.create(
    {
      model: config.openaiModel,                    // "gpt-4.1-mini" by default
      input,                                         // 339 entries (large!)
      tools: [TERMINAL_RUN_TOOL, TERMINAL_OBSERVE_TOOL, TERMINAL_INTERRUPT_TOOL],
      tool_choice: "auto",
      max_output_tokens: config.agentMaxOutputTokens, // 128000
      reasoning: { effort: reasoningEffort },        // "low"
      text: { format: { type: "json_object" } }
    },
    signal ? { signal } : undefined
  );
  // ... logging after response
}
```

**Observations:**
- No timeout configured on the OpenAI client or request
- Large input (339 entries) could be causing issues
- No error handling for network issues during request
- No visibility into what's being sent to API

## Error Handling Analysis

**Current flow:**
1. `invokeModel()` - No try/catch, errors propagate up
2. `runAgentFlow()` - Has try/catch, emits `final` event on error
3. `startUserMessage()` - Has `.catch()`, logs errors

**The issue:** Errors ARE caught, but **a hanging request never throws an error**. The promise just never resolves or rejects.

**OpenAI client initialization** (`server.ts:46`):
```typescript
const openai = new OpenAI({ apiKey: config.openaiApiKey });
// No timeout configured!
```

The OpenAI SDK default has no timeout, so if the API hangs, we wait forever.

## Hypotheses

### Hypothesis 1: Input Too Large (339 entries)

The conversation has 339 entries being sent to the API. This could:
- Exceed model context limits
- Cause slow processing on OpenAI's side
- Hit rate limits or throttling

**Evidence:** Log shows `entries: 339` which is unusually large.

**Test:** Log the approximate token count or truncate old messages.

### Hypothesis 2: No Request Timeout

The OpenAI client has no timeout configured. If OpenAI's servers are slow or the request gets stuck, we wait forever.

**Evidence:** Request hangs indefinitely rather than failing after a reasonable time.

**Fix:** Add timeout to OpenAI client:
```typescript
const client = new OpenAI({
  apiKey: config.openaiApiKey,
  timeout: 60000,  // 60 second timeout
});
```

### Hypothesis 3: Malformed Input Causing API Error

One of the 339 input entries might be malformed (e.g., invalid function_call_output, missing fields) causing the API to hang or fail silently.

**Evidence:** No response received, but also no error logged.

**Test:** Log the last few input entries to verify structure.

### Hypothesis 4: Model Name Issue

Config shows `openaiModel: "gpt-4.1-mini"` which doesn't look like a valid OpenAI model name. Valid names are like `gpt-4o`, `gpt-4o-mini`, `o1`, etc.

**Evidence:** Line 35 in config.ts: `openaiModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini"`

**Test:** Check what `OPENAI_MODEL` env var is set to, or if using the fallback.

### Hypothesis 5: Network/Proxy Issue

Request might be getting blocked or timing out at network level (firewall, proxy, DNS).

**Evidence:** Less likely since initial requests work, but possible for long-running connections.

**Test:** Check if shorter conversations work reliably.

## Recommended Debugging Steps

1. **Add request timeout** to OpenAI client (immediate safety fix)

2. **Log input size in bytes/tokens** before sending:
   ```typescript
   const inputJson = JSON.stringify(input);
   this.debug("OpenAI request", {
     entries: input.length,
     inputBytes: inputJson.length,
     lastEntry: JSON.stringify(input.at(-1)).slice(0, 500)
   });
   ```

3. **Verify model name** - check `OPENAI_MODEL` env var

4. **Add try/catch with specific error logging**:
   ```typescript
   try {
     const response = await this.client.responses.create(...);
   } catch (err) {
     this.logger.error({
       err,
       inputEntries: input.length,
       model: config.openaiModel
     }, "OpenAI API call failed");
     throw err;
   }
   ```

5. **Consider input truncation** - 339 entries is likely too many. Implement sliding window or summarization.

## Files to Modify

| File | Changes |
|------|---------|
| `service/src/agent/agent-service.ts` | Add timeout, improve logging, add error handling |
| `service/src/config.ts` | Add `openaiTimeout` config option |

## Priority

**HIGH** - This blocks agent functionality entirely when it occurs.
