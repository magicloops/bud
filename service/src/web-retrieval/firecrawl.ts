import { RetrievalError, publicUrl, truncateBytes, type SearchBackend, type ReadBackend,
  type SearchInput, type RetrievalContext, type Page, type SearchResult } from "./contracts.js";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export class FirecrawlBackend implements SearchBackend, ReadBackend {
  readonly name = "firecrawl";
  constructor(private readonly apiKey: string, private readonly request: typeof fetch = fetch) {}

  private async post(operation: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timeout = AbortSignal.timeout(operation === "search" ? 30000 : 45000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.request(`https://api.firecrawl.dev/v2/${operation}`, {
        method: "POST", redirect: "error", signal: combined,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new RetrievalError(response.status === 429 ? "rate_limited" : "provider_unavailable",
          response.status === 429 ? "Web retrieval is rate limited." : "Web retrieval provider is unavailable.", response.status >= 500 || response.status === 429);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new RetrievalError("invalid_response", "Web provider returned no response.");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new RetrievalError("response_too_large", "Web provider response exceeded the size limit.");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const value = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (value.success !== true) throw new RetrievalError("extraction_failed", "The provider could not retrieve this content.");
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw new RetrievalError("timeout", "Web retrieval timed out; remote billing may still apply.", true);
      if (error instanceof RetrievalError) throw error;
      throw new RetrievalError("provider_unavailable", "Web retrieval failed; no automatic retry was made.", true);
    }
  }

  async search(input: SearchInput, _context: RetrievalContext, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await this.post("search", { query: input.query, limit: input.limit,
      sources: ["web"], ...(input.domains?.length ? { includeDomains: input.domains } : {}),
      ...(input.recency_days ? { tbs: `qdr:d${input.recency_days}` } : {}), timeout: 25000 }, signal);
    const results = record(response.data).web;
    if (!Array.isArray(results)) throw new RetrievalError("invalid_response", "Web provider returned invalid search results.");
    return results.slice(0, input.limit).flatMap(value => {
      const item = record(value);
      if (typeof item.url !== "string") return [];
      try {
        const url = publicUrl(item.url);
        if (url.length > 4096) return [];
        return [{ url, title: truncateBytes(typeof item.title === "string" ? item.title : url, 300),
          snippet: truncateBytes(typeof item.description === "string" ? item.description : "", 800) }];
      } catch { return []; }
    });
  }

  async read(input: string, _context: RetrievalContext, signal?: AbortSignal): Promise<Page> {
    const url = publicUrl(input);
    const response = await this.post("scrape", { url, formats: ["markdown"], onlyMainContent: true,
      parsers: [], maxAge: 0, timeout: 40000 }, signal);
    const data = record(response.data), metadata = record(data.metadata);
    if (typeof metadata.statusCode === "number" && metadata.statusCode >= 400 || typeof data.markdown !== "string" || !data.markdown.trim())
      throw new RetrievalError("extraction_failed", "The page did not return readable content.");
    const finalUrl = typeof metadata.url === "string" ? publicUrl(metadata.url) : url;
    if (finalUrl.length > 4096) throw new RetrievalError("invalid_response", "The page URL exceeded the size limit.");
    let text = truncateBytes(data.markdown, 256 * 1024);
    // JSON escaping can expand control-heavy text beyond the storage budget.
    while (Buffer.byteLength(JSON.stringify(text)) > 480000) text = Array.from(text).slice(0, Math.floor(Array.from(text).length * 0.9)).join("");
    return { url: finalUrl, title: truncateBytes(typeof metadata.title === "string" ? metadata.title : url, 300),
      text, fetched_at: new Date().toISOString(), freshness: "origin_requested", truncated: text !== data.markdown };
  }
}
