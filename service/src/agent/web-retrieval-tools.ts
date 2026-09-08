import type { CanonicalTool } from "../llm/index.js";

export const WEB_CANONICAL_TOOLS: CanonicalTool[] = [
  { name: "web_search", description: "Search the public web for current information. Returns snippets and thread-scoped references; use web_read to verify a source.",
    parameters: { type: "object", properties: {
      query: { type: "string", minLength: 1, maxLength: 2000 },
      domains: { type: "array", maxItems: 10, items: { type: "string" }, description: "Optional domains to include, e.g. docs.firecrawl.dev." },
      recency_days: { type: "integer", minimum: 1, maximum: 365 },
      limit: { type: "integer", minimum: 1, maximum: 10, description: "Defaults to 5." },
    }, required: ["query"], additionalProperties: false } },
  { name: "web_read", description: "Read a public HTTP(S) page or a web_search result reference. Returns a saved page reference for stable pagination within this thread (7 days). Cite the returned URL with a normal Markdown link. Not a browser or a way to access local/private/authenticated apps.",
    parameters: { type: "object", properties: {
      url_or_reference: { type: "string", maxLength: 4096 },
      start: { type: "integer", minimum: 0, maximum: 262144, description: "Unicode code-point offset; default 0. Use next_start with the saved page reference." },
      length: { type: "integer", minimum: 1, maximum: 16000, description: "Maximum code points; default 8000. Output may be shortened to fit its byte budget." },
    }, required: ["url_or_reference"], additionalProperties: false } },
];
