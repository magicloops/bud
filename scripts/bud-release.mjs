#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_TARGETS = Object.freeze([
  {
    target: "aarch64-apple-darwin",
    min_os: "macOS 13",
  },
  {
    target: "x86_64-apple-darwin",
    min_os: "macOS 13",
  },
  {
    target: "x86_64-unknown-linux-gnu",
    min_os: "glibc 2.35",
  },
]);

const TARGET_BY_OS_ARCH = new Map([
  ["darwin:arm64", "aarch64-apple-darwin"],
  ["darwin:x64", "x86_64-apple-darwin"],
  ["linux:x64", "x86_64-unknown-linux-gnu"],
]);

const MIN_OS_BY_TARGET = new Map(REQUIRED_TARGETS.map((entry) => [entry.target, entry.min_os]));

export function normalizeVersion(version) {
  if (!version || typeof version !== "string") {
    throw new Error("release version is required");
  }
  const trimmed = version.trim();
  if (!trimmed) {
    throw new Error("release version cannot be empty");
  }
  return trimmed.startsWith("v") ? trimmed : `v${trimmed}`;
}

export function targetForPlatform(platform = process.platform, arch = process.arch) {
  const target = TARGET_BY_OS_ARCH.get(`${platform}:${arch}`);
  if (!target) {
    throw new Error(`unsupported Bud release platform: ${platform}/${arch}`);
  }
  return target;
}

export function selectManifestArtifact(manifest, platform = process.platform, arch = process.arch) {
  validateManifestShape(manifest);
  const target = targetForPlatform(platform, arch);
  const artifact = manifest.artifacts.find((candidate) => candidate.target === target);
  if (!artifact) {
    throw new Error(`manifest does not contain artifact for ${target}`);
  }
  return artifact;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

export async function verifyArtifactSha256(filePath, expectedSha256) {
  const actualSha256 = await sha256File(filePath);
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(
      `checksum mismatch for ${filePath}: expected ${expectedSha256}, got ${actualSha256}`,
    );
  }
  return actualSha256;
}

export async function packageArtifact(options) {
  const target = requiredOption(options, "target");
  const version = normalizeVersion(requiredOption(options, "version"));
  const binaryPath = path.resolve(requiredOption(options, "binary"));
  const outDir = path.resolve(options.out ?? "dist/bud-release");
  const minOs = options.minOs ?? MIN_OS_BY_TARGET.get(target);
  if (!minOs) {
    throw new Error(`min_os is required for unsupported target ${target}`);
  }
  if (!existsSync(binaryPath)) {
    throw new Error(`bud binary does not exist: ${binaryPath}`);
  }

  await mkdir(outDir, { recursive: true });
  const stageDir = path.join(outDir, ".stage", version, target);
  await rm(stageDir, { recursive: true, force: true });
  await mkdir(stageDir, { recursive: true });

  const stagedBinary = path.join(stageDir, "bud");
  await copyFile(binaryPath, stagedBinary);
  await chmod(stagedBinary, 0o755);

  const repoRoot = path.resolve(options.repoRoot ?? path.dirname(fileURLToPath(import.meta.url)), "..");
  const licensePath = path.join(repoRoot, "LICENSE");
  if (existsSync(licensePath)) {
    await copyFile(licensePath, path.join(stageDir, "LICENSE"));
  }

  await writeFile(
    path.join(stageDir, "README.md"),
    [
      `# Bud ${version}`,
      "",
      `Target: ${target}`,
      `Minimum OS: ${minOs}`,
      "",
      "This archive contains the Bud daemon binary.",
      "Installers should verify the archive SHA-256 against the release manifest before use.",
      "",
      "Support: https://bud.dev/support",
      "",
    ].join("\n"),
  );

  const artifactName = `bud-${target}.tar.gz`;
  const archivePath = path.join(outDir, artifactName);
  await run("tar", ["-czf", archivePath, "-C", stageDir, "."]);

  const sha256 = await sha256File(archivePath);
  const archiveStats = await stat(archivePath);
  const metadata = {
    target,
    artifact_name: artifactName,
    path: archivePath,
    version,
    sha256,
    min_os: minOs,
    size: archiveStats.size,
  };
  const metadataPath = path.join(outDir, `bud-${target}.json`);
  await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  return {
    ...metadata,
    metadata_path: metadataPath,
  };
}

export async function buildManifest(options) {
  const version = normalizeVersion(requiredOption(options, "version"));
  const channel = options.channel ?? "stable";
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const baseUrl = (options.baseUrl ?? "https://get.bud.dev").replace(/\/+$/, "");
  const metadataFiles = await resolveMetadataFiles(options);
  if (metadataFiles.length === 0) {
    throw new Error("at least one artifact metadata file is required");
  }

  const artifacts = [];
  for (const metadataFile of metadataFiles) {
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    artifacts.push({
      target: metadata.target,
      url:
        metadata.url ??
        `${baseUrl}/releases/${version}/${requiredMetadata(metadata, "artifact_name")}`,
      sha256: requiredMetadata(metadata, "sha256"),
      min_os: requiredMetadata(metadata, "min_os"),
      size: Number(requiredMetadata(metadata, "size")),
    });
  }
  artifacts.sort((a, b) => a.target.localeCompare(b.target));

  const manifest = {
    version,
    channel,
    published_at: publishedAt,
    artifacts,
  };
  validateManifestShape(manifest);

  if (options.out) {
    const outPath = path.resolve(options.out);
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  return manifest;
}

export function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("manifest must be an object");
  }
  for (const field of ["version", "channel", "published_at"]) {
    if (typeof manifest[field] !== "string" || manifest[field].length === 0) {
      throw new Error(`manifest.${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error("manifest.artifacts must be a non-empty array");
  }
  for (const artifact of manifest.artifacts) {
    for (const field of ["target", "url", "sha256", "min_os"]) {
      if (typeof artifact[field] !== "string" || artifact[field].length === 0) {
        throw new Error(`artifact.${field} must be a non-empty string`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw new Error(`artifact.sha256 must be 64 lowercase hex chars for ${artifact.target}`);
    }
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) {
      throw new Error(`artifact.size must be a positive integer for ${artifact.target}`);
    }
  }
}

async function resolveMetadataFiles(options) {
  if (options.metadataDir) {
    const metadataDir = path.resolve(options.metadataDir);
    const entries = await readdir(metadataDir);
    return entries
      .filter((entry) => /^bud-.+\.json$/.test(entry))
      .map((entry) => path.join(metadataDir, entry))
      .sort();
  }
  return (options.metadataFiles ?? []).map((metadataFile) => path.resolve(metadataFile));
}

function requiredMetadata(metadata, field) {
  if (metadata[field] === undefined || metadata[field] === null || metadata[field] === "") {
    throw new Error(`artifact metadata missing ${field}`);
  }
  return metadata[field];
}

function requiredOption(options, name) {
  if (!options?.[name]) {
    throw new Error(`--${kebab(name)} is required`);
  }
  return options[name];
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated with signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

function parseArgs(rawArgs) {
  const parsed = {
    _: [],
    metadataFiles: [],
  };
  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = rawArgs[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    i += 1;
    if (key === "metadataFile") {
      parsed.metadataFiles.push(next);
    } else {
      parsed[key] = next;
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage:",
    "  node scripts/bud-release.mjs package --target <triple> --version <vX.Y.Z> --binary <path> --out <dir> [--min-os <value>]",
    "  node scripts/bud-release.mjs manifest --version <vX.Y.Z> --channel stable --base-url https://get.bud.dev --metadata-dir <dir> --out <path>",
    "  node scripts/bud-release.mjs detect-target",
    "  node scripts/bud-release.mjs verify --file <path> --sha256 <hex>",
  ].join("\n");
}

async function main() {
  const [command, ...rawArgs] = process.argv.slice(2);
  const options = parseArgs(rawArgs);

  if (command === "package") {
    const metadata = await packageArtifact(options);
    console.log(JSON.stringify(metadata, null, 2));
    return;
  }

  if (command === "manifest") {
    const manifest = await buildManifest(options);
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  if (command === "detect-target") {
    console.log(targetForPlatform());
    return;
  }

  if (command === "verify") {
    const sha256 = await verifyArtifactSha256(
      requiredOption(options, "file"),
      requiredOption(options, "sha256"),
    );
    console.log(sha256);
    return;
  }

  console.error(usage());
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
