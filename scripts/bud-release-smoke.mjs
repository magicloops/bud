#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { validateMirrorManifest } from "./bud-release-mirror.mjs";

function requireR2(response, status, length) {
  assert.equal(response.status, status, "unexpected release status (redirects are forbidden)");
  assert.equal(response.headers.get("x-bud-release-origin"), "r2");
  assert.match(response.headers.get("cache-control") ?? "", /immutable/);
  assert.ok(["HIT", "MISS", "BYPASS"].includes(response.headers.get("x-bud-release-cache")));
  if (length !== undefined) assert.equal(response.headers.get("content-length"), String(length));
}

// Hash full transfers while retaining only the first and last 1 KiB for ranges.
async function readArchive(response, artifact) {
  requireR2(response, 200, artifact.size);
  const hash = createHash("sha256");
  let size = 0, first = Buffer.alloc(0), last = Buffer.alloc(0);
  for await (const value of response.body) {
    const chunk = Buffer.from(value);
    size += chunk.length;
    assert.ok(size <= artifact.size, "archive exceeds expected size");
    hash.update(chunk);
    if (first.length < 1024) first = Buffer.concat([first, chunk.subarray(0, 1024 - first.length)]);
    last = Buffer.from(Buffer.concat([last, chunk]).subarray(-1024));
  }
  assert.equal(size, artifact.size, "truncated archive");
  assert.equal(hash.digest("hex"), artifact.sha256, "archive checksum mismatch");
  return { first, last };
}

export async function smokeRelease({ manifestBytes, origin = "https://get.bud.dev", fetcher = fetch,
  wait = sleep, attempts = 18, log = console.log, benchmark = false, historical = false }) {
  const manifest = JSON.parse(manifestBytes);
  validateMirrorManifest(manifest, manifest.version);
  const request = (url, options = {}) => fetcher(url, {
    redirect: "manual", signal: AbortSignal.timeout(120_000), ...options,
  });
  // Deployment propagation retries only reads; corruption after convergence fails.
  let ready = historical;
  for (let i = 0; i < attempts && !historical; i++) {
    const stable = await request(`${origin}/releases/stable/manifest.json`);
    const bytes = Buffer.from(await stable.arrayBuffer());
    let matches = false;
    if (stable.status === 200) {
      try { assert.deepEqual(JSON.parse(bytes), manifest); matches = true; }
      catch { /* Old or incomplete static deployment: retry the read. */ }
    }
    if (matches) {
      assert.equal(stable.headers.get("cache-control"), "no-store");
      ready = true; break;
    }
    if (i + 1 < attempts) await wait(10_000);
  }
  assert.ok(ready, "stable manifest did not converge on canonical content");
  for (const route of historical ? [] : ["/", "/install.sh"]) {
    const response = await request(`${origin}${route}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok((await response.text()).startsWith("#!/bin/sh\n"));
  }
  const versioned = await request(`${origin}/releases/${manifest.version}/manifest.json`);
  requireR2(versioned, 200, Buffer.byteLength(manifestBytes));
  assert.deepEqual(Buffer.from(await versioned.arrayBuffer()), Buffer.from(manifestBytes));

  const results = [];
  for (const artifact of manifest.artifacts) {
    const url = `${origin}/releases/${manifest.version}/bud-${artifact.target}.tar.gz`;
    let head;
    for (let i = 0; i < attempts; i++) {
      head = await request(url, { method: "HEAD" });
      if (head.status === 200 && head.headers.get("x-bud-release-origin") === "r2") break;
      if (i + 1 < attempts) await wait(10_000);
    }
    requireR2(head, 200, artifact.size);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    const etag = head.headers.get("etag");
    assert.match(etag ?? "", /^".+"$/);
    const started = performance.now();
    const response = await request(url);
    const edges = await readArchive(response, artifact);
    results.push({ target: artifact.target, size: artifact.size, sha256: artifact.sha256, duration_ms: Math.round(performance.now() - started),
      cache: response.headers.get("x-bud-release-cache"), cf_ray: response.headers.get("cf-ray") });
    for (const [range, expected, offset] of [
      [`bytes=0-${edges.first.length - 1}`, edges.first, 0],
      [`bytes=${artifact.size - edges.last.length}-`, edges.last, artifact.size - edges.last.length],
      [`bytes=-${edges.last.length}`, edges.last, artifact.size - edges.last.length],
    ]) {
      const part = await request(url, { headers: { range, "if-range": etag } });
      requireR2(part, 206, expected.length);
      assert.equal(part.headers.get("content-range"), `bytes ${offset}-${offset + expected.length - 1}/${artifact.size}`);
      assert.deepEqual(Buffer.from(await part.arrayBuffer()), expected);
    }
    const unchanged = await request(url, { headers: { "if-none-match": etag } });
    requireR2(unchanged, 304);
    assert.equal((await unchanged.arrayBuffer()).byteLength, 0);
    const invalid = await request(url, { headers: { range: `bytes=${artifact.size}-` } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), `bytes */${artifact.size}`);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    await invalid.arrayBuffer();
  }
  // At least one actual full cache hit, independently hash-verified. Different
  // PoPs or abandoned cache writes can miss; allow bounded read-only warming.
  const artifact = manifest.artifacts.find((item) => item.target === "aarch64-apple-darwin");
  const url = `${origin}/releases/${manifest.version}/bud-${artifact.target}.tar.gz`;
  let hit = false;
  for (let i = 0; i < 4; i++) {
    await wait(1000);
    const response = await request(`${url}?cache-check=1`);
    await readArchive(response, artifact);
    if (response.headers.get("x-bud-release-cache") === "HIT") { hit = true; break; }
  }
  assert.ok(hit, "no verified warm full-response cache hit");
  log(JSON.stringify({ event: "release_smoke_passed", version: manifest.version, transfers: results }));
  if (benchmark) {
    for (let run = 1; run <= 3; run++) {
      const started = performance.now();
      const response = await request(url);
      await readArchive(response, artifact);
      log(JSON.stringify({ event: "release_benchmark", run, target: artifact.target,
        duration_ms: Math.round(performance.now() - started), size: artifact.size,
        cache: response.headers.get("x-bud-release-cache"), cf_ray: response.headers.get("cf-ray") }));
    }
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [manifestFile, option] = process.argv.slice(2);
  const origin = process.env.BUD_RELEASE_TEST_ORIGIN ?? "https://get.bud.dev";
  Promise.resolve().then(async () => {
    const parsed = new URL(origin);
    assert.ok(parsed.protocol === "https:" && parsed.origin === origin, "origin must be an HTTPS origin");
    assert.ok(manifestFile && (!option || option === "--benchmark" || option === "--historical") && process.argv.length <= 4,
      "Usage: node scripts/bud-release-smoke.mjs <canonical-manifest> [--benchmark|--historical]");
    await smokeRelease({ manifestBytes: await readFile(manifestFile), origin, benchmark: option === "--benchmark", historical: option === "--historical" });
  }).catch((error) => {
    console.error(`Release smoke failed: ${error instanceof assert.AssertionError ? error.message : "download or manifest failure"}`);
    process.exitCode = 1;
  });
}
