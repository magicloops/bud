#!/usr/bin/env node
// Prepare deployment assets only after the selected release is verified in R2.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPromotionAssets } from "./bud-release.mjs";
import { createR2Store, downloadRelease, mirrorRelease, r2Configuration, validateVersion } from "./bud-release-mirror.mjs";

export async function preparePromotion({ version, directory, assetsDir, repository, store,
  download = downloadRelease, log = () => {} }) {
  validateVersion(version);
  await download(directory, version, repository);
  await mirrorRelease({ directory, version, store, log });
  return buildPromotionAssets({ manifest: path.join(directory, `manifest.${version}.json`), assetsDir });
}

async function main() {
  const [version, assetsDir] = process.argv.slice(2);
  validateVersion(version);
  if (!assetsDir || process.argv.length !== 4) throw new Error("Usage: node scripts/bud-release-promote.mjs v0.1.25 deploy/get-bud-dev/assets");
  const directory = await mkdtemp(path.join(os.tmpdir(), "bud-release-promote-"));
  const store = createR2Store(r2Configuration());
  try {
    console.log(JSON.stringify(await preparePromotion({ version, directory, assetsDir,
      repository: process.env.GITHUB_REPOSITORY ?? "magicloops/bud", store, log: console.log })));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // SDK and gh exceptions may contain request details or credentials.
    console.error("Promotion preparation failed; deployment must not proceed. Check GitHub assets and R2 access, then rerun.");
    process.exitCode = 1;
  });
}
