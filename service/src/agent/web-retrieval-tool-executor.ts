import { retrievalConfig } from "../web-retrieval/config.js";
import { RetrievalError } from "../web-retrieval/contracts.js";
import { FirecrawlBackend } from "../web-retrieval/firecrawl.js";
import { WebRetrieval } from "../web-retrieval/retrieval.js";
import type { ExecutedWebRetrievalTool, WebRetrievalToolCallDirective } from "./contracts.js";

export class WebRetrievalToolExecutor {
  constructor(private readonly retrieval?: Pick<WebRetrieval, "execute">,
    private readonly report: (metrics: Record<string, unknown>) => void = () => {}) {}

  async execute(threadId: string, directive: WebRetrievalToolCallDirective, owner?: string | null,
    signal?: AbortSignal, turnId?: string): Promise<ExecutedWebRetrievalTool> {
    const started = Date.now();
    let response: Record<string, unknown>, errorCode: string | undefined, retryable = false;
    let summary = directive.tool === "web_search" ? "Searched the web" : "Read a web page";
    try {
      signal?.throwIfAborted();
      const config = retrievalConfig();
      if (!config.enabled || !config.apiKey) throw new RetrievalError("web_unavailable", "Web retrieval is not configured.");
      if (!owner || !turnId) throw new RetrievalError("not_found", "Owned execution not found.");
      const backend = new FirecrawlBackend(config.apiKey);
      const retrieval = this.retrieval ?? new WebRetrieval({ search: backend, read: backend });
      response = await retrieval.execute(directive.tool, directive.args, { owner, threadId, turnId, callId: directive.callId }, signal);
      signal?.throwIfAborted();
    } catch (error) {
      signal?.throwIfAborted();
      errorCode = error instanceof RetrievalError ? error.code : "web_retrieval_failed";
      summary = error instanceof RetrievalError ? error.message : "Web retrieval is temporarily unavailable.";
      retryable = error instanceof RetrievalError && error.retryable;
      response = { version: 1, error: errorCode, message: summary, retryable };
    }
    // Arguments are already recorded on the tool-call event. Bound their copy
    // here as malformed model inputs must not bypass the result byte limit.
    const args = Buffer.byteLength(JSON.stringify(directive.args)) <= 6000 ? directive.args : {};
    this.report({ tool: directive.tool, backend: response.backend ?? "firecrawl",
      status: errorCode ?? "ok", duration_ms: Date.now() - started,
      output_bytes: Buffer.byteLength(JSON.stringify(response)) });
    return { directive, args, summary, outputTruncationReason: null,
      result: { kind: "web_retrieval", ok: !errorCode, error: errorCode, retryable },
      payload: { tool: directive.tool, call_id: directive.callId, args, summary, ...response, kind: "web_retrieval", ok: !errorCode } };
  }
}
