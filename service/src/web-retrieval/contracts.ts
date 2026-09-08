import { z } from "zod";
import { isIP } from "node:net";

export const WEB_TOOLS = ["web_search", "web_read"] as const;
export type WebTool = typeof WEB_TOOLS[number];
export const isWebTool = (name: string): name is WebTool => WEB_TOOLS.includes(name as WebTool);
export class RetrievalError extends Error {
  constructor(public readonly code: string, message: string, public readonly retryable = false) { super(message); }
}
export function publicUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RetrievalError("invalid_url", "Provide a public HTTP(S) URL."); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // No IP literals in v1, including mapped IPv6 and alternate numeric forms.
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      isIP(host) || host.includes(":") || !host.includes(".") ||
      /(?:^|\.)(localhost|local|internal|lan|home|test|invalid|example)$/.test(host) ||
      (url.port && !["80", "443"].includes(url.port))) {
    throw new RetrievalError("invalid_url", "Only public HTTP(S) websites on standard ports are supported.");
  }
  url.hash = "";
  return url.toString();
}
const domain = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i)
  .refine(value => { try { publicUrl(`https://${value}`); return true; } catch { return false; } });
export const searchSchema = z.object({ query: z.string().trim().min(1).max(2000),
  domains: z.array(domain).max(10).optional(), recency_days: z.number().int().min(1).max(365).optional(),
  limit: z.number().int().min(1).max(10).default(5) }).strict();
export const readSchema = z.object({ url_or_reference: z.string().min(1).max(4096),
  start: z.number().int().min(0).max(262144).default(0), length: z.number().int().min(1).max(16000).default(8000) }).strict();
export function parseInput(tool: WebTool, args: Record<string, unknown>): SearchInput | ReadInput {
  const normalized = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
  const result = (tool === "web_search" ? searchSchema : readSchema).safeParse(normalized);
  if (!result.success) throw new RetrievalError("invalid_input", "Invalid web tool arguments; follow the tool schema.");
  return result.data;
}
export type SearchInput = z.infer<typeof searchSchema>;
export type ReadInput = z.infer<typeof readSchema>;
export type SearchResult = { url: string; title: string; snippet: string };
export type Page = { url: string; title: string; text: string; fetched_at: string;
  freshness: "origin_requested" | "provider_cache_possible"; truncated: boolean };
export type RetrievalContext = { owner: string; threadId: string; turnId: string; callId: string };
export interface SearchBackend { readonly name: string; search(input: SearchInput, context: RetrievalContext, signal?: AbortSignal): Promise<SearchResult[]> }
export interface ReadBackend { readonly name: string; read(url: string, context: RetrievalContext, signal?: AbortSignal): Promise<Page> }
export type RetrievalBackends = { search: SearchBackend; read: ReadBackend };

export function truncateBytes(text: string, max: number): string {
  let size = 0, result = "";
  for (const char of text.replaceAll("\u0000", "")) {
    const bytes = Buffer.byteLength(char);
    if (size + bytes > max) break;
    size += bytes; result += char;
  }
  return result;
}
