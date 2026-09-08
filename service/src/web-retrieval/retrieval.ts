import { createHash } from "node:crypto";
import { RetrievalError, parseInput, publicUrl, type WebTool, type SearchInput, type ReadInput,
  type Page, type SearchResult, type RetrievalBackends, type RetrievalContext } from "./contracts.js";
import { RetrievalRepository, type Artifact } from "./repository.js";

export class WebRetrieval {
  constructor(private readonly backends: RetrievalBackends, private readonly repository = new RetrievalRepository()) {}

  async execute(tool: WebTool, args: Record<string, unknown>, context: RetrievalContext, signal?: AbortSignal): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const input = parseInput(tool, args);
    const initial = await this.repository.authorize(context);
    let artifact: Artifact | undefined, url: string | undefined;
    if (tool === "web_read") {
      const read = input as ReadInput;
      const match = /^(wr_[0-9A-HJKMNP-TV-Z]{26})(?::([0-9]))?$/.exec(read.url_or_reference);
      if (match) {
        const saved = await this.repository.load(context, match[1]);
        if (saved.operation === "read" && match[2] === undefined) artifact = saved;
        else if (saved.operation === "search" && match[2] !== undefined) {
          const results = saved.payload.results as SearchResult[];
          url = results[Number(match[2])]?.url;
          if (!url) throw new RetrievalError("reference_unavailable", "Search result reference not found.");
        } else throw new RetrievalError("reference_unavailable", "Use a page or individual search-result reference.");
      } else url = publicUrl(read.url_or_reference);
    }
    if (!artifact) {
      const backend = tool === "web_search" ? this.backends.search : this.backends.read;
      const fingerprint = createHash("sha256").update(JSON.stringify([tool, input])).digest("hex");
      const reservation = await this.repository.reserve(context, fingerprint, backend.name);
      artifact = reservation.saved;
      if (!artifact) {
        try {
          signal?.throwIfAborted();
          const payload = tool === "web_search"
            ? { results: await this.backends.search.search(input as SearchInput, context, signal), retrieved_at: new Date().toISOString() }
            : { ...await this.backends.read.read(url!, context, signal), requested_url: url };
          signal?.throwIfAborted();
          artifact = await this.repository.complete(context, reservation.id, reservation.authority,
            tool === "web_search" ? "search" : "read", backend.name, payload, signal);
        } catch (error) {
          await this.repository.fail(context, reservation.id).catch(() => {});
          throw error;
        }
      }
    }
    const current = await this.repository.authorize(context);
    signal?.throwIfAborted();
    if (initial.binding !== current.binding) throw new RetrievalError("execution_changed", "Execution changed during web retrieval.");
    const common = { version: 1, kind: "web_retrieval", ok: true, operation: artifact.operation,
      backend: artifact.backend, expires_at: artifact.expiresAt.toISOString() };
    if (tool === "web_search") {
      const results = (artifact.payload.results as SearchResult[]).map((result, index) => ({ ...result, reference_id: `${artifact.id}:${index}` }));
      const output = { ...common, retrieved_at: artifact.payload.retrieved_at, results, truncated: false };
      while (Buffer.byteLength(JSON.stringify(output)) > 24000 && results.length) {
        results.pop(); output.truncated = true;
      }
      return output;
    }
    const page = artifact.payload as Page & { requested_url: string };
    const { start, length } = input as ReadInput, chars = Array.from(page.text);
    let end = Math.min(chars.length, start + length);
    if (start > chars.length) throw new RetrievalError("invalid_offset", "Offset is beyond the saved page.");
    const build = () => ({ ...common, reference_id: artifact!.id, url: page.url, requested_url: page.requested_url,
      title: page.title, fetched_at: page.fetched_at, freshness: page.freshness,
      text: chars.slice(start, end).join(""), start, end, next_start: end < chars.length ? end : null,
      truncated: page.truncated || end < chars.length, snapshot_truncated: page.truncated });
    while (Buffer.byteLength(JSON.stringify(build())) > 24000 && end > start) end--;
    return build();
  }
}
