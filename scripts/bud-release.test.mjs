import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  packageArtifact,
  selectManifestArtifact,
  targetForPlatform,
  validateManifestShape,
  verifyArtifactSha256,
} from "./bud-release.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bud-release-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function fakeBinary(dir) {
  await mkdir(dir, { recursive: true });
  const binary = path.join(dir, "bud");
  await writeFile(binary, "#!/bin/sh\necho bud\n");
  await chmod(binary, 0o755);
  return binary;
}

test("packageArtifact creates a tarball with bud and release metadata", async (t) => {
  const dir = await tempDir(t);
  const binary = await fakeBinary(dir);
  const outDir = path.join(dir, "dist");

  const metadata = await packageArtifact({
    target: "x86_64-unknown-linux-gnu",
    version: "0.1.0",
    binary,
    out: outDir,
    minOs: "glibc 2.35",
    repoRoot: dir,
  });

  assert.equal(metadata.version, "v0.1.0");
  assert.equal(metadata.target, "x86_64-unknown-linux-gnu");
  assert.equal(metadata.min_os, "glibc 2.35");
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  assert.ok(metadata.size > 0);
  assert.ok(existsSync(metadata.path));
  assert.ok(existsSync(metadata.metadata_path));

  const listing = spawnSync("tar", ["-tzf", metadata.path], {
    encoding: "utf8",
  });
  assert.equal(listing.status, 0, listing.stderr);
  assert.match(listing.stdout, /(?:^|\n)\.\/bud(?:\n|$)/);
  assert.match(listing.stdout, /(?:^|\n)\.\/README\.md(?:\n|$)/);

  const sidecar = JSON.parse(await readFile(metadata.metadata_path, "utf8"));
  assert.equal(sidecar.artifact_name, "bud-x86_64-unknown-linux-gnu.tar.gz");
});

test("buildManifest uses artifact metadata and supports platform selection", async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, "dist");

  for (const target of [
    ["aarch64-apple-darwin", "macOS 13"],
    ["x86_64-apple-darwin", "macOS 13"],
    ["x86_64-unknown-linux-gnu", "glibc 2.35"],
  ]) {
    await packageArtifact({
      target: target[0],
      version: "v0.1.0",
      binary: await fakeBinary(path.join(dir, target[0])),
      out: outDir,
      minOs: target[1],
      repoRoot: dir,
    });
  }

  const manifestPath = path.join(outDir, "manifest.json");
  const manifest = await buildManifest({
    version: "0.1.0",
    channel: "stable",
    publishedAt: "2026-05-30T00:00:00.000Z",
    baseUrl: "https://get.bud.dev",
    metadataDir: outDir,
    out: manifestPath,
  });

  assert.equal(manifest.version, "v0.1.0");
  assert.equal(manifest.channel, "stable");
  assert.equal(manifest.artifacts.length, 3);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.target),
    [
      "aarch64-apple-darwin",
      "x86_64-apple-darwin",
      "x86_64-unknown-linux-gnu",
    ],
  );
  assert.equal(
    selectManifestArtifact(manifest, "darwin", "arm64").target,
    "aarch64-apple-darwin",
  );
  assert.equal(
    selectManifestArtifact(manifest, "linux", "x64").target,
    "x86_64-unknown-linux-gnu",
  );
  assert.match(
    manifest.artifacts[0].url,
    /^https:\/\/get\.bud\.dev\/releases\/v0\.1\.0\/bud-/,
  );
  assert.ok(existsSync(manifestPath));
});

test("checksum mismatch fixture and verifier reject tampered archives", async (t) => {
  const dir = await tempDir(t);
  const binary = await fakeBinary(dir);
  const metadata = await packageArtifact({
    target: "x86_64-unknown-linux-gnu",
    version: "v0.1.0",
    binary,
    out: path.join(dir, "dist"),
    minOs: "glibc 2.35",
    repoRoot: dir,
  });

  await assert.rejects(
    () => verifyArtifactSha256(metadata.path, "0".repeat(64)),
    /checksum mismatch/,
  );

  const fixture = JSON.parse(
    await readFile(
      path.join(scriptDir, "fixtures", "bud-release", "manifest-checksum-mismatch.json"),
      "utf8",
    ),
  );
  validateManifestShape(fixture);
  assert.equal(fixture.artifacts[0].sha256, "0".repeat(64));
});

test("targetForPlatform maps supported installer platforms", () => {
  assert.equal(targetForPlatform("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetForPlatform("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(targetForPlatform("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.throws(() => targetForPlatform("linux", "arm64"), /unsupported Bud release platform/);
});
