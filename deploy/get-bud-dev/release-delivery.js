const IMMUTABLE = "public, max-age=31536000, immutable";
const VERSION = "v\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?";
const RELEASE_PATH = new RegExp(`^/releases/(${VERSION})/(manifest\\.json|bud-(?:aarch64-apple-darwin|x86_64-apple-darwin|x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu)\\.tar\\.gz)$`);

export function releasePath(pathname) {
  const match = RELEASE_PATH.exec(pathname);
  if (!match || match[1].length > 128) return null;
  return { key: pathname.slice(1), manifestKey: `releases/${match[1]}/manifest.json`, name: match[2] };
}

function discard(body) {
  // Never wait for a cloned/tee stream's other consumer to finish.
  if (body) void body.cancel().catch(() => {});
}

function notModified(value, etag) {
  return value?.split(",").some((tag) => tag.trim() === "*" || tag.trim().replace(/^W\//, "") === etag);
}

function rangeFor(request, headers, size) {
  if (request.method === "HEAD") return null;
  const value = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  if (ifRange && ifRange !== headers.get("etag") &&
      (!headers.has("last-modified") || !Number.isFinite(Date.parse(ifRange)) ||
       Date.parse(ifRange) !== Date.parse(headers.get("last-modified")))) return null;
  // Ignore malformed and multi-range requests, serving the full representation.
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value ?? "");
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return false;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return false;
  return { offset: start, length: end - start + 1 };
}

function objectHeaders(object, name) {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", name === "manifest.json" ? "application/json; charset=utf-8" : "application/gzip");
  if (name !== "manifest.json") headers.set("content-disposition", `attachment; filename="${name}"`);
  // Byte ranges refer to stored archive bytes, never a content-encoded variant.
  headers.delete("content-encoding");
  headers.set("content-length", String(object.size));
  headers.set("etag", object.httpEtag);
  headers.set("last-modified", object.uploaded.toUTCString());
  headers.set("cache-control", IMMUTABLE);
  headers.set("accept-ranges", "bytes");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

// The client drives origin reads. A slow cache writer gets a bounded queue and
// is abandoned instead of buffering the rest of the archive or blocking download.
function sizedBody(body, size) {
  // Workers use the native length-aware stream; Node fixture tests lack this
  // Cloudflare API. It preserves Content-Length and Cache API range support.
  return globalThis.FixedLengthStream ? body.pipeThrough(new FixedLengthStream(size)) : body;
}

function cacheAlongside(body) {
  const reader = body.getReader();
  let cacheController;
  let caching = true;
  const cacheBody = new ReadableStream({
    start(controller) { cacheController = controller; },
    cancel() { caching = false; },
  }, { highWaterMark: 256 * 1024, size: (chunk) => chunk.byteLength });
  function stopCache(error) {
    if (caching) { caching = false; cacheController.error(error); }
  }
  const clientBody = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          if (caching) { caching = false; cacheController.close(); }
          reader.releaseLock();
          return;
        }
        if (caching) {
          if (value.byteLength > cacheController.desiredSize) stopCache(new Error("cache writer too slow"));
          else cacheController.enqueue(value);
        }
        controller.enqueue(value);
      } catch (error) {
        stopCache(error); controller.error(error); reader.releaseLock();
      }
    },
    cancel(reason) { stopCache(new Error("download canceled")); return reader.cancel(reason); },
  });
  return { clientBody, cacheBody };
}

export async function deliverRelease(request, route, { bucket, cache, context, log = () => {} }) {
  const url = new URL(request.url);
  url.search = "";
  const cacheKey = new Request(url, { method: "GET" });
  let cacheStatus = cache ? "MISS" : "BYPASS";
  const report = (event, extra = {}) => log({ component: "release_delivery", event, path: url.pathname, ...extra });
  function response(body, status, headers = new Headers()) {
    headers = new Headers(headers);
    headers.set("x-bud-release-origin", "r2");
    headers.set("x-bud-release-cache", cacheStatus);
    report("response", { method: request.method, status_code: status, cache: cacheStatus });
    return new Response(request.method === "HEAD" ? null : body, { status, headers });
  }
  function error(status) {
    return response(status === 404 ? "not found\n" : "release storage unavailable\n", status,
      new Headers({ "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }));
  }
  try {
    let cached;
    if (cache) {
      try { cached = await cache.match(cacheKey); }
      catch { cacheStatus = "BYPASS"; report("cache_read_failed"); }
      // Ignore obsolete redirects or partial responses under the same key.
      if (cached && (cached.status !== 200 || !cached.headers.has("content-length"))) {
        discard(cached.body); cached = null;
      }
    }
    let object;
    let headers;
    if (cached) {
      cacheStatus = "HIT";
      headers = new Headers(cached.headers);
    } else {
      if (!bucket) { report("origin_unavailable"); return error(503); }
      // The manifest is the publisher's completion marker. No bucket listing.
      if (route.key !== route.manifestKey && !await bucket.head(route.manifestKey)) return error(404);
      object = await bucket.head(route.key);
      if (!object) return error(404);
      headers = objectHeaders(object, route.name);
    }
    if (notModified(request.headers.get("if-none-match"), headers.get("etag"))) {
      discard(cached?.body);
      headers.delete("content-length");
      return response(null, 304, headers);
    }
    const size = Number(headers.get("content-length"));
    const range = rangeFor(request, headers, size);
    if (range === false) {
      discard(cached?.body);
      headers.set("content-range", `bytes */${size}`);
      headers.set("content-length", "0");
      headers.set("cache-control", "no-store");
      return response(null, 416, headers);
    }
    if (request.method === "HEAD") {
      discard(cached?.body);
      return response(null, 200, headers);
    }
    if (cached && !range) return response(cached.body, 200, headers);
    if (cached && range) {
      discard(cached.body);
      try {
        const ranged = await cache.match(new Request(url, { headers: { range: `bytes=${range.offset}-${range.offset + range.length - 1}` } }));
        if (ranged?.status === 206 && ranged.headers.get("content-range") === `bytes ${range.offset}-${range.offset + range.length - 1}/${size}` &&
            Number(ranged.headers.get("content-length")) === range.length && ranged.headers.get("etag") === headers.get("etag")) {
          return response(ranged.body, 206, ranged.headers);
        }
        discard(ranged?.body);
      } catch { report("cache_range_failed"); }
      // Eviction/cache failure between lookups falls back to a bounded R2 read.
      cacheStatus = "BYPASS";
      if (!bucket) return error(503);
      object = await bucket.head(route.key);
      if (!object || object.httpEtag !== headers.get("etag") || object.size !== size) return error(503);
    }
    const stored = await bucket.get(route.key, {
      onlyIf: { etagMatches: object.etag },
      ...(range ? { range } : {}),
    });
    if (!stored) return error(404);
    if (!stored.body || stored.httpEtag !== object.httpEtag || stored.size !== size) {
      discard(stored.body); report("origin_changed"); return error(503);
    }
    if (range) {
      headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
      headers.set("content-length", String(range.length));
      return response(stored.body, 206, headers);
    }
    let body = stored.body;
    if (cache && context?.waitUntil && cacheStatus !== "BYPASS") {
      const streams = cacheAlongside(body);
      body = streams.clientBody;
      const copy = new Response(sizedBody(streams.cacheBody, size), { headers });
      // Only complete 200 representations are cached. Slow/failed cache writes
      // cannot delay the client or retain an unbounded clone of the body.
      context.waitUntil(Promise.resolve().then(() => cache.put(cacheKey, copy)).catch(() => {
        discard(copy.body); report("cache_write_failed");
      }));
    }
    return response(sizedBody(body, size), 200, headers);
  } catch {
    // R2 exceptions may include request details; log only a fixed event code.
    report("origin_read_failed");
    return error(503);
  }
}
