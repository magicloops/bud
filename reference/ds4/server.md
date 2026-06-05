Start a local OpenAI/Anthropic-compatible server:

./ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192
Use --chdir /path/to/ds4 when launching ds4-server from another directory, so relative runtime files such as metal/*.metal resolve from the project tree.

The server keeps one mutable backend/KV checkpoint in memory, so stateless clients that resend a longer version of the same prompt can reuse the shared prefix instead of pre-filling from token zero.

Request parsing and sockets run in client threads, but inference itself is serialized through one graph worker. The current server does not batch multiple independent requests together; concurrent requests wait their turn on the single live graph/session.

Supported endpoints:

GET /v1/models
GET /v1/models/deepseek-v4-flash
GET /v1/models/deepseek-v4-pro
POST /v1/chat/completions
POST /v1/responses
POST /v1/completions
POST /v1/messages
The Flash and PRO model endpoints are compatibility aliases. They both report the model currently loaded from the GGUF passed with -m; the endpoint name does not select a different model.

/v1/chat/completions accepts the usual OpenAI-style messages, max_tokens/max_completion_tokens, temperature, top_p, top_k, min_p, seed, stream, stream_options.include_usage, tools, and tool_choice. Tool schemas are rendered into DeepSeek's DSML tool format, and generated DSML tool calls are mapped back to OpenAI tool calls.

/v1/responses accepts OpenAI Responses-style input, instructions, tools, tool_choice, max_output_tokens, temperature, top_p, stream, and reasoning. It is the preferred endpoint for Codex CLI. The server keeps Responses continuations bound to live state when possible, and can fall back to the same DSML rendering and KV prefix reuse used by chat completions.

/v1/messages is the Anthropic-compatible endpoint used by Claude Code style clients. It accepts system, messages, tools, tool_choice, max_tokens, temperature, top_p, top_k, stream, stop_sequences, and thinking controls. Tool uses are returned as Anthropic tool_use blocks.

Default sampled API generation uses temperature=1, top_p=1, and min_p=0.05, so the default filter is relative probability rather than nucleus mass. In thinking mode DS4 uses those fixed sampling defaults and ignores client sampling knobs, matching DeepSeek's fixed-thinking API behavior.

The chat, Responses, and Anthropic endpoints support SSE streaming. In thinking mode, reasoning is streamed in the native API shape instead of being mixed into final text. OpenAI chat streaming also streams tool calls as soon as the DSML invocation is recognized: the tool header is sent first, then parameter bytes are forwarded as tool_calls[].function.arguments deltas while generation continues. The Anthropic endpoint streams thinking and text live, then emits structured tool_use blocks when the generated tool block is complete. The Responses endpoint streams the Responses event lifecycle expected by Codex, including response.output_text.delta, function-call argument events, and terminal response.completed / response.incomplete / response.failed events.

For browser JavaScript clients served from another origin, start the server with --cors to emit Access-Control-Allow-* headers. This only changes HTTP headers; it does not expose the server on the LAN. Use --host 0.0.0.0 explicitly when remote machines should be able to connect.

Tool call handling and canonicalization

DeepSeek V4 emits tool calls as DSML text. Agent clients do not send that same text back on the next request: they send normalized OpenAI/Anthropic JSON tool-call objects. If the server re-rendered those objects slightly differently, the rendered byte prefix would no longer match the live KV checkpoint and the next turn would have to be rebuilt.

The first line of defense is exact replay. Every tool call gets an unguessable API tool ID, and the server remembers tool id -> exact sampled DSML block in a bounded in-memory map backed by radix trees. When the client later sends that tool ID back, the prompt renderer uses the exact DSML bytes the model sampled, not a freshly formatted approximation. This map can also be saved inside KV cache files, so exact replay survives server restarts for cached histories.

Canonicalization is only the backup path. If the exact DSML block is missing, or exact replay is disabled with --disable-exact-dsml-tool-replay, the server renders a deterministic DSML form from the JSON tool object. After a tool-call turn, it compares the live sampled token stream with the prompt that the next client request will render. If needed, it rewrites the live checkpoint, or falls back to an older disk KV snapshot and replays only the suffix. This keeps the model continuation aligned with the stateless API transcript.

During generation, the server also treats DSML syntax differently from payload. When the model is emitting stable protocol structure such as DSML tags, parameter headers, JSON punctuation, or closing markers, sampling is forced to temperature=0 so the tool call stays parseable. This greedy mode does not apply to argument payloads: string=true parameter bodies and JSON string values, including file contents and edit text, use the request's normal sampling settings. That separation is important: deterministic decoding is helpful for syntax, but can create repeated text when applied to long code or file bodies.

Minimal OpenAI example:

curl http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"deepseek-v4-flash",
    "messages":[{"role":"user","content":"List three Redis design principles."}],
    "stream":true
  }'
Agent Client Usage

ds4-server can be used by local coding agents that speak OpenAI-compatible chat completions. Start the server first, and set the client context limit no higher than the --ctx value you started the server with:

./ds4-server --ctx 100000 --kv-disk-dir /tmp/ds4-kv --kv-disk-space-mb 8192
You can use larger context and larger cache if you wish. Full context of 1M tokens is going to use more or less 26GB of memory (compressed indexer alone will be like 22GB), so configure a context which makes sense in your system. With 128GB of RAM you would run the 2-bit quants, which are already 81GB, 26GB are going to be likely too much, so a context window of 100~300k tokens is wiser. However users reported being able to run 2bit quants with 250k ctx window in a Macs with just 96GB of system memory: make sure to kill processes that use too much memory, if you plan doing so ;)

The 384000 output limit below avoids token caps since the model is able to generate very long replies otherwise (up to 384k tokens). The server still stops when the configured context window is full.
