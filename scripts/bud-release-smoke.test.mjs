import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { REQUIRED_TARGETS } from "./bud-release.mjs";
import { smokeRelease } from "./bud-release-smoke.mjs";
import { createGetBudDevWorker } from "../deploy/get-bud-dev/worker.js";

function fixture() {
  const version = "v0.1.25";
  const bytes = Buffer.alloc(32 * 1024);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const manifest = { version, channel: "stable", published_at: "2026-10-10T00:00:00Z",
    artifacts: REQUIRED_TARGETS.map(({ target, min_os }) => ({ target, min_os,
      url: `https://get.bud.dev/releases/${version}/bud-${target}.tar.gz`, size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") })) };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const objects = new Map([[`releases/${version}/manifest.json`, manifestBytes],
    ...manifest.artifacts.map(({ target }) => [`releases/${version}/bud-${target}.tar.gz`, bytes])]);
  const metadata = (data) => ({ size: data.length, etag: "fixture", httpEtag: '"fixture"',
    uploaded: new Date("2026-10-10T00:00:00Z"), writeHttpMetadata() {} });
  const cacheEntries = new Map();
  const worker = createGetBudDevWorker({ stableManifest: manifest, installScript: "#!/bin/sh\nexit 0\n",
    releases: {
      async head(key) { const data = objects.get(key); return data && metadata(data); },
      async get(key, options) {
        const data = objects.get(key);
        const part = options.range ? data.subarray(options.range.offset, options.range.offset + options.range.length) : data;
        return { ...metadata(data), body: new Response(part).body };
      },
    },
    cache: {
      async put(key, response) {
        const body = Buffer.from(await response.arrayBuffer());
        cacheEntries.set(key.url, { body, headers: response.headers });
      },
      async match(key) {
        const item = cacheEntries.get(key.url);
        if (!item) return undefined;
        const match = /^bytes=(\d+)-(\d+)$/.exec(key.headers.get("range") ?? "");
        if (!match) return new Response(item.body, { headers: item.headers });
        const start = Number(match[1]), end = Number(match[2]);
        const headers = new Headers(item.headers);
        headers.set("content-range", `bytes ${start}-${end}/${item.body.length}`);
        headers.set("content-length", String(end - start + 1));
        return new Response(item.body.subarray(start, end + 1), { status: 206, headers });
      },
    } });
  const pending = [];
  const fetcher = async (url, options) => worker.fetch(new Request(url, options), {
    waitUntil(promise) { pending.push(promise); },
  });
  const waits = async () => { await Promise.all(pending); };
  return { manifestBytes, fetcher, wait: waits, attempts: 2, log() {} };
}

test("deployed checker verifies four complete archives, ranges, conditionals, cache hit and benchmark", async () => {
  const options = fixture();
  const logs = [];
  const transfers = await smokeRelease({ ...options, benchmark: true, log: (line) => logs.push(JSON.parse(line)) });
  assert.equal(transfers.length, 4);
  assert.equal(logs.filter((line) => line.event === "release_benchmark").length, 3);
});

test("checker requests identity encoding while preserving range and conditional headers", async () => {
  const options = fixture();
  const fetcher = options.fetcher;
  let ranges = 0, conditionals = 0;
  options.fetcher = async (url, init) => {
    const headers = new Headers(init.headers);
    if (headers.has("range")) ranges++;
    if (headers.has("if-none-match")) conditionals++;
    const response = await fetcher(url, init);
    if (headers.get("accept-encoding") === "identity") return response;
    // fetch exposes decoded JSON, but edge compression removes its byte length.
    const encoded = new Headers(response.headers);
    encoded.delete("content-length");
    encoded.set("content-encoding", "br");
    return new Response(response.body, { status: response.status, headers: encoded });
  };
  await smokeRelease(options);
  assert.equal(ranges, 16);
  assert.equal(conditionals, 4);
});

test("checker rejects redirects, corrupt bytes, wrong size, wrong ranges and absent cache hits", async () => {
  for (const fault of ["redirect", "checksum", "size", "range", "cache"]) {
    const options = fixture();
    const fetcher = options.fetcher;
    options.fetcher = async (url, init) => {
      const response = await fetcher(url, init);
      if (!url.includes(".tar.gz")) return response;
      if (fault === "redirect") return new Response(null, { status: 302 });
      const headers = new Headers(response.headers);
      if (fault === "size") headers.set("content-length", "1");
      if (fault === "range" && response.status === 206) headers.set("content-range", "bytes 1-2/3");
      if (fault === "cache") headers.set("x-bud-release-cache", "MISS");
      if (fault === "checksum" && response.status === 200 && init?.method !== "HEAD") {
        const body = Buffer.from(await response.arrayBuffer()); body[0] ^= 1;
        return new Response(body, { status: response.status, headers });
      }
      return new Response(response.body, { status: response.status, headers });
    };
    await assert.rejects(smokeRelease(options), undefined, fault);
  }
});

test("checker waits for stable propagation but never accepts a different canonical manifest", async () => {
  const options = fixture();
  const fetcher = options.fetcher;
  let stale = 1;
  options.fetcher = (url, init) => url.includes("stable") && stale-- > 0 ? new Response("old", { status: 200 }) : fetcher(url, init);
  await smokeRelease(options);
  options.fetcher = (url, init) => url.includes("stable") ? new Response("old", { status: 200 }) : fetcher(url, init);
  await assert.rejects(smokeRelease(options), /did not converge/);
});

test("historical validation verifies retained bytes without requiring stable to select them", async () => {
  const options = fixture();
  const fetcher = options.fetcher;
  options.fetcher = (url, init) => {
    assert.ok(!url.includes("stable"), "must not inspect mutable stable for historical acceptance");
    return fetcher(url, init);
  };
  assert.equal((await smokeRelease({ ...options, historical: true })).length, 4);
});
