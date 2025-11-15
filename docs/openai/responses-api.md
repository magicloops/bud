# **OpenAI Responses API – Practical Engineering Guide**

A concise, implementation-focused reference for developers using the Responses API with:

* **Text inputs (via `input_text`)**
* **Image inputs (via `input_image`)**
* **Function tools**
* **MCP tools**
* **Manual multi-turn conversation state**
* **Streaming responses**

Purpose: make it easy for engineers to implement correct request/response flows without reading the full OpenAI docs.

---

# **1. Core Endpoint**

```http
POST /v1/responses
```

This endpoint handles:

* Sending inputs
* Receiving assistant output
* Multi-turn conversations
* Tool calls (function + MCP)
* Image inputs
* Structured content
* Streaming responses

Every request returns (or streams) a **Response object** containing:

* Assistant messages
* Tool call requests
* Usage tokens
* Reasoning info (if applicable)
* IDs if needed for advanced flows

---

# **2. Input Structure Overview**

You will build **all input** using structured message objects—no plain string input.

```ts
{
  model: string;
  input: InputItem[];
  instructions?: string;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  temperature?: number;
  top_p?: number;
  text?: { format: ... };
  stream?: boolean;
}
```

You will primarily use:

* **input** → full message list (manual history)
* **tools** → function & MCP tool definitions
* **tool_choice** → auto or required
* **instructions** → system/developer messages
* **temperature / top_p** → sampling controls
* **text.format** → plain text or structured output mode
* **stream** → enable server-sent events (SSE)

---

# **3. Input: Multi-turn Message Structure**

All inputs are built using the `message` item type:

```ts
{
  type: "message";
  role: "user" | "assistant" | "system" | "developer";
  content: ContentItem[];
}
```

Where `ContentItem` is one of:

* `input_text`
* `input_image`
* (For assistant messages, `output_text`)

Your system constructs a complete sequence of prior turns:

1. System/developer messages
2. All prior user messages
3. All prior assistant messages
4. All tool call items + tool call outputs
5. The new message

### Example conversation using only structured messages

```jsonc
{
  "model": "gpt-4.1",
  "input": [
    {
      "type": "message",
      "role": "system",
      "content": [
        { "type": "input_text", "text": "You are MagicLoopsGPT." }
      ]
    },
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Summarize this text." }
      ]
    },
    {
      "type": "message",
      "role": "assistant",
      "content": [
        { "type": "output_text", "text": "Sure — what text?" }
      ]
    },
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Here is the text to summarize." }
      ]
    }
  ]
}
```

---

# **4. Input: Text Content Items**

Within a `message` → `content` array:

### **4.1 `input_text`**

```ts
{
  type: "input_text";
  text: string;
}
```

Use this for all user-provided text.

Example:

```json
{ "type": "input_text", "text": "Explain quantum tunneling." }
```

---

# **5. Input: Image Items**

Images are passed using `input_image`:

```ts
{
  type: "input_image";
  detail: "high" | "low" | "auto";
  image_url?: string;   // URL or base64 data URL
  file_id?: string;     // if uploaded via files API
}
```

Example:

```jsonc
{
  "type": "input_image",
  "detail": "high",
  "image_url": "https://example.com/cat.jpg"
}
```

Combined text + image message:

```jsonc
{
  "type": "message",
  "role": "user",
  "content": [
    { "type": "input_text", "text": "Describe this picture." },
    { "type": "input_image", "detail": "high", "image_url": "..." }
  ]
}
```

---

# **6. Tools (Function & MCP)**

Only the tools you use:

* Function tools (call your backend)
* MCP tools (call out to your Model Context Protocol servers)

---

## **6.1 Function Tools**

Define a tool:

```ts
{
  type: "function",
  name: "getWeather",
  description: "Get current weather for a city.",
  parameters: {
    type: "object",
    properties: {
      city: { type: "string" }
    },
    required: ["city"]
  },
  strict: true
}
```

Include in your request:

```json
{
  "tools": [
    {
      "type": "function",
      "name": "getWeather",
      "parameters": { /* JSON schema */ }
    }
  ]
}
```

Example function call output from model:

```jsonc
{
  "type": "function_call",
  "call_id": "tool_123",
  "name": "getWeather",
  "arguments": "{\"city\":\"Paris\"}"
}
```

### Responding with tool output

You include in the next turn’s `input`:

```ts
{
  type: "function_call_output",
  call_id: "tool_123",
  output: string // JSON or text
}
```

---

## **6.2 MCP Tools**

Define MCP tools similarly:

```ts
{
  type: "mcp",
  server_label: "magic-indexer",
  name: "search"
}
```

Model emits:

```jsonc
{
  "type": "mcp_tool_call",
  "id": "mcp_1",
  "server_label": "magic-indexer",
  "name": "search",
  "arguments": "{\"query\":\"productivity\"}"
}
```

You respond with:

```ts
{
  type: "mcp_tool_call_output",
  call_id: "mcp_1",
  output: { /* JSON-safe payload */ }
}
```

---

## **6.3 Tool Choice**

### Auto (recommended)

```json
"tool_choice": "auto"
```

Model may or may not call tools.

### Required

```json
"tool_choice": "required"
```

Model must call at least one tool.

### Force a specific function

```json
{
  "tool_choice": { "type": "function", "name": "getWeather" }
}
```

### Force a specific MCP tool

```json
{
  "tool_choice": { "type": "mcp", "server_label": "magic-indexer" }
}
```

---

# **7. Multi-Turn Conversations (Manual History Management)**

You will always:

* Maintain your own message history
* Append each assistant response, tool call, and tool output
* Rebuild the full `input` array each turn

### This gives you:

* Full control over context window management
* Customizable trimming logic
* Ability to persist conversations anywhere
* Predictable, explicit message ordering

No `previous_response_id` or OpenAI-managed context is used.

### Structure per turn:

1. System/developer instructions (optional)
2. All prior user messages
3. All prior assistant messages
4. All prior tool call items
5. All tool call output items
6. Current user message

Then call:

```ts
client.responses.create({ model, input, tools, tool_choice })
```

---

# **8. Example: Full Multi-turn with Function Tool + Image**

### Step 1 — Initial user message with image

```jsonc
{
  "model": "gpt-4.1",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "What is happening in this image?" },
        { "type": "input_image", "detail": "high", "image_url": "..." }
      ]
    }
  ],
  "tools": [
    {
      "type": "function",
      "name": "describeScene",
      "parameters": {
        "type": "object",
        "properties": { "context": { "type": "string" } }
      }
    }
  ],
  "tool_choice": "auto"
}
```

### Step 2 — Model responds with tool call

```jsonc
{
  "type": "function_call",
  "call_id": "tool_789",
  "name": "describeScene",
  "arguments": "{\"context\":\"outdoor\"}"
}
```

### Step 3 — You execute the tool and send next turn

```jsonc
{
  "model": "gpt-4.1",
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "What is happening in this image?" },
        { "type": "input_image", "detail": "high", "image_url": "..." }
      ]
    },
    {
      "type": "function_call",
      "call_id": "tool_789",
      "name": "describeScene",
      "arguments": "{\"context\":\"outdoor\"}"
    },
    {
      "type": "function_call_output",
      "call_id": "tool_789",
      "output": "{\"description\":\"A boardwalk through grass.\"}"
    }
  ]
}
```

### Step 4 — Model produces assistant text

```jsonc
{
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "output_text",
      "text": "It appears to be a wooden boardwalk through a grassy field."
    }
  ]
}
```

---

# **9. Response Object (Simplified for Your Use Case)**

```ts
{
  id: string;
  model: string;
  status: "completed" | "in_progress" | "failed" | "queued" | "incomplete";
  output: OutputItem[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  output_text?: string; // SDK convenience field
}
```

* In streaming mode, `usage` is usually only populated in the final `response.completed` event.
* `output` contains messages, function calls, MCP calls, etc.

---

# **10. Output Item Types (You Will Encounter)**

### Assistant Message

```jsonc
{
  "type": "message",
  "role": "assistant",
  "status": "completed",
  "content": [
    { "type": "output_text", "text": "Hello!" }
  ]
}
```

### Function Tool Call

```jsonc
{
  "type": "function_call",
  "id": "item-abc",
  "call_id": "item-abc",
  "name": "searchDocuments",
  "arguments": "{\"query\":\"test\"}",
  "status": "in_progress"
}
```

### MCP Tool Call

```jsonc
{
  "type": "mcp_tool_call",
  "id": "mcp_1",
  "server_label": "magic-indexer",
  "name": "search",
  "arguments": "{\"query\":\"testing\"}",
  "status": "in_progress"
}
```

---

# **11. Recommended Implementation Pattern**

1. Build your own **message structure** mirroring OpenAI InputItems.
2. Each turn:

   * Append new user messages.
   * Append prior assistant messages.
   * Append tool call & tool output items.
   * Serialize to OpenAI’s `input` array.
3. On output:

   * Detect function/MCP tool calls.
   * Execute backend or MCP request.
   * Append tool output.
   * Send the next round.
4. When output is a normal assistant message:

   * Save + display it.
   * End the turn (or wait for user input).
5. Use **streaming** (next section) to show partial results and capture token usage from the final event.

---

# **12. Streaming Responses**

When you set `stream: true` in `POST /v1/responses`, the API returns **Server-Sent Events (SSE)** instead of a single JSON object.

Streaming is how you will:

* Stream partial assistant text
* Detect tool calls early (function & MCP)
* Learn final token usage from the end-of-stream event

## 12.1 Enabling Streaming

Example request body:

```jsonc
{
  "model": "gpt-4.1",
  "stream": true,
  "input": [
    {
      "type": "message",
      "role": "user",
      "content": [
        { "type": "input_text", "text": "Tell me a short story." }
      ]
    }
  ]
}
```

Over HTTP, you’ll receive a sequence of SSE events like:

```text
event: response.created
data: { ... }

event: response.output_item.added
data: { ... }

event: response.output_text.delta
data: { ... }

...

event: response.completed
data: { ... }

event: done
data: [empty or {}]
```

Your client should:

* Parse each `event:` line
* Parse `data:` as JSON
* Dispatch based on `type` (inside the JSON) or on the SSE event name, depending on your client library

---

## 12.2 Key Events You Actually Care About

Only the events relevant for:

* Text output
* Function tools
* MCP tools
* Token usage
* Error handling

### **1. `response.created`**

Emitted when the response is created.

Shape (simplified):

```jsonc
{
  "type": "response.created",
  "response": {
    "id": "resp_...",
    "status": "in_progress",
    "model": "gpt-4o-2024-08-06",
    "output": [],
    "usage": null
  },
  "sequence_number": 1
}
```

Use this to:

* Capture `response.id` if you want to reference this response later.

---

### **2. `response.in_progress` (optional)**

Emitted when the response is in progress.

You can usually ignore this for basic UI; it just confirms the run is ongoing.

---

### **3. `response.output_item.added`**

Emitted when a **new output item** is created.

Example (assistant message being started):

```jsonc
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "id": "msg_123",
    "status": "in_progress",
    "type": "message",
    "role": "assistant",
    "content": []
  },
  "sequence_number": 2
}
```

Or a function call:

```jsonc
{
  "type": "response.output_item.added",
  "output_index": 0,
  "item": {
    "id": "item-abc",
    "status": "in_progress",
    "type": "function_call",
    "name": "getWeather",
    "arguments": ""
  },
  "sequence_number": 3
}
```

Use this to:

* Allocate a buffer in your UI / state model for:

  * New assistant message text
  * New function call
  * New MCP call

---

### **4. `response.content_part.added`**

Starts a **content part** (e.g., an `output_text` object).

Example:

```jsonc
{
  "type": "response.content_part.added",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "part": {
    "type": "output_text",
    "text": "",
    "annotations": []
  },
  "sequence_number": 4
}
```

Use this to:

* Track which `content_index` is being streamed for a given message.

In many cases you can skip reacting to this explicitly and rely directly on `response.output_text.delta`.

---

### **5. `response.output_text.delta`**

This is the main event for streaming assistant text.

```jsonc
{
  "type": "response.output_text.delta",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "delta": "In",
  "sequence_number": 5
}
```

You append `delta` to the existing text buffer for:

* The message with `item_id`
* The content part at `content_index`

Pseudo-logic:

```ts
onOutputTextDelta(e) {
  const { item_id, content_index, delta } = e;
  const message = messages[item_id];
  message.content[content_index].text += delta;
}
```

---

### **6. `response.output_text.done`**

Emitted when the **text content** is finalized.

```jsonc
{
  "type": "response.output_text.done",
  "item_id": "msg_123",
  "output_index": 0,
  "content_index": 0,
  "text": "Full completed text...",
  "sequence_number": 10
}
```

You can:

* Optionally reconcile your buffer with `text` (should match accumulated deltas)
* Mark the content part as `done` in your state

---

### **7. Tool Calls – Function Arguments**

#### `response.function_call_arguments.delta`

Partial JSON string for function-call arguments:

```jsonc
{
  "type": "response.function_call_arguments.delta",
  "item_id": "item-abc",
  "output_index": 0,
  "delta": "{ \"city\": \"Par",
  "sequence_number": 6
}
```

You accumulate `delta` to build up the full `arguments` string.

#### `response.function_call_arguments.done`

Final arguments for the function call:

```jsonc
{
  "type": "response.function_call_arguments.done",
  "item_id": "item-abc",
  "name": "getWeather",
  "output_index": 0,
  "arguments": "{ \"city\": \"Paris\" }",
  "sequence_number": 7
}
```

At this point:

1. Parse `arguments` as JSON.
2. Trigger your tool execution.
3. Build the next-turn request with a `function_call_output` item.

This lets you:

* Detect tool calls ASAP in the stream
* Start network/database work while other content may still be streaming

---

### **8. Tool Calls – MCP Arguments**

#### `response.mcp_call_arguments.delta`

```jsonc
{
  "type": "response.mcp_call_arguments.delta",
  "output_index": 0,
  "item_id": "mcp_abc",
  "delta": "{",
  "sequence_number": 8
}
```

#### `response.mcp_call_arguments.done`

```jsonc
{
  "type": "response.mcp_call_arguments.done",
  "output_index": 0,
  "item_id": "mcp_abc",
  "arguments": "{\"query\": \"hello\"}",
  "sequence_number": 9
}
```

Same pattern as function calls:

* Accumulate deltas
* On `done`, parse `arguments` and execute your MCP tool

You may also see:

* `response.mcp_call.in_progress`
* `response.mcp_call.completed`
* `response.mcp_call.failed`

These describe the lifecycle of the MCP call item itself (not strictly necessary for most client logic, but can be useful for debugging/telemetry).

---

### **9. Item Completion**

#### `response.output_item.done`

Marks the entire output item as done (message, function call, MCP call, etc.):

```jsonc
{
  "type": "response.output_item.done",
  "output_index": 0,
  "item": {
    "id": "msg_123",
    "status": "completed",
    "type": "message",
    "role": "assistant",
    "content": [
      {
        "type": "output_text",
        "text": "Full text...",
        "annotations": []
      }
    ]
  },
  "sequence_number": 11
}
```

You can:

* Update your state to mark that item as completed.
* Use `item` as a snapshot of the finished piece.

---

### **10. Response Completion / Failure**

#### `response.completed`

Emitted when the entire response is finished:

```jsonc
{
  "type": "response.completed",
  "response": {
    "id": "resp_123",
    "status": "completed",
    "output": [ /* final items */ ],
    "usage": {
      "input_tokens": 123,
      "output_tokens": 45,
      "total_tokens": 168,
      "output_tokens_details": {
        "reasoning_tokens": 0
      }
    }
  },
  "sequence_number": 12
}
```

Use this to:

* Finalize UI state.
* Read token usage for billing/analytics.
* Persist the final `response` object if desired.

#### `response.failed`

If the model fails:

```jsonc
{
  "type": "response.failed",
  "response": {
    "id": "resp_123",
    "status": "failed",
    "error": {
      "code": "server_error",
      "message": "The model failed to generate a response."
    }
  }
}
```

#### `response.incomplete`

If the response ends early (e.g., `max_tokens`):

```jsonc
{
  "type": "response.incomplete",
  "response": {
    "id": "resp_123",
    "status": "incomplete",
    "incomplete_details": {
      "reason": "max_tokens"
    }
  }
}
```

#### `response.queued`

If the response is queued:

```jsonc
{
  "type": "response.queued",
  "response": {
    "id": "resp_123",
    "status": "queued"
  }
}
```

#### Generic `error` event (transport-level)

```jsonc
{
  "type": "error",
  "code": "ERR_SOMETHING",
  "message": "Something went wrong",
  "param": null,
  "sequence_number": 1
}
```

Your client should treat both `response.failed` and `error` as failures.

---

## 12.3 Minimal Streaming Client Logic (Conceptual)

Pseudo-code outline:

```ts
function handleEvent(e: StreamingEvent) {
  switch (e.type) {
    case "response.created":
      state.responseId = e.response.id;
      break;

    case "response.output_item.added":
      initOutputItem(e.item);
      break;

    case "response.output_text.delta":
      appendTextDelta(e.item_id, e.content_index, e.delta);
      break;

    case "response.output_text.done":
      finalizeText(e.item_id, e.content_index, e.text);
      break;

    case "response.function_call_arguments.delta":
      appendToolArgsDelta(e.item_id, e.delta);
      break;

    case "response.function_call_arguments.done":
      const args = JSON.parse(e.arguments);
      handleFunctionCall(e.item_id, e.name, args);
      break;

    case "response.mcp_call_arguments.delta":
      appendMcpArgsDelta(e.item_id, e.delta);
      break;

    case "response.mcp_call_arguments.done":
      const mcpArgs = JSON.parse(e.arguments);
      handleMcpCall(e.item_id, mcpArgs);
      break;

    case "response.completed":
      state.usage = e.response.usage;
      finalizeConversation(e.response);
      break;

    case "response.failed":
    case "response.incomplete":
    case "error":
      handleError(e);
      break;

    default:
      // ignore others or log for debugging
  }
}
```

You can build all your token tracking, UI streaming, and tool execution logic on top of this event loop.

---

# **13. Summary**

You now have:

* A single unified way to construct **structured inputs** (messages only)
* Support for **text** and **image** inputs
* Support for **function** and **MCP** tools and their streaming argument events
* A pattern for **manual multi-turn state management**
* A clear view of the **streaming event model**, including:

  * Text deltas (`response.output_text.delta`)
  * Tool-call arguments (`response.function_call_arguments.*`, `response.mcp_call_arguments.*`)
  * Completion, failure, and usage (`response.completed`, `response.failed`, `response.incomplete`)

This should be enough for an engineer to wire up a robust, streaming, tool-using agent system on top of the Responses API.
