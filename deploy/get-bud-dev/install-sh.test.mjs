import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets", "install.sh");

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bud-install-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function createFakeBudArchive(t, dir, options = {}) {
  const stage = path.join(dir, "stage");
  const archive = path.join(dir, "bud-x86_64-unknown-linux-gnu.tar.gz");
  await mkdir(stage, { recursive: true });
  await writeFile(
    path.join(stage, "bud"),
    [
      "#!/bin/sh",
      'if [ "$1" = "doctor" ]; then',
      '  echo "doctor server=${BUD_SERVER_URL:-} base=${BUD_BASE_DIR:-} terminal=${BUD_TERMINAL_ENABLED:-} claim=${BUD_CLAIM_ID:-}" >> "$BUD_TEST_LOG"',
      options.doctorMessage ? `  echo ${JSON.stringify(options.doctorMessage)} >&2` : "",
      `  exit ${options.doctorExitCode ?? 0}`,
      "fi",
      'echo "bootstrap claim=${BUD_CLAIM_ID:-} server=${BUD_SERVER_URL:-} base=${BUD_BASE_DIR:-}" >> "$BUD_TEST_LOG"',
      "exit 0",
      "",
    ].join("\n"),
  );
  await chmod(path.join(stage, "bud"), 0o755);

  const tar = spawnSync("tar", ["-czf", archive, "-C", stage, "."], {
    encoding: "utf8",
  });
  assert.equal(tar.status, 0, tar.stderr);

  const bytes = await readFile(archive);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  t.after(() => rm(archive, { force: true }));

  return { archive, bytes, sha256 };
}

async function startReleaseServer(t, manifest, archiveBytes) {
  const server = createServer((request, response) => {
    if (request.url === "/releases/stable/manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(manifest, null, 2));
      return;
    }
    if (request.url?.startsWith("/releases/v0.1.0/bud-") && request.url.endsWith(".tar.gz")) {
      response.writeHead(200, { "content-type": "application/gzip" });
      response.end(archiveBytes);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function startRawManifestServer(t, manifestBody) {
  const server = createServer((request, response) => {
    if (request.url === "/releases/stable/manifest.json") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(manifestBody);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found\n");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function manifestFor(baseUrl, sha256, target = "x86_64-unknown-linux-gnu") {
  return {
    version: "v0.1.0",
    channel: "stable",
    published_at: "2026-05-30T00:00:00Z",
    artifacts: [
      {
        target,
        url: `${baseUrl}/releases/v0.1.0/bud-${target}.tar.gz`,
        sha256,
        min_os: "glibc 2.35",
        size: 123,
      },
    ],
  };
}

async function runInstall(env) {
  const child = spawn("sh", [scriptPath], {
    env: {
      ...process.env,
      HOME: env.HOME,
      BUD_INSTALL_OS: "Linux",
      BUD_INSTALL_ARCH: "x86_64",
      BUD_INSTALL_GLIBC_VERSION: "2.35",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on("exit", resolve));
  return { code, stdout, stderr };
}

test("install.sh installs verified artifact and passes claim only to bootstrap", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const installRoot = path.join(dir, "home", ".bud");
  const logPath = path.join(dir, "bud.log");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_TEST_LOG: logPath,
    BUD_CLAIM_ID: "bic_test",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok((await stat(path.join(installRoot, "bin", "bud"))).isFile());
  assert.equal((await readFile(path.join(installRoot, "bud.env"), "utf8")).includes("bic_test"), false);
  const fakeLog = await readFile(logPath, "utf8");
  assert.match(
    fakeLog,
    new RegExp(`^doctor server=wss://api\\.bud\\.dev/ws base=${escapeRegExp(installRoot)} terminal=true claim=$`, "m"),
  );
  assert.match(fakeLog, /bootstrap claim=bic_test server=wss:\/\/api\.bud\.dev\/ws base=/);
});

test("install.sh maps supported hosts to release targets", async (t) => {
  const cases = [
    {
      name: "macOS arm64",
      target: "aarch64-apple-darwin",
      env: {
        BUD_INSTALL_OS: "Darwin",
        BUD_INSTALL_ARCH: "arm64",
        BUD_INSTALL_MACOS_VERSION: "13.0",
      },
    },
    {
      name: "macOS x86_64",
      target: "x86_64-apple-darwin",
      env: {
        BUD_INSTALL_OS: "Darwin",
        BUD_INSTALL_ARCH: "x86_64",
        BUD_INSTALL_MACOS_VERSION: "13.0",
      },
    },
    {
      name: "Ubuntu x86_64",
      target: "x86_64-unknown-linux-gnu",
      env: {
        BUD_INSTALL_OS: "Linux",
        BUD_INSTALL_ARCH: "x86_64",
        BUD_INSTALL_GLIBC_VERSION: "2.35",
      },
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async (t) => {
      const dir = await tempDir(t);
      const { bytes, sha256 } = await createFakeBudArchive(t, dir);
      const placeholder = "http://127.0.0.1:1";
      const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256, testCase.target), bytes);
      const server = await startReleaseServer(t, manifestFor(serverBase, sha256, testCase.target), bytes);
      const installRoot = path.join(dir, "home", ".bud");
      const logPath = path.join(dir, "bud.log");

      const result = await runInstall({
        HOME: path.join(dir, "home"),
        BUD_INSTALL_BASE_URL: server,
        BUD_INSTALL_ROOT: installRoot,
        BUD_INSTALL_SKIP_BOOTSTRAP: "1",
        BUD_TEST_LOG: logPath,
        ...testCase.env,
      });

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stderr, new RegExp(`Downloading Bud for ${testCase.target}`));
      assert.ok((await stat(path.join(installRoot, "bin", "bud"))).isFile());
    });
  }
});

test("install.sh aborts before install when checksum mismatches", async (t) => {
  const dir = await tempDir(t);
  const { bytes } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, "0".repeat(64)), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, "0".repeat(64)), bytes);
  const installRoot = path.join(dir, "home", ".bud");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /checksum mismatch/);
  await assert.rejects(() => stat(path.join(installRoot, "bin", "bud")));
});

test("install.sh fails closed when the stable manifest is malformed", async (t) => {
  const dir = await tempDir(t);
  const server = await startRawManifestServer(t, "{ this is not release metadata\n");
  const installRoot = path.join(dir, "home", ".bud");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /manifest did not contain artifact URL/);
  await assert.rejects(() => stat(path.join(installRoot, "bin", "bud")));
});

test("install.sh fails closed when the stable manifest has no matching target", async (t) => {
  const dir = await tempDir(t);
  const server = await startReleaseServer(
    t,
    {
      version: "v0.1.0",
      channel: "stable",
      artifacts: [
        {
          target: "aarch64-apple-darwin",
          url: "https://get.bud.dev/releases/v0.1.0/bud-aarch64-apple-darwin.tar.gz",
          sha256: "0".repeat(64),
        },
      ],
    },
    Buffer.from("unused"),
  );
  const installRoot = path.join(dir, "home", ".bud");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /manifest did not contain artifact URL for x86_64-unknown-linux-gnu/);
  await assert.rejects(() => stat(path.join(installRoot, "bin", "bud")));
});

test("install.sh leaves an existing binary untouched when artifact download fails", async (t) => {
  const dir = await tempDir(t);
  const serverBase = await startReleaseServer(t, manifestFor("http://127.0.0.1:1", "0".repeat(64)), Buffer.from(""));
  const manifest = manifestFor(serverBase, "0".repeat(64));
  manifest.artifacts[0].url = `${serverBase}/releases/v0.1.0/missing.tar.gz`;
  const server = await startReleaseServer(t, manifest, Buffer.from(""));
  const installRoot = path.join(dir, "home", ".bud");
  const binDir = path.join(installRoot, "bin");
  const budBin = path.join(binDir, "bud");
  await mkdir(binDir, { recursive: true });
  await writeFile(budBin, "existing-binary\n");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Downloading Bud for x86_64-unknown-linux-gnu/);
  assert.equal(await readFile(budBin, "utf8"), "existing-binary\n");
});

test("install.sh surfaces bud doctor dependency remediation without failing install", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir, {
    doctorExitCode: 1,
    doctorMessage: "tmux is missing; install it with: brew install tmux",
  });
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const installRoot = path.join(dir, "home", ".bud");
  const logPath = path.join(dir, "bud.log");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
    BUD_TEST_LOG: logPath,
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /tmux is missing/);
  assert.match(result.stderr, /Bud preflight reported issues/);
  assert.ok((await stat(path.join(installRoot, "bin", "bud"))).isFile());
  assert.match(
    await readFile(logPath, "utf8"),
    new RegExp(`^doctor server=wss://api\\.bud\\.dev/ws base=${escapeRegExp(installRoot)} terminal=true claim=$`, "m"),
  );
});

test("install.sh refuses to redeem a new claim over existing identity", async (t) => {
  const dir = await tempDir(t);
  const installRoot = path.join(dir, "home", ".bud");
  await mkdir(installRoot, { recursive: true });
  await writeFile(path.join(installRoot, "identity.json"), "{}\n");

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: "http://127.0.0.1:1",
    BUD_INSTALL_ROOT: installRoot,
    BUD_CLAIM_ID: "bic_test",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /existing Bud identity/);
});

test("install.sh rejects unsupported host before downloading", async (t) => {
  const dir = await tempDir(t);
  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: "http://127.0.0.1:1",
    BUD_INSTALL_OS: "Plan9",
    BUD_INSTALL_ARCH: "mips",
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /unsupported OS\/architecture/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
