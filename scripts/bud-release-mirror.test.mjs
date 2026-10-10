import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { REQUIRED_TARGETS } from "./bud-release.mjs";
import { createR2Store, downloadRelease, mirrorRelease, r2Configuration, validateMirrorManifest, validateVersion } from "./bud-release-mirror.mjs";

const version = "v0.1.25";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bud-mirror-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { version, channel: "stable", published_at: "2026-10-10T00:00:00Z", artifacts: [] };
  for (const { target, min_os } of REQUIRED_TARGETS) {
    const bytes = Buffer.from(`archive:${target}`);
    const name = `bud-${target}.tar.gz`;
    await writeFile(path.join(directory, name), bytes);
    manifest.artifacts.push({ target, min_os, size: bytes.length, sha256: digest(bytes), url: `https://get.bud.dev/releases/${version}/${name}` });
  }
  const manifestPath = path.join(directory, `manifest.${version}.json`);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const objects = new Map();
  const writes = [];
  const store = {
    async read(key) { return objects.has(key) ? Readable.from([objects.get(key)]) : null; },
    async create(key, object) {
      assert.ok(!objects.has(key), "never overwrite");
      const chunks = [];
      const body = object.body();
      if (Buffer.isBuffer(body)) chunks.push(body);
      else for await (const chunk of body) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, object.size);
      assert.equal(digest(bytes), object.sha256);
      writes.push({ key, object });
      objects.set(key, bytes);
      return true;
    },
  };
  return { directory, manifest, manifestPath, objects, writes, store };
}

test("verified mirror writes four archives then exact manifest, reruns are read-only", async (t) => {
  const f = await fixture(t);
  assert.equal((await mirrorRelease({ ...f, version })).artifacts, 4);
  assert.equal(f.writes.length, 5);
  assert.equal(f.writes.at(-1).key, `releases/${version}/manifest.json`);
  assert.deepEqual(f.objects.get(f.writes.at(-1).key), await readFile(f.manifestPath));
  for (const { object } of f.writes.slice(0, 4)) {
    assert.equal(object.contentType, "application/gzip");
    assert.match(object.contentDisposition, /^attachment;/);
  }
  await mirrorRelease({ ...f, version });
  assert.equal(f.writes.length, 5);
});

test("manifest validation rejects malformed versions, duplicate/missing/unknown targets and foreign paths", async (t) => {
  const { manifest } = await fixture(t);
  for (const value of ["../x", "v1/../../x", "--help", "v1.2.3\n", "1.2.3", "v1.2.3?x"]) assert.throws(() => validateVersion(value));
  assert.equal(validateVersion("v0.0.1-install-canary.7"), "v0.0.1-install-canary.7");
  for (const mutate of [
    (m) => m.artifacts.pop(),
    (m) => { m.artifacts[1] = m.artifacts[0]; },
    (m) => { m.artifacts[0].target = "../../evil"; },
    (m) => { m.version = "v0.1.24"; },
    (m) => { m.artifacts[0].url = "https://evil.test/archive"; },
    (m) => { m.artifacts[0].url += "?redirect=x"; },
    (m) => { m.artifacts[0].sha256 = "bad"; },
    (m) => { m.artifacts[0].size = 0; },
    (m) => { m.artifacts[0].size = 513 * 1024 * 1024; },
  ]) {
    const copy = structuredClone(manifest); mutate(copy);
    assert.throws(() => validateMirrorManifest(copy, version));
  }
});

test("ALL source assets verify before writes, including late hash/size/missing failures", async (t) => {
  for (const failure of ["hash", "size", "missing"]) {
    const f = await fixture(t);
    const artifact = f.manifest.artifacts.at(-1);
    const file = path.join(f.directory, `bud-${artifact.target}.tar.gz`);
    if (failure === "hash") await writeFile(file, Buffer.alloc(artifact.size, 120));
    if (failure === "size") await writeFile(file, "short");
    if (failure === "missing") await rm(file);
    await assert.rejects(() => mirrorRelease({ ...f, version }));
    assert.equal(f.writes.length, 0);
  }
});

test("existing conflicting bytes or manifest fail without overwrites", async (t) => {
  for (const manifestConflict of [false, true]) {
    const f = await fixture(t);
    const key = manifestConflict ? `releases/${version}/manifest.json` : `releases/${version}/bud-${REQUIRED_TARGETS[0].target}.tar.gz`;
    const original = Buffer.from("conflicting content");
    f.objects.set(key, original);
    await assert.rejects(() => mirrorRelease({ ...f, version }), /mismatch/);
    assert.deepEqual(f.objects.get(key), original);
    assert.equal(f.writes.length, 0);
  }
});

test("interrupted upload/read-back corruption never publishes completion marker", async (t) => {
  for (const failure of ["interrupted", "corrupt", "missing", "truncated"]) {
    const f = await fixture(t);
    const create = f.store.create;
    f.store.create = async (key, object) => {
      if (failure === "interrupted") throw new Error("upload interrupted");
      const created = await create(key, object);
      if (failure === "corrupt") f.objects.set(key, Buffer.alloc(object.size, 0));
      if (failure === "missing") f.objects.delete(key);
      if (failure === "truncated") {
        f.store.read = async () => Readable.from((async function* () { yield Buffer.from("partial"); throw new Error("read interrupted"); })());
      }
      return created;
    };
    await assert.rejects(() => mirrorRelease({ ...f, version }));
    assert.equal(f.objects.has(`releases/${version}/manifest.json`), false);
  }
});

test("partial mirror resumes and concurrent conditional-create winners are verified", async (t) => {
  const f = await fixture(t);
  const create = f.store.create;
  let calls = 0;
  f.store.create = async (key, object) => {
    if (++calls === 3) throw new Error("interrupted");
    return create(key, object);
  };
  await assert.rejects(() => mirrorRelease({ ...f, version }));
  assert.equal(f.writes.length, 2);
  f.store.create = async (key, object) => { await create(key, object); return false; };
  await mirrorRelease({ ...f, version });
  assert.equal(f.writes.length, 5);
});

test("conflicting race fails; prior release objects and stable object remain unchanged", async (t) => {
  const f = await fixture(t);
  const oldKey = "releases/v0.1.24/bud-aarch64-apple-darwin.tar.gz";
  const stableKey = "releases/stable/manifest.json";
  f.objects.set(oldKey, Buffer.from("old")); f.objects.set(stableKey, Buffer.from("stable"));
  f.store.create = async (key) => { f.objects.set(key, Buffer.from("race loser")); return false; };
  await assert.rejects(() => mirrorRelease({ ...f, version }), /mismatch/);
  assert.equal(f.objects.get(oldKey).toString(), "old");
  assert.equal(f.objects.get(stableKey).toString(), "stable");
  assert.equal(f.objects.has(`releases/${version}/manifest.json`), false);
});

test("GitHub download uses explicit repo/tag and fixed assets, rejects malformed manifest before archives", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const run = async (program, args) => { calls.push({ program, args }); };
  await downloadRelease(f.directory, version, "magicloops/bud", run);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].program, "gh");
  assert.ok(calls[0].args.includes(`manifest.${version}.json`));
  assert.equal(calls[1].args.filter((arg) => arg === "--pattern").length, 4);
  assert.ok(!calls.flatMap(({ args }) => args).some((arg) => arg.startsWith("https://")));
  f.manifest.artifacts[0].url = "https://evil.test";
  await writeFile(f.manifestPath, JSON.stringify(f.manifest));
  calls.length = 0;
  await assert.rejects(() => downloadRelease(f.directory, version, "magicloops/bud", run));
  assert.equal(calls.length, 1);
  await assert.rejects(() => downloadRelease(f.directory, version, "../../repo", run));
});

test("R2 adapter sets conditional creation/metadata; only missing keys and preconditions are handled", async () => {
  const commands = [];
  const config = r2Configuration({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" });
  assert.equal(config.bucket, "bud-releases-prod");
  assert.equal(config.endpoint, `https://${"a".repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(config.requestChecksumCalculation, "WHEN_REQUIRED");
  for (const env of [{}, { CLOUDFLARE_ACCOUNT_ID: "https://evil.test" }, { CLOUDFLARE_ACCOUNT_ID: "a".repeat(32) }]) assert.throws(() => r2Configuration(env));
  let failure;
  const client = { async send(command) { commands.push(command); if (failure) throw failure; return { Body: Readable.from(["body"]) }; } };
  const store = createR2Store(config, client);
  assert.ok(await store.read("key"));
  assert.equal(await store.create("key", { body: () => Buffer.from("body"), size: 4, sha256: digest("body"), contentType: "application/gzip" }), true);
  const input = commands.at(-1).input;
  assert.equal(input.IfNoneMatch, "*");
  assert.equal(input.CacheControl, "public, max-age=31536000, immutable");
  assert.equal(input.Metadata.sha256, digest("body"));
  failure = { name: "NoSuchKey" }; assert.equal(await store.read("missing"), null);
  failure = { name: "NoSuchBucket" }; await assert.rejects(() => store.read("key"));
  failure = { name: "AccessDenied" }; await assert.rejects(() => store.read("key"));
  failure = { name: "PreconditionFailed" }; assert.equal(await store.create("key", { body: () => Buffer.from("body") }), false);
  failure = { name: "AccessDenied" }; await assert.rejects(() => store.create("key", { body: () => Buffer.from("body") }));
});

test("real S3 transport streams fixture files, signs requests and preserves immutable objects", async (t) => {
  const f = await fixture(t);
  const objects = new Map();
  let uploads = 0;
  const server = createServer(async (req, res) => {
    assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
    const key = new URL(req.url, "http://localhost").pathname;
    if (req.method === "GET") {
      if (!objects.has(key)) {
        res.writeHead(404, { "content-type": "application/xml" });
        res.end("<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>");
      } else res.end(objects.get(key));
      return;
    }
    assert.equal(req.method, "PUT");
    assert.equal(req.headers["if-none-match"], "*");
    assert.equal(req.headers["cache-control"], "public, max-age=31536000, immutable");
    if (objects.has(key)) {
      res.writeHead(412, { "content-type": "application/xml" });
      res.end("<Error><Code>PreconditionFailed</Code></Error>");
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    assert.equal(Number(req.headers["content-length"]), bytes.length);
    assert.equal(req.headers["x-amz-meta-sha256"], digest(bytes));
    objects.set(key, bytes);
    uploads++;
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const store = createR2Store({
    ...r2Configuration({ CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "test-key", R2_SECRET_ACCESS_KEY: "test-secret" }),
    endpoint: `http://127.0.0.1:${server.address().port}`, forcePathStyle: true, maxAttempts: 1,
  });
  t.after(async () => { store.close(); await new Promise((resolve) => server.close(resolve)); });
  await mirrorRelease({ ...f, version, store });
  await mirrorRelease({ ...f, version, store });
  assert.equal(uploads, 5);
  const manifestKey = `releases/${version}/manifest.json`;
  assert.equal(await store.create(manifestKey, { body: () => Buffer.from("changed"), size: 7, sha256: digest("changed"), contentType: "application/json" }), false);
  assert.deepEqual(objects.get(`/bud-releases-prod/${manifestKey}`), await readFile(f.manifestPath));
});
