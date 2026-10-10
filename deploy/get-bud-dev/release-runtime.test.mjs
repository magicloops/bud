import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Miniflare, Log, LogLevel } from "miniflare";

// Uses real workerd R2/Cache bindings in isolated temporary storage. No network
// fetches, production credentials, bucket provisioning, or deployed writes.
test("workerd streams a full archive and serves real cached ranges and conditionals", async (t) => {
  const mf = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("./worker.js", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
    compatibilityDate: "2026-05-30",
    r2Buckets: ["RELEASES"],
    r2Persist: false, cachePersist: false,
    bindings: { INSTALL_SCRIPT: "#!/bin/sh\necho fixture\n", STABLE_MANIFEST_JSON: JSON.stringify({ version: "v0.1.25" }) },
    outboundService: () => { throw new Error("unexpected outbound network fetch"); },
    log: new Log(LogLevel.ERROR),
  });
  t.after(() => mf.dispose());
  const bucket = await mf.getR2Bucket("RELEASES");
  const prefix = "releases/v0.1.25/";
  const name = "bud-aarch64-apple-darwin.tar.gz";
  const url = `https://get.bud.dev/${prefix}${name}`;
  // Larger than a typical frame/chunk, with deterministic byte evidence.
  const bytes = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await bucket.put(prefix + name, bytes);
  const unavailable = await mf.dispatchFetch(url);
  assert.equal(unavailable.status, 404); await unavailable.text();
  await bucket.put(prefix + "manifest.json", JSON.stringify({ version: "v0.1.25" }));
  const head = await mf.dispatchFetch(url, { method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), String(bytes.length));
  assert.equal(await head.text(), "");
  const coldRange = await mf.dispatchFetch(url, { headers: { range: "bytes=-4096" } });
  assert.equal(coldRange.status, 206);
  assert.equal(coldRange.headers.get("x-bud-release-cache"), "MISS");
  assert.deepEqual(Buffer.from(await coldRange.arrayBuffer()), bytes.subarray(-4096));
  const full = await mf.dispatchFetch(`${url}?ignored=1`);
  assert.equal(full.headers.get("content-length"), String(bytes.length));
  assert.equal(full.status, 200); assert.equal(full.headers.get("x-bud-release-cache"), "MISS");
  const sha = (data) => createHash("sha256").update(data).digest("hex");
  assert.equal(sha(Buffer.from(await full.arrayBuffer())), sha(bytes));
  // Cache writes use waitUntil; observe completion with a bounded condition,
  // not arbitrary sleeps. Drain the Miniflare proxy body: canceling it can
  // race the Node bridge writer cleanup and raise an unhandled rejection.
  const cache = (await mf.getCaches()).default;
  let cached;
  for (let attempt = 0; attempt < 20; attempt++) {
    cached = await cache.match(url);
    if (cached) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(cached, "full response must populate cache");
  assert.equal(cached.headers.get("content-length"), String(bytes.length));
  assert.equal(sha(Buffer.from(await cached.arrayBuffer())), sha(bytes));
  // Origin removal in this isolated fixture proves warm reads use cached bytes.
  await bucket.delete(prefix + name);
  for (const [range, start, end] of [["bytes=5-100", 5, 100], ["bytes=2093056-", bytes.length - 4096, bytes.length - 1], ["bytes=-4096", bytes.length - 4096, bytes.length - 1]]) {
    const res = await mf.dispatchFetch(url, { headers: { range } });
    assert.equal(res.status, 206); assert.equal(res.headers.get("x-bud-release-cache"), "HIT");
    assert.equal(res.headers.get("content-range"), `bytes ${start}-${end}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes.subarray(start, end + 1));
  }
  const conditional = await mf.dispatchFetch(url, { headers: { "if-none-match": `W/${head.headers.get("etag")}` } });
  assert.equal(conditional.status, 304); assert.equal(await conditional.text(), "");
  const staleRange = await mf.dispatchFetch(url, { headers: { range: "bytes=0-9", "if-range": '"old"' } });
  assert.equal(staleRange.status, 200); assert.equal(sha(Buffer.from(await staleRange.arrayBuffer())), sha(bytes));
  const unsatisfiable = await mf.dispatchFetch(url, { headers: { range: `bytes=${bytes.length}-` } });
  assert.equal(unsatisfiable.status, 416); assert.equal(unsatisfiable.headers.get("cache-control"), "no-store");
  const stable = await mf.dispatchFetch("https://get.bud.dev/releases/stable/manifest.json");
  assert.equal(stable.headers.get("cache-control"), "no-store"); assert.deepEqual(await stable.json(), { version: "v0.1.25" });
});
