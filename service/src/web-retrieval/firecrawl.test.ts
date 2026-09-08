import assert from "node:assert/strict";
import { test } from "node:test";
import { FirecrawlBackend } from "./firecrawl.js";
import { parseInput, publicUrl, RetrievalError } from "./contracts.js";

const context = { owner: "test", threadId: "test", turnId: "test", callId: "test" };
const response = (data: unknown) => Response.json({ success: true, data });
test("URL and argument policy rejects local addresses and preserves defaults", () => {
  for (const url of ["file:///etc/passwd", "http://127.1", "http://2130706433", "http://[::1]", "https://foo.local", "https://localhost", "https://a:b@google.com", "https://google.com:5173"])
    assert.throws(() => publicUrl(url), RetrievalError);
  assert.equal(publicUrl("https://docs.firecrawl.dev/a#section"), "https://docs.firecrawl.dev/a");
  assert.deepEqual(parseInput("web_search", { query: " hello ", limit: null }), { query: "hello", limit: 5 });
  assert.throws(() => parseInput("web_read", { url_or_reference: "https://google.com", length: 16001 }), RetrievalError);
});
test("search maps filters without scraping, filters local results and bounds snippets", async () => {
  const backend = new FirecrawlBackend("secret", async (url, options) => {
    assert.equal(url, "https://api.firecrawl.dev/v2/search");
    const body = JSON.parse(options!.body as string);
    assert.deepEqual(body.includeDomains, ["docs.firecrawl.dev"]);
    assert.equal(body.tbs, "qdr:d7");
    assert.equal(body.scrapeOptions, undefined);
    return response({ web: [{ url: "http://localhost" }, { url: "https://docs.firecrawl.dev", description: "🙂".repeat(1000) }] });
  });
  const results = await backend.search({ query: "api", limit: 5, domains: ["docs.firecrawl.dev"], recency_days: 7 }, context);
  assert.equal(results.length, 1);
  assert.equal(Buffer.byteLength(results[0].snippet), 800);
});
test("read requests fresh Markdown and bounds immutable snapshot", async () => {
  const backend = new FirecrawlBackend("secret", async (_, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(body.maxAge, 0); assert.deepEqual(body.parsers, []);
    return response({ markdown: "🙂".repeat(100000), metadata: { title: "Title", url: "https://docs.firecrawl.dev/" } });
  });
  const page = await backend.read("https://docs.firecrawl.dev/", context);
  assert.equal(Buffer.byteLength(page.text), 262144);
  assert.equal(page.truncated, true); assert.equal(page.freshness, "origin_requested");
});
test("empty, malformed, failed and oversized responses are explicit and sanitized", async () => {
  assert.deepEqual(await new FirecrawlBackend("secret", async () => response({ web: [] })).search({ query: "q", limit: 5 }, context), []);
  for (const [reply, code] of [
    [() => response({}), "invalid_response"],
    [() => new Response("secret-provider-detail", { status: 429 }), "rate_limited"],
    [() => new Response("secret-provider-detail", { status: 503 }), "provider_unavailable"],
    [() => new Response("x".repeat(2097153)), "response_too_large"],
  ] as const) {
    await assert.rejects(new FirecrawlBackend("secret", async () => reply()).search({ query: "q", limit: 5 }, context),
      (error: unknown) => error instanceof RetrievalError && error.code === code && !error.message.includes("secret"));
  }
});
test("abort propagates, with no automatic retry", async () => {
  const controller = new AbortController(); let calls = 0;
  const backend = new FirecrawlBackend("secret", async (_, options) => {
    calls++; controller.abort(); options!.signal!.throwIfAborted(); throw new Error("unreachable");
  });
  await assert.rejects(backend.search({ query: "q", limit: 5 }, context, controller.signal));
  assert.equal(calls, 1);
});
