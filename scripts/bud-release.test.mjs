import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChecksums,
  buildManifest,
  buildPromotionAssets,
  buildReleaseAssetMap,
  buildReleaseNotes,
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

test("buildChecksums emits sorted sha256 lines for release archives", async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, "dist");

  for (const target of [
    ["x86_64-unknown-linux-gnu", "glibc 2.35"],
    ["aarch64-apple-darwin", "macOS 13"],
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

  const checksumPath = path.join(outDir, "checksums.txt");
  const checksums = await buildChecksums({
    artifactDir: outDir,
    out: checksumPath,
  });

  assert.match(checksums, /^[a-f0-9]{64}  bud-aarch64-apple-darwin\.tar\.gz/m);
  assert.match(checksums, /^[a-f0-9]{64}  bud-x86_64-unknown-linux-gnu\.tar\.gz/m);
  assert.deepEqual(checksums.trim().split("\n"), checksums.trim().split("\n").toSorted());
  assert.equal(await readFile(checksumPath, "utf8"), checksums);
});

test("buildReleaseNotes includes commit and target matrix", async (t) => {
  const dir = await tempDir(t);
  const outDir = path.join(dir, "dist");
  await packageArtifact({
    target: "x86_64-unknown-linux-gnu",
    version: "v0.1.0",
    binary: await fakeBinary(dir),
    out: outDir,
    minOs: "glibc 2.35",
    repoRoot: dir,
  });

  const notesPath = path.join(outDir, "release-notes.md");
  const notes = await buildReleaseNotes({
    version: "0.1.0",
    channel: "stable",
    commit: "abc123",
    metadataDir: outDir,
    out: notesPath,
  });

  assert.match(notes, /^# Bud v0\.1\.0/);
  assert.match(notes, /Commit: `abc123`/);
  assert.match(notes, /\| `x86_64-unknown-linux-gnu` \| glibc 2\.35 \|/);
  assert.equal(await readFile(notesPath, "utf8"), notes);
});

test("buildReleaseAssetMap maps first-party manifest URLs to GitHub Release assets", async (t) => {
  const dir = await tempDir(t);
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({
      version: "v0.1.0",
      channel: "stable",
      published_at: "2026-05-30T00:00:00Z",
      artifacts: [
        {
          target: "x86_64-unknown-linux-gnu",
          url: "https://get.bud.dev/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
          sha256: "a".repeat(64),
          min_os: "glibc 2.35",
          size: 123,
        },
      ],
    }),
  );

  const mapPath = path.join(dir, "_release-assets.json");
  const releaseAssets = await buildReleaseAssetMap({
    manifest: manifestPath,
    githubRepository: "bud-dev/bud",
    out: mapPath,
  });

  assert.deepEqual(releaseAssets, {
    "v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz":
      "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
  });
  assert.deepEqual(JSON.parse(await readFile(mapPath, "utf8")), releaseAssets);
});

test("buildPromotionAssets writes Worker static manifest and release-map assets", async (t) => {
  const dir = await tempDir(t);
  const manifest = {
    version: "v0.1.0",
    channel: "stable",
    published_at: "2026-05-30T00:00:00Z",
    artifacts: [
      {
        target: "x86_64-unknown-linux-gnu",
        url: "https://get.bud.dev/releases/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
        sha256: "a".repeat(64),
        min_os: "glibc 2.35",
        size: 123,
      },
    ],
  };
  const manifestPath = path.join(dir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));

  const assetsDir = path.join(dir, "assets");
  const output = await buildPromotionAssets({
    manifest: manifestPath,
    githubRepository: "bud-dev/bud",
    assetsDir,
  });

  assert.deepEqual(JSON.parse(await readFile(output.stable_manifest_path, "utf8")), manifest);
  assert.deepEqual(JSON.parse(await readFile(output.version_manifest_path, "utf8")), manifest);
  assert.deepEqual(JSON.parse(await readFile(output.release_assets_path, "utf8")), {
    "v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz":
      "https://github.com/bud-dev/bud/releases/download/v0.1.0/bud-x86_64-unknown-linux-gnu.tar.gz",
  });
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
