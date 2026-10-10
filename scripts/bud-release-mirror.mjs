#!/usr/bin/env node
// Mirror exact GitHub release assets; never deploy or change stable.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { REQUIRED_TARGETS, validateManifestShape } from "./bud-release.mjs";

class MirrorError extends Error {}

const execute = promisify(execFile);
const IMMUTABLE = "public, max-age=31536000, immutable";
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export function validateVersion(version) {
  if (typeof version !== "string" || version.length > 128 ||
      !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(version)) {
    throw new MirrorError("version must be an explicit release tag, for example v0.1.25");
  }
  return version;
}

export function validateMirrorManifest(manifest, version) {
  validateVersion(version);
  try { validateManifestShape(manifest); }
  catch { throw new MirrorError("invalid release manifest shape"); }
  if (manifest.version !== version) throw new MirrorError("manifest version does not match requested release");
  const targets = new Set(REQUIRED_TARGETS.map(({ target }) => target));
  if (manifest.artifacts.length !== targets.size) throw new MirrorError("manifest must contain every required target exactly once");
  const seen = new Set();
  for (const artifact of manifest.artifacts) {
    if (!targets.has(artifact.target) || seen.has(artifact.target)) throw new MirrorError("unknown or duplicate release target");
    seen.add(artifact.target);
    const expectedUrl = `https://get.bud.dev/releases/${version}/bud-${artifact.target}.tar.gz`;
    if (artifact.url !== expectedUrl) throw new MirrorError("archive URL must match its canonical first-party path");
    if (artifact.size > MAX_ARCHIVE_BYTES) throw new MirrorError("archive exceeds mirror size limit");
  }
  return manifest;
}

async function verifyStream(body, expected, label) {
  if (!body) throw new MirrorError(`missing body for ${label}`);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > expected.size) throw new MirrorError(`size mismatch for ${label}`);
    hash.update(chunk);
  }
  if (size !== expected.size) throw new MirrorError(`size mismatch for ${label}`);
  if (hash.digest("hex") !== expected.sha256) throw new MirrorError(`checksum mismatch for ${label}`);
}

export async function prepareRelease(directory, version) {
  validateVersion(version);
  const manifestPath = path.join(directory, `manifest.${version}.json`);
  if ((await stat(manifestPath)).size > MAX_MANIFEST_BYTES) throw new MirrorError("manifest exceeds size limit");
  const manifestBytes = await readFile(manifestPath);
  const manifest = validateMirrorManifest(JSON.parse(manifestBytes), version);
  for (const artifact of manifest.artifacts) {
    const file = path.join(directory, `bud-${artifact.target}.tar.gz`);
    const info = await stat(file);
    if (!info.isFile() || info.size !== artifact.size) throw new MirrorError(`size mismatch for ${artifact.target}`);
    await verifyStream(createReadStream(file), artifact, artifact.target);
  }
  return { directory, manifest, manifestBytes };
}

export async function downloadRelease(directory, version, repository, run = execute) {
  validateVersion(version);
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)) throw new MirrorError("invalid GitHub repository");
  const args = ["release", "download", version, "--repo", repository, "--dir", directory];
  await run("gh", [...args, "--pattern", `manifest.${version}.json`]);
  const file = path.join(directory, `manifest.${version}.json`);
  if ((await stat(file)).size > MAX_MANIFEST_BYTES) throw new MirrorError("manifest exceeds size limit");
  validateMirrorManifest(JSON.parse(await readFile(file, "utf8")), version);
  // Asset names come from the trusted matrix, not manifest URLs or shell code.
  await run("gh", [...args, ...REQUIRED_TARGETS.flatMap(({ target }) => ["--pattern", `bud-${target}.tar.gz`])]);
  return prepareRelease(directory, version);
}

export function r2Configuration(env = process.env) {
  const account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!/^[a-fA-F0-9]{32}$/.test(account ?? "")) throw new MirrorError("CLOUDFLARE_ACCOUNT_ID must be set to the R2 account ID");
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) throw new MirrorError("R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required");
  const bucket = env.R2_BUCKET ?? "bud-releases-prod";
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new MirrorError("invalid R2_BUCKET");
  return {
    bucket,
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    region: "auto",
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY },
    // R2 does not support the SDK's default optional checksum negotiation.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  };
}

export function createR2Store(config, client = new S3Client(config)) {
  return {
    close() { client.destroy?.(); },
    async read(key) {
      try {
        return (await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }))).Body;
      } catch (error) {
        if (error.name === "NoSuchKey" || error.name === "NotFound") return null;
        throw error;
      }
    },
    async create(key, object) {
      try {
        await client.send(new PutObjectCommand({
          Bucket: config.bucket, Key: key, Body: object.body(), ContentLength: object.size,
          ContentType: object.contentType, ContentDisposition: object.contentDisposition,
          CacheControl: IMMUTABLE, Metadata: { sha256: object.sha256 }, IfNoneMatch: "*",
        }));
        return true;
      } catch (error) {
        if (error.name === "PreconditionFailed" || error.$metadata?.httpStatusCode === 412) return false;
        throw error;
      }
    },
  };
}

async function ensureObject(store, key, object, log) {
  const existing = await store.read(key);
  if (existing) {
    await verifyStream(existing, object, key);
    log(`Verified existing ${key}`);
    return;
  }
  const created = await store.create(key, object);
  // Includes races: another writer may have won conditional creation.
  const stored = await store.read(key);
  if (!stored) throw new MirrorError(`read-back missing for ${key}`);
  await verifyStream(stored, object, key);
  log(`${created ? "Uploaded and verified" : "Verified concurrent upload"} ${key}`);
}

export async function mirrorRelease({ directory, version, store, log = () => {} }) {
  // Check ALL local assets before any object writes, even on reruns.
  const { manifest, manifestBytes } = await prepareRelease(directory, version);
  const manifestKey = `releases/${version}/manifest.json`;
  const manifestObject = {
    size: manifestBytes.length, sha256: createHash("sha256").update(manifestBytes).digest("hex"),
    body: () => manifestBytes, contentType: "application/json; charset=utf-8",
  };
  const existingManifest = await store.read(manifestKey);
  if (existingManifest) await verifyStream(existingManifest, manifestObject, manifestKey);
  for (const artifact of manifest.artifacts) {
    const name = `bud-${artifact.target}.tar.gz`;
    await ensureObject(store, `releases/${version}/${name}`, {
      ...artifact, body: () => createReadStream(path.join(directory, name)),
      contentType: "application/gzip", contentDisposition: `attachment; filename="${name}"`,
    }, log);
  }
  // This immutable marker is published only after all read-backs succeed.
  await ensureObject(store, manifestKey, manifestObject, log);
  return { version, artifacts: manifest.artifacts.length, manifest_key: manifestKey };
}

async function main(args) {
  if (args.length !== 1 || args[0] === "--help") {
    console.log("Usage: node scripts/bud-release-mirror.mjs v0.1.25\nRequires gh authentication, CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. Optional R2_BUCKET, GITHUB_REPOSITORY.");
    if (args[0] !== "--help") process.exitCode = 2;
    return;
  }
  const version = validateVersion(args[0]);
  const config = r2Configuration();
  const directory = await mkdtemp(path.join(os.tmpdir(), "bud-release-mirror-"));
  const store = createR2Store(config);
  try {
    console.log(`Downloading and verifying GitHub release ${version}`);
    await downloadRelease(directory, version, process.env.GITHUB_REPOSITORY ?? "magicloops/bud");
    console.log(JSON.stringify(await mirrorRelease({ directory, version, store, log: console.log })));
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => {
    // SDK/gh error objects can contain request details; do not print secrets.
    if (error instanceof MirrorError) console.error(error.message);
    else if (/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name ?? "")) console.error(`Failure type: ${error.name}`);
    console.error("Release mirroring failed; stable was not changed. Check release assets, R2 credentials/access and rerun after resolving the failure.");
    process.exitCode = 1;
  });
}
