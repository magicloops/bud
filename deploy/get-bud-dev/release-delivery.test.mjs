import assert from "node:assert/strict";
import test from "node:test";
import { createGetBudDevWorker } from "./worker.js";
import { releasePath } from "./release-delivery.js";

const pathname = "/releases/v0.1.25/bud-aarch64-apple-darwin.tar.gz";
const manifestPath = "/releases/v0.1.25/manifest.json";
const bytes = new TextEncoder().encode("0123456789");
const etag = '"archive-etag"';
const uploaded = new Date("2026-10-10T00:00:00Z");
function request(path = pathname, headers = {}, method = "GET") {
  return new Request(`https://get.bud.dev${path}`, { headers, method });
}
function fixture({ cacheEnabled = true } = {}) {
  const objects = new Map([[pathname.slice(1), bytes], [manifestPath.slice(1), new TextEncoder().encode('{"version":"v0.1.25"}')]]);
  const reads = [], heads = [], puts = [], matches = [], logs = [], pending = [];
  const cachedObjects = new Map();
  const metadata = (key) => ({ size: objects.get(key).length, etag: key.endsWith("manifest.json") ? "manifest-etag" : "archive-etag",
    httpEtag: key.endsWith("manifest.json") ? '"manifest-etag"' : etag, uploaded,
    writeHttpMetadata(headers) { headers.set("cache-control", "wrong"); headers.set("content-type", "wrong"); } });
  const bucket = {
    async head(key) { heads.push(key); return objects.has(key) ? metadata(key) : null; },
    async get(key, options = {}) {
      reads.push({ key, options });
      if (!objects.has(key)) return null;
      const object = metadata(key);
      if (options.onlyIf?.etagMatches !== object.etag) return object;
      const data = options.range ? objects.get(key).slice(options.range.offset, options.range.offset + options.range.length) : objects.get(key);
      return { ...object, body: new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } }) };
    },
  };
  const cache = {
    async match(req) {
      matches.push(req);
      const entry = cachedObjects.get(req.url);
      if (!entry) return;
      const headers = new Headers(entry.headers);
      const range = req.headers.get("range");
      if (range) {
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(range);
        headers.set("content-range", `bytes ${start}-${end}/${entry.bytes.length}`);
        const data = entry.bytes.slice(Number(start), Number(end) + 1);
        headers.set("content-length", String(data.length));
        return new Response(data, { status: 206, headers });
      }
      return new Response(entry.bytes, { status: entry.status, headers });
    },
    async put(req, res) {
      assert.equal(req.method, "GET"); assert.equal(res.status, 200);
      assert.equal(new URL(req.url).search, ""); assert.ok(!res.headers.has("content-range"));
      puts.push(req.url);
      cachedObjects.set(req.url, { status: res.status, headers: new Headers(res.headers), bytes: new Uint8Array(await res.arrayBuffer()) });
    },
  };
  const context = { waitUntil(promise) { pending.push(promise); } };
  const worker = createGetBudDevWorker({ releases: bucket, cache: cacheEnabled ? cache : null, log: (event) => logs.push(event) });
  return { worker, bucket, cache, objects, cachedObjects, reads, heads, puts, matches, logs, pending, context,
    async fetch(req = request()) { return worker.fetch(req, context); },
    async warm() { const res = await worker.fetch(request(), context); await res.arrayBuffer(); await Promise.all(pending); reads.length = 0; heads.length = 0; return res; },
  };
}

test("cold archive streams R2 bytes, caches full response with canonical key and metadata", async () => {
  const f = fixture();
  const res = await f.fetch(request(`${pathname}?token=never-log-this`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-bud-release-cache"), "MISS");
  assert.equal(res.headers.get("x-bud-release-origin"), "r2");
  assert.equal(res.headers.get("content-length"), "10");
  assert.equal(res.headers.get("content-type"), "application/gzip");
  assert.match(res.headers.get("content-disposition"), /attachment; filename="bud-aarch64-apple-darwin.tar.gz"/);
  assert.equal(res.headers.get("etag"), etag);
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("cache-control"), "public, max-age=31536000, immutable");
  assert.equal(await res.text(), "0123456789");
  await Promise.all(f.pending);
  assert.equal(f.puts.length, 1);
  assert.ok(!JSON.stringify(f.logs).includes("never-log-this"));
  const hit = await f.fetch(request(`${pathname}?unrelated=1`));
  assert.equal(hit.headers.get("x-bud-release-cache"), "HIT");
  assert.equal(await hit.text(), "0123456789");
  assert.equal(f.reads.length, 1);
});

test("all four supported archives and historical manifests use R2 independently of stable", async () => {
  const f = fixture({ cacheEnabled: false });
  for (const target of ["aarch64-apple-darwin", "x86_64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]) {
    const path = `/releases/v0.1.25/bud-${target}.tar.gz`;
    f.objects.set(path.slice(1), bytes);
    assert.equal(await (await f.fetch(request(path))).text(), "0123456789");
  }
  f.objects.set("releases/v0.1.24/manifest.json", new TextEncoder().encode('{"version":"v0.1.24"}'));
  const old = await f.fetch(request("/releases/v0.1.24/manifest.json"));
  assert.equal(old.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await old.json(), { version: "v0.1.24" });
  assert.ok(!old.headers.has("location"));
});

test("HEAD ignores ranges and never reads or caches an origin body, cold and warm", async () => {
  const f = fixture();
  for (const warmed of [false, true]) {
    if (warmed) await f.warm();
    const puts = f.puts.length;
    const res = await f.fetch(request(pathname, { range: "bytes=1-2" }, "HEAD"));
    assert.equal(res.status, 200); assert.equal(res.headers.get("content-length"), "10");
    assert.equal(res.headers.get("content-range"), null); assert.equal(await res.text(), "");
    assert.equal(f.reads.length, 0); assert.equal(f.puts.length, puts);
  }
});

test("closed, open, suffix, clipped and huge ranges agree on cold R2 and warm cache", async () => {
  for (const warm of [false, true]) {
    const f = fixture();
    if (warm) await f.warm();
    for (const [value, content, contentRange] of [
      ["bytes=2-4", "234", "bytes 2-4/10"], ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"], ["bytes=8-999", "89", "bytes 8-9/10"],
      ["bytes=-999", "0123456789", "bytes 0-9/10"],
      ["bytes=9-999999999999999999999999999999999999999", "9", "bytes 9-9/10"],
    ]) {
      const res = await f.fetch(request(pathname, { range: value }));
      assert.equal(res.status, 206); assert.equal(res.headers.get("content-range"), contentRange);
      assert.equal(res.headers.get("content-length"), String(content.length)); assert.equal(await res.text(), content);
      assert.equal(res.headers.get("x-bud-release-cache"), warm ? "HIT" : "MISS");
    }
    assert.equal(f.puts.length, warm ? 1 : 0);
    assert.equal(f.reads.length, warm ? 0 : 6);
    for (const { options } of f.reads) assert.ok(options.range);
  }
});

test("unsatisfiable ranges return uncached 416, malformed/multiple ranges return complete 200", async () => {
  for (const warm of [false, true]) {
    const f = fixture(); if (warm) await f.warm();
    for (const range of ["bytes=10-", "bytes=-0", "bytes=5-2", "bytes=999999999999999999999999999999999999999-"]) {
      const res = await f.fetch(request(pathname, { range }));
      assert.equal(res.status, 416); assert.equal(res.headers.get("content-range"), "bytes */10");
      assert.equal(res.headers.get("cache-control"), "no-store"); assert.equal(await res.text(), "");
    }
    assert.equal(f.reads.length, 0);
    for (const range of ["bytes=1-2,5-6", "not-a-range", "bytes=-", "items=0-1"]) {
      const res = await f.fetch(request(pathname, { range }));
      assert.equal(res.status, 200); assert.equal(await res.text(), "0123456789");
    }
    await Promise.all(f.pending);
  }
});

test("If-None-Match takes precedence with lists, weak tags, wildcard and HEAD", async () => {
  for (const warm of [false, true]) {
    const f = fixture(); if (warm) await f.warm();
    for (const tag of [etag, `W/${etag}`, `"other", W/${etag}`, "*"]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await f.fetch(request(pathname, { "if-none-match": tag, range: "bytes=99-" }, method));
        assert.equal(res.status, 304); assert.equal(res.headers.get("content-length"), null); assert.equal(await res.text(), "");
      }
    }
    assert.equal(f.reads.length, 0);
    const res = await f.fetch(request(pathname, { "if-none-match": '"other"' }));
    assert.equal(res.status, 200); assert.equal(await res.text(), "0123456789");
    await Promise.all(f.pending);
  }
});

test("If-Range requires a matching strong ETag or exact Last-Modified date", async () => {
  for (const warm of [false, true]) {
    const f = fixture(); if (warm) await f.warm();
    for (const [tag, status] of [[etag, 206], [uploaded.toUTCString(), 206], [`W/${etag}`, 200], ['"other"', 200], ["invalid", 200], ["Sat, 10 Oct 2026 01:00:00 GMT", 200]]) {
      const res = await f.fetch(request(pathname, { "if-range": tag, range: "bytes=1-2" }));
      assert.equal(res.status, status); assert.equal(await res.text(), status === 206 ? "12" : "0123456789");
    }
    await Promise.all(f.pending);
  }
});

test("404/503 are no-store, unpublished archives unavailable and no GitHub fallback", async () => {
  const f = fixture();
  f.objects.delete(manifestPath.slice(1));
  let res = await f.fetch(); assert.equal(res.status, 404); assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(f.reads.length, 0); assert.equal(f.puts.length, 0);
  for (const fail of ["head", "get"]) {
    const g = fixture(); g.bucket[fail] = async () => { throw new Error("credential-details-must-not-leak"); };
    res = await g.fetch(); assert.equal(res.status, 503); assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(g.logs).includes("credential-details")); assert.equal(g.puts.length, 0);
  }
  const unbound = createGetBudDevWorker();
  res = await unbound.fetch(request()); assert.equal(res.status, 503); assert.ok(!res.headers.has("location"));
  res = await unbound.fetch(request(pathname, {}, "HEAD")); assert.equal(await res.text(), "");
});

test("cache errors never fail delivery; failed ranged cache falls back to bounded R2 reads", async () => {
  for (const operation of ["match", "put"]) {
    const f = fixture(); f.cache[operation] = async () => { throw new Error("cache failed"); };
    const res = await f.fetch(); assert.equal(res.status, 200); assert.equal(await res.text(), "0123456789");
    await Promise.all(f.pending);
    assert.ok(f.logs.some(({ event }) => event === `cache_${operation === "match" ? "read" : "write"}_failed`));
  }
  const f = fixture(); await f.warm(); const match = f.cache.match;
  f.cache.match = async (req) => req.headers.has("range") ? undefined : match(req);
  const res = await f.fetch(request(pathname, { range: "bytes=1-2" }));
  assert.equal(res.status, 206); assert.equal(res.headers.get("x-bud-release-cache"), "BYPASS");
  assert.equal(await res.text(), "12"); assert.deepEqual(f.reads[0].options.range, { offset: 1, length: 2 });
});

test("obsolete redirects are ignored and replaced only with a complete R2 representation", async () => {
  const f = fixture(); f.cachedObjects.set(request().url, { status: 302, bytes: new Uint8Array(), headers: { location: "https://github.com/old", "content-length": "0" } });
  const res = await f.fetch(); assert.equal(res.status, 200); assert.equal(await res.text(), "0123456789");
  await Promise.all(f.pending); assert.equal(f.cachedObjects.get(request().url).status, 200);
});

test("stream returned before body completion and cache failure does not block first byte", async () => {
  const f = fixture();
  let controller;
  const get = f.bucket.get;
  f.bucket.get = async (key, options) => ({ ...await get(key, options), body: new ReadableStream({ start(c) { controller = c; } }) });
  f.cache.put = () => Promise.reject(new Error("fail before stream finishes"));
  const res = await f.fetch();
  assert.equal(res.status, 200);
  const reader = res.body.getReader(); controller.enqueue(new TextEncoder().encode("01234"));
  assert.equal(new TextDecoder().decode((await reader.read()).value), "01234");
  controller.enqueue(new TextEncoder().encode("56789")); controller.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "56789");
  assert.equal((await reader.read()).done, true); await Promise.all(f.pending);
});

test("origin deletion/changed ETag between HEAD and GET cannot publish or cache misleading bytes", async () => {
  for (const result of [null, { httpEtag: '"changed"', size: 10 }]) {
    const f = fixture(); f.bucket.get = async () => result;
    const res = await f.fetch(); assert.equal(res.status, result ? 503 : 404); assert.equal(f.puts.length, 0);
  }
});

test("strict route allowlist rejects encoded/unknown keys and unsafe versions before storage reads", async () => {
  const f = fixture();
  for (const path of ["/releases/vwat/manifest.json", "/releases/v1.2.3%2Fsecret/manifest.json", "/releases/v1.2.3/bud-unknown.tar.gz", "/releases/v1.2.3/list", "/releases/v1.2.3%20/manifest.json", "/_release-assets.json"]) {
    assert.equal(releasePath(path), null); const res = await f.fetch(request(path)); assert.equal(res.status, 404);
  }
  assert.ok(releasePath("/releases/v0.0.1-install-canary.7/manifest.json"));
  assert.equal(f.heads.length, 0); assert.equal(f.reads.length, 0);
  const res = await f.fetch(request(pathname, {}, "POST")); assert.equal(res.status, 405);
});

test("stalled cache writer is abandoned with bounded buffering while full client download completes", async () => {
  const f = fixture();
  const total = 2 * 1024 * 1024;
  f.objects.set(pathname.slice(1), new Uint8Array(total));
  const get = f.bucket.get;
  let produced = 0;
  f.bucket.get = async (key, options) => ({ ...await get(key, options), body: new ReadableStream({
    pull(controller) {
      if (produced === total) { controller.close(); return; }
      const data = new Uint8Array(64 * 1024).fill(produced / (64 * 1024));
      produced += data.length; controller.enqueue(data);
    },
  }) });
  let resume;
  const wait = new Promise((resolve) => { resume = resolve; });
  f.cache.put = async (_req, res) => { await wait; return res.arrayBuffer(); };
  const res = await f.fetch();
  const received = new Uint8Array(await res.arrayBuffer());
  assert.equal(received.length, total); assert.equal(received[0], 0); assert.equal(received.at(-1), 31);
  resume(); await Promise.all(f.pending);
  assert.ok(f.logs.some(({ event }) => event === "cache_write_failed"));
  assert.equal(f.cachedObjects.size, 0);
});

test("origin body interruption fails the body and cannot leave a partial cached representation", async () => {
  const f = fixture();
  const get = f.bucket.get;
  let sent = false;
  f.bucket.get = async (key, options) => ({ ...await get(key, options), body: new ReadableStream({
    pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode("01")); }
      else controller.error(new Error("origin body interrupted"));
    },
  }) });
  const res = await f.fetch();
  await assert.rejects(() => res.arrayBuffer(), /origin body interrupted/);
  await Promise.all(f.pending);
  assert.equal(f.cachedObjects.size, 0);
});
