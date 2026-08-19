import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      'if [ "$1" = "claim" ]; then',
      '  echo "claim claim=${BUD_CLAIM_ID:-} server=${BUD_SERVER_URL:-} base=${BUD_BASE_DIR:-}" >> "$BUD_TEST_LOG"',
      `  exit ${options.claimExitCode ?? 0}`,
      "fi",
      'if [ "$1" = "llm" ]; then',
      '  echo "llm $2 ${3:-} ${4:-} ${5:-}" >> "$BUD_TEST_LOG"',
      'if [ "$2" = "probe" ]; then',
      '  case "$*" in',
      `    *--require-validated*) exit ${options.llmProbeValidatedExitCode ?? 1} ;;`,
      `    *) exit ${options.llmProbeExitCode ?? 1} ;;`,
      "  esac",
      "fi",
      `  exit ${options.llmEnableExitCode ?? 0}`,
      "fi",
      'if [ "$1" = "service" ]; then',
      '  echo "service $2 server=${BUD_SERVER_URL:-} base=${BUD_BASE_DIR:-}" >> "$BUD_TEST_LOG"',
      `  exit ${options.serviceExitCode ?? 0}`,
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
      // PATH setup would prompt on /dev/tty when the test runner has one;
      // keep tests deterministic (individual tests override these knobs).
      BUD_INSTALL_NO_MODIFY_PATH: "1",
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
    new RegExp(`^doctor server=wss://app\\.bud\\.dev/ws base=${escapeRegExp(installRoot)} terminal=true claim=$`, "m"),
  );
  assert.match(fakeLog, /claim claim=bic_test server=wss:\/\/app\.bud\.dev\/ws base=/);
  assert.match(fakeLog, /service install server=wss:\/\/app\.bud\.dev\/ws base=/);
  assert.doesNotMatch(fakeLog, /bootstrap/, "background flow must not exec the foreground daemon");
});

test("install.sh falls back to foreground when service install fails", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir, { serviceExitCode: 1 });
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
  });

  assert.equal(result.code, 0, result.stderr);
  const fakeLog = await readFile(logPath, "utf8");
  assert.match(fakeLog, /claim claim= server=/);
  assert.match(fakeLog, /service install/);
  assert.match(fakeLog, /bootstrap claim= server=/, "foreground fallback runs the daemon");
});

test("install.sh honors BUD_INSTALL_FOREGROUND=1 (no claim/service handoff)", async (t) => {
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
    BUD_INSTALL_FOREGROUND: "1",
    BUD_CLAIM_ID: "bic_fg",
  });

  assert.equal(result.code, 0, result.stderr);
  const fakeLog = await readFile(logPath, "utf8");
  assert.match(fakeLog, /bootstrap claim=bic_fg server=/);
  assert.doesNotMatch(fakeLog, /claim claim=bic_fg server=.*\n.*service/s);
  assert.doesNotMatch(fakeLog, /service install/);
});

test("install.sh reinstalls over an existing binary via atomic rename", async (t) => {
  // Regression: a live daemon executing bin/bud made in-place `cp` fail on
  // Linux with ETXTBSY. The installer must stage-and-rename instead; rename
  // swaps the directory entry without touching the executing inode. (A shell
  // fixture cannot reproduce ETXTBSY itself — the interpreter, not the
  // script, is the busy text file — so this asserts the swap path and that
  // no staged temp file is left behind.)
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const installRoot = path.join(dir, "home", ".bud");
  const binDir = path.join(installRoot, "bin");
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, "bud"), "#!/bin/sh\nsleep 30\n");
  await chmod(path.join(binDir, "bud"), 0o755);
  const running = spawn(path.join(binDir, "bud"), [], { stdio: "ignore" });
  t.after(() => running.kill("SIGKILL"));

  const result = await runInstall({
    HOME: path.join(dir, "home"),
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: installRoot,
    BUD_TEST_LOG: path.join(dir, "bud.log"),
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  });

  assert.equal(result.code, 0, result.stderr);
  const installed = await readFile(path.join(binDir, "bud"), "utf8");
  assert.match(installed, /BUD_TEST_LOG/, "new binary content replaced the old one");
  const leftovers = (await readdir(binDir)).filter((name) => name.startsWith(".bud.install."));
  assert.deepEqual(leftovers, [], "no staged temp files left behind");
});

test("install.sh adds bud to PATH with confirmation knobs", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const home = path.join(dir, "home");
  const zshrc = path.join(home, ".zshrc");
  const base = {
    HOME: home,
    SHELL: "/bin/zsh",
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: path.join(home, ".bud"),
    BUD_TEST_LOG: path.join(dir, "bud.log"),
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
  };

  // Forced yes: appends the export line to the shell profile.
  let result = await runInstall({ ...base, BUD_INSTALL_NO_MODIFY_PATH: "", BUD_INSTALL_MODIFY_PATH: "1" });
  assert.equal(result.code, 0, result.stderr);
  const rc = await readFile(zshrc, "utf8");
  assert.match(rc, /# Added by the Bud installer/);
  // The activation hint must be repeated at the END of the install output so
  // it survives the claim/service scrollback.
  assert.match(result.stderr.trimEnd(), /source .*\.zshrc\s*\n\(new terminals pick it up automatically\)$/);
  assert.match(rc, /export PATH='[^']*\.bud\/bin':"\$PATH"/);

  // Idempotent: a second run must not duplicate the block.
  result = await runInstall({ ...base, BUD_INSTALL_NO_MODIFY_PATH: "", BUD_INSTALL_MODIFY_PATH: "1" });
  assert.equal(result.code, 0, result.stderr);
  const rcAgain = await readFile(zshrc, "utf8");
  assert.equal(rcAgain.split("Added by the Bud installer").length, 2, "single PATH block");

  // Non-interactive without knobs (no tty in the spawned shell): profiles are
  // never edited silently; the installer prints the manual export hint.
  const home2 = path.join(dir, "home2");
  result = await runInstall({
    ...base,
    HOME: home2,
    BUD_INSTALL_ROOT: path.join(home2, ".bud"),
    BUD_INSTALL_NO_MODIFY_PATH: "",
  });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(() => stat(path.join(home2, ".zshrc")), "no silent profile edit");
  assert.match(result.stderr, /add it to your PATH/);

  // Explicit opt-out stays silent about profiles entirely.
  const home3 = path.join(dir, "home3");
  result = await runInstall({
    ...base,
    HOME: home3,
    BUD_INSTALL_ROOT: path.join(home3, ".bud"),
    BUD_INSTALL_NO_MODIFY_PATH: "1",
  });
  assert.equal(result.code, 0, result.stderr);
  await assert.rejects(() => stat(path.join(home3, ".zshrc")));
});

test("install.sh writes fish PATH config via conf.d", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const home = path.join(dir, "home");

  const result = await runInstall({
    HOME: home,
    SHELL: "/usr/bin/fish",
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: path.join(home, ".bud"),
    BUD_TEST_LOG: path.join(dir, "bud.log"),
    BUD_INSTALL_SKIP_BOOTSTRAP: "1",
    BUD_INSTALL_NO_MODIFY_PATH: "",
    BUD_INSTALL_MODIFY_PATH: "1",
  });
  assert.equal(result.code, 0, result.stderr);
  const conf = await readFile(path.join(home, ".config", "fish", "conf.d", "bud.fish"), "utf8");
  assert.match(conf, /fish_add_path -g .*\.bud\/bin/);
});

test("install.sh configures local LLM via BUD_INSTALL_DS4_URL and probe path", async (t) => {
  const dir = await tempDir(t);
  const { bytes, sha256 } = await createFakeBudArchive(t, dir);
  const placeholder = "http://127.0.0.1:1";
  const serverBase = await startReleaseServer(t, manifestFor(placeholder, sha256), bytes);
  const server = await startReleaseServer(t, manifestFor(serverBase, sha256), bytes);
  const home = path.join(dir, "home");
  const logPath = path.join(dir, "bud.log");
  const base = {
    HOME: home,
    BUD_INSTALL_BASE_URL: server,
    BUD_INSTALL_ROOT: path.join(home, ".bud"),
    BUD_TEST_LOG: logPath,
  };

  // Explicit URL: enabled without probing candidates.
  let result = await runInstall({ ...base, BUD_INSTALL_DS4_URL: "http://127.0.0.1:8888/v1" });
  assert.equal(result.code, 0, result.stderr);
  let fakeLog = await readFile(logPath, "utf8");
  assert.match(fakeLog, /llm enable http:\/\/127\.0\.0\.1:8888\/v1/);
  assert.doesNotMatch(fakeLog, /llm probe/);

  // Probe hit without a tty: never enables silently, prints the manual hint.
  // (The probe exit code is baked into the fake binary, so this scenario
  // ships its own archive.)
  await rm(logPath, { force: true });
  const dir2 = await tempDir(t);
  const probeArchive = await createFakeBudArchive(t, dir2, { llmProbeExitCode: 0 });
  const probeBase2 = await startReleaseServer(t, manifestFor(placeholder, probeArchive.sha256), probeArchive.bytes);
  const probeServer = await startReleaseServer(t, manifestFor(probeBase2, probeArchive.sha256), probeArchive.bytes);
  const home2 = path.join(dir2, "home2");
  result = await runInstall({
    ...base,
    HOME: home2,
    BUD_INSTALL_BASE_URL: probeServer,
    BUD_INSTALL_ROOT: path.join(home2, ".bud"),
  });
  assert.equal(result.code, 0, result.stderr);
  fakeLog = await readFile(logPath, "utf8");
  assert.match(fakeLog, /llm probe --url http:\/\/127\.0\.0\.1:8888\/v1 --require-validated/);
  assert.match(fakeLog, /llm probe --url http:\/\/127\.0\.0\.1:8888\/v1 \n/m);
  assert.doesNotMatch(fakeLog, /llm enable/);
  assert.match(result.stderr, /experimental models/);
  assert.match(result.stderr, /Enable it with/);

  // Opt-out skips everything.
  await rm(logPath, { force: true });
  const home3 = path.join(dir, "home3");
  result = await runInstall({
    ...base,
    HOME: home3,
    BUD_INSTALL_ROOT: path.join(home3, ".bud"),
    BUD_INSTALL_NO_LLM_PROBE: "1",
  });
  assert.equal(result.code, 0, result.stderr);
  fakeLog = await readFile(logPath, "utf8");
  assert.doesNotMatch(fakeLog, /llm/);
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
    {
      name: "Ubuntu aarch64",
      target: "aarch64-unknown-linux-gnu",
      env: {
        BUD_INSTALL_OS: "Linux",
        BUD_INSTALL_ARCH: "aarch64",
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
    doctorMessage: "holder smoke check failed: terminal sessions will not work until a holder can be spawned",
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
  assert.match(result.stderr, /holder smoke check failed/);
  assert.match(result.stderr, /Bud preflight reported issues/);
  assert.ok((await stat(path.join(installRoot, "bin", "bud"))).isFile());
  assert.match(
    await readFile(logPath, "utf8"),
    new RegExp(`^doctor server=wss://app\\.bud\\.dev/ws base=${escapeRegExp(installRoot)} terminal=true claim=$`, "m"),
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
