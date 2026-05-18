#!/usr/bin/env node

import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import dns from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import net from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");
const serviceDir = resolve(rootDir, "service");
const webDir = resolve(rootDir, "web");

const SERVICE_HOST = "127.0.0.1";
const SERVICE_PORT = 3000;
const WEB_HOST = "localhost";
const WEB_PORT = 5173;
const CADDY_HOST = "localhost";
const CADDY_PORT = 3443;
const HTTPS_ORIGIN = "https://localhost:3443";
const API_AUDIENCE = `${HTTPS_ORIGIN}/api`;
const AUTH_ISSUER = `${HTTPS_ORIGIN}/api/auth`;
const JWKS_URL = `${AUTH_ISSUER}/jwks`;
const PROXY_BASE_DOMAIN = "bud-show.test";
const LEGACY_PROXY_BASE_DOMAIN = "bud-proxy.localhost";
const PROXY_DNS_TEST_HOST = `smoke.${PROXY_BASE_DOMAIN}`;
const PROXY_DNS_WILDCARD_TEST_HOST = `wildcard-${process.pid}.${PROXY_BASE_DOMAIN}`;
const PROXY_DNS_EXPECTED_ADDRESS = "127.0.0.1";
const REQUIRED_CERT_DNS_NAMES = [
  "localhost",
  PROXY_BASE_DOMAIN,
  `*.${PROXY_BASE_DOMAIN}`,
];
const CERT_DIR = resolve(rootDir, ".certs");
const CERT_FILE = resolve(CERT_DIR, "bud-local.pem");
const KEY_FILE = resolve(CERT_DIR, "bud-local-key.pem");
const CADDYFILE = resolve(rootDir, "dev/caddy/Caddyfile.https-local");
const SHUTDOWN_TIMEOUT_MS = 5_000;

class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserError";
  }
}

function log(message = "") {
  console.log(`[dev:https] ${message}`);
}

function printHelp() {
  console.log(`Usage: node dev/local-https.mjs <command>

Commands:
  setup          Install/validate mkcert root, generate .certs files, and check DNS
  start          Start service, web, and Caddy for https://localhost:3443
  check          Check an already-running local HTTPS profile
  provision-ios  Run local iOS OAuth provisioning with HTTPS profile env
  print-env      Print the derived HTTPS profile environment

Repo scripts:
  pnpm dev:https:setup
  pnpm dev:https
  pnpm dev:https:check
  pnpm dev:https:provision-ios`);
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatCommand(command, args = []) {
  return [command, ...args].join(" ");
}

function runCapture(command, args, options = {}) {
  const {
    cwd = rootDir,
    env = process.env,
    timeoutMs = 15_000,
  } = options;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new UserError(`${formatCommand(command, args)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectRun(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }

      const detail = stderr.trim() || stdout.trim() || `exit ${code ?? signal}`;
      rejectRun(new UserError(`${formatCommand(command, args)} failed: ${detail}`));
    });
  });
}

function runInherited(command, args, options = {}) {
  const { cwd = rootDir, env = process.env } = options;

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });

    child.on("error", rejectRun);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new UserError(`${formatCommand(command, args)} failed with ${code ?? signal}`));
    });
  });
}

async function commandMustExist(command, args, installHint) {
  try {
    await runCapture(command, args);
  } catch (err) {
    const suffix = installHint ? ` ${installHint}` : "";
    throw new UserError(`Required command not available: ${command}.${suffix}`);
  }
}

function dnsmasqRunbook() {
  return `Configure local wildcard DNS for ${PROXY_BASE_DOMAIN}:

  brew install dnsmasq
  mkdir -p "$(brew --prefix)/etc/dnsmasq.d"
  printf 'port=53\\nlisten-address=127.0.0.1\\naddress=/${PROXY_BASE_DOMAIN}/${PROXY_DNS_EXPECTED_ADDRESS}\\n' > "$(brew --prefix)/etc/dnsmasq.d/${PROXY_BASE_DOMAIN}.conf"
  grep -q 'dnsmasq.d' "$(brew --prefix)/etc/dnsmasq.conf" 2>/dev/null || printf 'conf-dir=$(brew --prefix)/etc/dnsmasq.d/,*.conf\\n' >> "$(brew --prefix)/etc/dnsmasq.conf"
  sudo mkdir -p /etc/resolver
  printf 'nameserver 127.0.0.1\\n' | sudo tee /etc/resolver/test
  sudo brew services restart dnsmasq

macOS note: keep this scoped resolver path on port 53. If 127.0.0.1:53
is unavailable, use a loopback alias on port 53 and put that address in
/etc/resolver/test; do not point /etc/resolver/test at a non-53 dnsmasq port.

Then verify:

  dscacheutil -q host -a name ${PROXY_DNS_TEST_HOST}`;
}

async function assertLocalHttpsDnsConfigured() {
  try {
    await dns.lookup("localhost", { all: true });
  } catch (err) {
    throw new UserError(`localhost did not resolve through the system resolver: ${err.message}`);
  }

  for (const host of [PROXY_DNS_TEST_HOST, PROXY_DNS_WILDCARD_TEST_HOST]) {
    let addresses;
    try {
      addresses = await dns.lookup(host, { all: true, family: 4 });
    } catch (err) {
      throw new UserError(
        `${host} did not resolve to ${PROXY_DNS_EXPECTED_ADDRESS}.\n\n${dnsmasqRunbook()}`,
      );
    }

    const resolvedAddresses = addresses.map((entry) => entry.address);
    if (!resolvedAddresses.includes(PROXY_DNS_EXPECTED_ADDRESS)) {
      throw new UserError(
        `${host} resolved to ${resolvedAddresses.join(", ") || "(no addresses)"}, expected ${PROXY_DNS_EXPECTED_ADDRESS}.\n\n${dnsmasqRunbook()}`,
      );
    }
  }
}

async function resolveMkcertRoot() {
  try {
    const { stdout } = await runCapture("mkcert", ["-CAROOT"]);
    const caRoot = stdout.trim();
    if (!caRoot) {
      throw new UserError("mkcert -CAROOT returned an empty path");
    }
    return caRoot;
  } catch (err) {
    if (err instanceof UserError) {
      throw err;
    }
    throw new UserError("Required command not available: mkcert. Install it with: brew install mkcert");
  }
}

async function resolveRootCaPath() {
  const caRoot = await resolveMkcertRoot();
  const rootCaPath = resolve(caRoot, "rootCA.pem");
  if (!existsSync(rootCaPath)) {
    throw new UserError(`mkcert root CA not found at ${rootCaPath}. Run: pnpm dev:https:setup`);
  }
  return rootCaPath;
}

function ensureCertFiles() {
  const missing = [];
  if (!existsSync(CERT_FILE)) {
    missing.push(CERT_FILE);
  }
  if (!existsSync(KEY_FILE)) {
    missing.push(KEY_FILE);
  }
  if (missing.length > 0) {
    throw new UserError(
      `Missing local HTTPS certificate file(s):\n${missing.map((path) => `  - ${path}`).join("\n")}\nRun: pnpm dev:https:setup`,
    );
  }

  const missingDnsNames = missingCertificateDnsNames();
  if (missingDnsNames.length > 0) {
    throw new UserError(
      `Local HTTPS certificate is missing required DNS name(s): ${missingDnsNames.join(", ")}\nRun: pnpm dev:https:setup -- --force`,
    );
  }
}

function missingCertificateDnsNames() {
  if (!existsSync(CERT_FILE)) {
    return REQUIRED_CERT_DNS_NAMES;
  }

  let certificate;
  try {
    certificate = new X509Certificate(readFileSync(CERT_FILE));
  } catch {
    return REQUIRED_CERT_DNS_NAMES;
  }

  const subjectAltName = certificate.subjectAltName ?? "";
  return REQUIRED_CERT_DNS_NAMES.filter((name) => !subjectAltName.includes(`DNS:${name}`));
}

function buildServiceEnv(rootCaPath) {
  return {
    ...process.env,
    HOST: SERVICE_HOST,
    PORT: String(SERVICE_PORT),
    APP_BASE_URL: HTTPS_ORIGIN,
    BETTER_AUTH_URL: HTTPS_ORIGIN,
    API_AUDIENCE,
    BETTER_AUTH_TRUSTED_ORIGINS: `${HTTPS_ORIGIN},http://localhost:5173,http://localhost:3000`,
    OAUTH_TRUSTED_CLIENT_IDS: "bud-ios-dev-local",
    PROXY_PUBLIC_SCHEME: "https",
    PROXY_BASE_DOMAIN,
    PROXY_PUBLIC_PORT: "3443",
    PROXY_VIEWER_COOKIE_NAME: "__Host-bud_proxy_viewer",
    NODE_EXTRA_CA_CERTS: rootCaPath,
  };
}

function buildWebEnv(rootCaPath) {
  return {
    ...process.env,
    NODE_EXTRA_CA_CERTS: rootCaPath,
    VITE_API_BASE_URL: "",
    VITE_API_PROXY_TARGET: `http://${SERVICE_HOST}:${SERVICE_PORT}`,
  };
}

function buildCaddyEnv() {
  return {
    ...process.env,
  };
}

function printDerivedEnv(rootCaPath) {
  console.log(`NODE_EXTRA_CA_CERTS=${rootCaPath}`);
  console.log(`APP_BASE_URL=${HTTPS_ORIGIN}`);
  console.log(`BETTER_AUTH_URL=${HTTPS_ORIGIN}`);
  console.log(`API_AUDIENCE=${API_AUDIENCE}`);
  console.log(`BETTER_AUTH_TRUSTED_ORIGINS=${HTTPS_ORIGIN},http://localhost:5173,http://localhost:3000`);
  console.log("OAUTH_TRUSTED_CLIENT_IDS=bud-ios-dev-local");
  console.log("PROXY_PUBLIC_SCHEME=https");
  console.log(`PROXY_BASE_DOMAIN=${PROXY_BASE_DOMAIN}`);
  console.log("PROXY_PUBLIC_PORT=3443");
  console.log("PROXY_VIEWER_COOKIE_NAME=__Host-bud_proxy_viewer");
  console.log("VITE_API_BASE_URL=");
  console.log(`VITE_API_PROXY_TARGET=http://${SERVICE_HOST}:${SERVICE_PORT}`);
}

async function setup() {
  await commandMustExist("mkcert", ["-help"], "Install it with: brew install mkcert");
  await commandMustExist("caddy", ["version"], "Install it with: brew install caddy");

  log("Installing or validating the mkcert local root. This may prompt for your macOS password.");
  await runInherited("mkcert", ["-install"]);

  mkdirSync(CERT_DIR, { recursive: true });

  const certFilesExist = existsSync(CERT_FILE) && existsSync(KEY_FILE);
  const missingDnsNames = certFilesExist ? missingCertificateDnsNames() : REQUIRED_CERT_DNS_NAMES;
  if (certFilesExist && missingDnsNames.length === 0 && !process.argv.includes("--force")) {
    log(`Certificate files already exist:
  ${CERT_FILE}
  ${KEY_FILE}
Use pnpm dev:https:setup -- --force to regenerate them.`);
  } else {
    if (certFilesExist && missingDnsNames.length > 0) {
      log(`Regenerating local certificate because it is missing: ${missingDnsNames.join(", ")}`);
    } else {
      log("Generating repo-local Caddy certificate files.");
    }
    await runInherited("mkcert", [
      "-cert-file",
      CERT_FILE,
      "-key-file",
      KEY_FILE,
      "localhost",
      "127.0.0.1",
      "::1",
      PROXY_BASE_DOMAIN,
      `*.${PROXY_BASE_DOMAIN}`,
      LEGACY_PROXY_BASE_DOMAIN,
      `*.${LEGACY_PROXY_BASE_DOMAIN}`,
    ]);
  }

  const rootCaPath = await resolveRootCaPath();
  await assertLocalHttpsDnsConfigured();
  log(`mkcert root: ${rootCaPath}`);
  log(`Caddy cert: ${CERT_FILE}`);
  log(`Caddy key:  ${KEY_FILE}`);
  log(`Local HTTPS origin: ${HTTPS_ORIGIN}`);
  log(`Proxy endpoint base domain: ${PROXY_BASE_DOMAIN}`);
  log(`Wildcard DNS resolves ${PROXY_DNS_TEST_HOST} and ${PROXY_DNS_WILDCARD_TEST_HOST} to ${PROXY_DNS_EXPECTED_ADDRESS}`);
}

function waitForTcp(host, port, label, timeoutMs = 60_000) {
  const startedAt = Date.now();

  return new Promise((resolveWait, rejectWait) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolveWait();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt >= timeoutMs) {
          rejectWait(new UserError(`${label} did not become reachable at ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };

    attempt();
  });
}

function prefixStream(name, stream, write) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      write(`[${name}] ${line}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer.length > 0) {
      write(`[${name}] ${buffer}\n`);
      buffer = "";
    }
  });
}

function spawnManagedChild(children, name, command, args, options) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const childInfo = { name, child };
  children.push(childInfo);

  prefixStream(name, child.stdout, (line) => process.stdout.write(line));
  prefixStream(name, child.stderr, (line) => process.stderr.write(line));

  return childInfo;
}

async function stopChildren(children) {
  const liveChildren = children.filter(({ child }) => child.exitCode === null && child.signalCode === null);
  if (liveChildren.length === 0) {
    return;
  }

  for (const { child } of liveChildren) {
    child.kill("SIGTERM");
  }

  await Promise.race([
    Promise.all(liveChildren.map(({ child }) => new Promise((resolveExit) => child.once("exit", resolveExit)))),
    sleep(SHUTDOWN_TIMEOUT_MS),
  ]);

  for (const { child } of liveChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
}

async function runHttpsProbe(rootCaPath) {
  const probeScript = `
const expected = {
  origin: ${JSON.stringify(HTTPS_ORIGIN)},
  resource: ${JSON.stringify(API_AUDIENCE)},
  issuer: ${JSON.stringify(AUTH_ISSUER)},
  jwksUrl: ${JSON.stringify(JWKS_URL)}
};

async function json(label, url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(label + " " + url + " -> HTTP " + response.status + " " + body.slice(0, 400));
  }
  return response.json();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const protectedResource = await json("protected-resource metadata", expected.origin + "/.well-known/oauth-protected-resource/api");
assert(protectedResource.resource === expected.resource, "protected-resource metadata resource mismatch: " + JSON.stringify(protectedResource.resource));
if (Array.isArray(protectedResource.authorization_servers)) {
  assert(protectedResource.authorization_servers.includes(expected.issuer), "protected-resource metadata does not include issuer authorization server");
}

const oidc = await json("openid metadata", expected.origin + "/api/auth/.well-known/openid-configuration");
assert(oidc.issuer === expected.issuer, "openid metadata issuer mismatch: " + JSON.stringify(oidc.issuer));
if (oidc.jwks_uri) {
  assert(oidc.jwks_uri === expected.jwksUrl, "openid metadata jwks_uri mismatch: " + JSON.stringify(oidc.jwks_uri));
}

const jwks = await json("JWKS", expected.jwksUrl);
assert(Array.isArray(jwks.keys) && jwks.keys.length > 0, "JWKS has no keys");

console.log(JSON.stringify({
  resource: protectedResource.resource,
  issuer: oidc.issuer,
  jwks_keys: jwks.keys.length
}));
`;

  const { stdout } = await runCapture(process.execPath, ["--input-type=module", "-e", probeScript], {
    cwd: rootDir,
    env: {
      ...process.env,
      NODE_EXTRA_CA_CERTS: rootCaPath,
    },
    timeoutMs: 20_000,
  });
  return stdout.trim();
}

async function checkRunningProfile() {
  const rootCaPath = await resolveRootCaPath();
  ensureCertFiles();
  await assertLocalHttpsDnsConfigured();

  try {
    await waitForTcp(SERVICE_HOST, SERVICE_PORT, "service", 2_000);
    await waitForTcp(WEB_HOST, WEB_PORT, "web", 2_000);
    await waitForTcp(CADDY_HOST, CADDY_PORT, "Caddy HTTPS", 2_000);
  } catch (err) {
    throw new UserError(`${err.message}\nLocal HTTPS profile is not running. Start it with: pnpm dev:https`);
  }

  const result = await runHttpsProbe(rootCaPath);
  log(`HTTPS OAuth/JWKS check passed: ${result}`);
}

async function start() {
  await commandMustExist("pnpm", ["--version"], "Install pnpm before running repo scripts.");
  await commandMustExist("caddy", ["version"], "Install it with: brew install caddy");
  const rootCaPath = await resolveRootCaPath();
  ensureCertFiles();
  await assertLocalHttpsDnsConfigured();

  const children = [];
  let stopping = false;

  const shutdown = async (code) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log("Stopping local HTTPS profile.");
    await stopChildren(children);
    process.exitCode = code;
  };

  const fatalExit = new Promise((_, rejectFatal) => {
    const onExit = (name, code, signal) => {
      if (stopping) {
        return;
      }
      rejectFatal(new UserError(`${name} exited unexpectedly with ${code ?? signal}`));
    };

    spawnManagedChild(children, "service", "pnpm", ["dev"], {
      cwd: serviceDir,
      env: buildServiceEnv(rootCaPath),
    }).child.once("exit", (code, signal) => onExit("service", code, signal));

    spawnManagedChild(children, "web", "pnpm", ["dev"], {
      cwd: webDir,
      env: buildWebEnv(rootCaPath),
    }).child.once("exit", (code, signal) => onExit("web", code, signal));

    spawnManagedChild(children, "caddy", "caddy", [
      "run",
      "--config",
      CADDYFILE,
      "--adapter",
      "caddyfile",
    ], {
      cwd: rootDir,
      env: buildCaddyEnv(),
    }).child.once("exit", (code, signal) => onExit("caddy", code, signal));
  });

  process.once("SIGINT", () => {
    void shutdown(130);
  });
  process.once("SIGTERM", () => {
    void shutdown(143);
  });

  try {
    await Promise.race([
      (async () => {
        await waitForTcp(SERVICE_HOST, SERVICE_PORT, "service");
        await waitForTcp(WEB_HOST, WEB_PORT, "web");
        await waitForTcp(CADDY_HOST, CADDY_PORT, "Caddy HTTPS");
        const result = await runHttpsProbe(rootCaPath);
        log(`HTTPS OAuth/JWKS check passed: ${result}`);
        log(`Ready: ${HTTPS_ORIGIN}`);
      })(),
      fatalExit,
    ]);

    await fatalExit;
  } catch (err) {
    if (!stopping) {
      console.error(`[dev:https] ${err.message}`);
      await shutdown(1);
    }
  }
}

async function provisionIos() {
  await commandMustExist("pnpm", ["--version"], "Install pnpm before running repo scripts.");
  const rootCaPath = await resolveRootCaPath();
  log("Running local iOS OAuth provisioning with HTTPS profile env.");
  await runInherited("pnpm", ["--dir", "service", "oauth:provision:ios-local"], {
    cwd: rootDir,
    env: buildServiceEnv(rootCaPath),
  });
}

async function main() {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "setup") {
    await setup();
    return;
  }
  if (command === "start") {
    await start();
    return;
  }
  if (command === "check") {
    await checkRunningProfile();
    return;
  }
  if (command === "provision-ios") {
    await provisionIos();
    return;
  }
  if (command === "print-env") {
    const rootCaPath = await resolveRootCaPath();
    printDerivedEnv(rootCaPath);
    return;
  }

  throw new UserError(`Unknown command: ${command}`);
}

main().catch((err) => {
  if (err instanceof UserError) {
    console.error(`[dev:https] ${err.message}`);
    process.exitCode = 1;
    return;
  }

  console.error(err);
  process.exitCode = 1;
});
