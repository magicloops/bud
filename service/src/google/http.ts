import { GoogleError, GoogleHttpError } from "./config.js";

/** Fixed Google endpoints only; no redirects, automatic retries or model URLs. */
export function googleFetch(base: typeof fetch = fetch, signal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const allowed = url.origin === "https://oauth2.googleapis.com" && url.pathname === "/token" ||
      url.origin === "https://openidconnect.googleapis.com" && url.pathname === "/v1/userinfo" ||
      url.origin === "https://www.googleapis.com" && (url.pathname.startsWith("/calendar/v3/") ||
        url.pathname.startsWith("/drive/v3/") || url.pathname.startsWith("/upload/drive/v3/")) ||
      url.origin === "https://gmail.googleapis.com" && url.pathname.startsWith("/gmail/v1/users/me/");
    if (!allowed || url.username || url.password || url.hash) throw new GoogleError("google_destination_denied");
    const request = new Request(input, init);
    if (request.body && (await request.clone().arrayBuffer()).byteLength > 64 * 1024) {
      throw new GoogleError("google_request_too_large");
    }
    const response = await base(request, { redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]) });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel(); throw new GoogleError("google_redirect_denied");
    }
    if (!response.body) return response;
    if (Number(response.headers.get("content-length")) > 1024 * 1024) {
      await response.body.cancel().catch(() => {});
      if (!response.ok) return new Response(null, { status: response.status, headers: response.headers });
      throw new GoogleError("google_response_too_large");
    }
    let bytes = 0;
    return new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > 1024 * 1024) throw new GoogleError("google_response_too_large");
        controller.enqueue(chunk);
      },
    })), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function googleJson(fetcher: typeof fetch, url: string, token: string,
  init?: RequestInit, responseMode: "json" | "text" = "json"): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", responseMode === "text" ? "text/plain, text/csv, text/html, application/json" : "application/json");
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetcher(url, { ...init, headers });
  if (!response.ok) {
    // Read only fixed reason codes. Provider messages, links and metadata can
    // contain private data and must not enter errors or model evidence.
    const body: unknown = response.status === 403 ? await response.json().catch(() => null) : null;
    if (response.status !== 403) await response.body?.cancel().catch(() => {});
    throw new GoogleHttpError(response.status, serviceDisabled(body) ? "service_disabled" : undefined,
      headers.has("If-Match") && new URL(url).pathname.startsWith("/calendar/v3/"));
  }
  if (response.status === 204) return { deleted: true };
  if (responseMode === "text") {
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^(text\/|application\/(json|xml)(;|$))/.test(contentType)) {
      await response.body?.cancel(); throw new GoogleError("google_binary_content_requires_download");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    return { content: bytes.subarray(0, 24000).toString("utf8"), content_type: contentType,
      truncated: bytes.length > 24000, bytes: bytes.length };
  }
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleError("google_invalid_response");
  return { ...value as Record<string, unknown>, ...(response.headers.get("etag") ? { etag: response.headers.get("etag") } : {}) };
}

function serviceDisabled(body: unknown): boolean {
  if (!body || typeof body !== "object" || !("error" in body)) return false;
  const error = body.error;
  if (!error || typeof error !== "object") return false;
  const groups = ["errors" in error ? error.errors : null, "details" in error ? error.details : null];
  return groups.some(entries => Array.isArray(entries) && entries.some(entry => entry &&
    typeof entry === "object" && (entry.reason === "accessNotConfigured" || entry.reason === "SERVICE_DISABLED")));
}
