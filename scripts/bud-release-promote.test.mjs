import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { REQUIRED_TARGETS } from "./bud-release.mjs";
import { preparePromotion } from "./bud-release-promote.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bud-promote-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const assetsDir = path.join(directory, "assets");
  const stablePath = path.join(assetsDir, "releases/stable/manifest.json");
  await mkdir(path.dirname(stablePath), { recursive: true });
  await writeFile(stablePath, "previous stable");
  const version = "v0.1.25";
  const bytes = Buffer.from("verified archive");
  const manifest = { version, channel: "stable", published_at: "2026-10-10T00:00:00Z",
    artifacts: REQUIRED_TARGETS.map(({ target, min_os }) => ({ target, min_os,
      url: `https://get.bud.dev/releases/${version}/bud-${target}.tar.gz`,
      sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length })) };
  let downloads = 0;
  const objects = new Map([["releases/v0.1.24/manifest.json", Buffer.from("historical")]]);
  const store = {
    async read(key) { return objects.has(key) ? [objects.get(key)] : null; },
    async create(key, object) {
      const chunks = [];
      const body = object.body();
      if (Buffer.isBuffer(body)) chunks.push(body);
      else for await (const chunk of body) chunks.push(chunk);
      objects.set(key, Buffer.concat(chunks)); return true;
    },
  };
  const options = { directory, assetsDir, version, repository: "magicloops/bud", store,
    async download(dir) {
      downloads++;
      await writeFile(path.join(dir, `manifest.${version}.json`), JSON.stringify(manifest));
      for (const { target } of REQUIRED_TARGETS) await writeFile(path.join(dir, `bud-${target}.tar.gz`), bytes);
    } };
  return { options, store, stablePath, objects, downloads: () => downloads };
}

test("promotion downloads once, verifies every R2 object before stable generation and retains history", async (t) => {
  const f = await fixture(t);
  await preparePromotion(f.options);
  assert.equal(f.downloads(), 1);
  assert.equal(JSON.parse(await readFile(f.stablePath)).version, "v0.1.25");
  assert.equal(f.objects.size, 6);
  assert.equal(f.objects.get("releases/v0.1.24/manifest.json").toString(), "historical");
});

test("download failure, corrupt source, failed upload or corrupt read-back cannot change stable", async (t) => {
  for (const failure of ["download", "source", "upload", "readback"]) {
    const f = await fixture(t);
    const download = f.options.download;
    f.options.download = async (...args) => {
      if (failure === "download") throw new Error("source unavailable");
      await download(...args);
      if (failure === "source") await writeFile(path.join(f.options.directory, "bud-aarch64-apple-darwin.tar.gz"), "corrupt");
    };
    const create = f.store.create;
    f.store.create = async (key, object) => {
      if (failure === "upload") throw new Error("write failed");
      await create(key, object);
      if (failure === "readback") f.objects.set(key, Buffer.from("corrupt"));
      return true;
    };
    await assert.rejects(preparePromotion(f.options));
    assert.equal(await readFile(f.stablePath, "utf8"), "previous stable");
    assert.equal(f.objects.has("releases/v0.1.25/manifest.json"), false);
  }
});

test("workflow orders verified preparation before deploy and requires deployed smoke", async () => {
  const workflow = await readFile(new URL("../.github/workflows/get-bud-dev-promote.yml", import.meta.url), "utf8");
  assert.ok(workflow.indexOf("bud-release-promote.mjs") < workflow.indexOf("name: Deploy Worker"));
  assert.ok(workflow.indexOf("name: Deploy Worker") < workflow.indexOf("bud-release-smoke.mjs"));
  assert.doesNotMatch(workflow, /inputs\.smoke|_release-assets|continue-on-error/);
  assert.match(workflow, /R2_SECRET_ACCESS_KEY: \$\{\{ secrets.R2_SECRET_ACCESS_KEY \}\}/);
});
