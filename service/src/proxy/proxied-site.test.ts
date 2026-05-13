import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateProxiedSiteBodySchema,
  buildViewerCookie,
  endpointHostForSlug,
  normalizeProxiedSitePath,
  normalizeProxiedSiteTargetHost,
  readCookie,
} from "./proxied-site.js";
import { config } from "../config.js";

test("proxied site target validation permits only loopback host names", () => {
  assert.equal(normalizeProxiedSiteTargetHost("127.0.0.1"), "127.0.0.1");
  assert.equal(normalizeProxiedSiteTargetHost("::1"), "::1");
  assert.equal(normalizeProxiedSiteTargetHost("LOCALHOST"), "localhost");
  assert.throws(
    () => normalizeProxiedSiteTargetHost("10.0.0.1"),
    /Only localhost loopback proxy targets are allowed/,
  );
});

test("proxied site creation defaults to localhost", () => {
  assert.equal(
    CreateProxiedSiteBodySchema.parse({ target_port: 5173 }).target_host,
    "localhost",
  );
});

test("proxied site path validation requires absolute paths", () => {
  assert.equal(normalizeProxiedSitePath(undefined), "/");
  assert.equal(normalizeProxiedSitePath("/src/main.tsx?x=1"), "/src/main.tsx?x=1");
  assert.throws(() => normalizeProxiedSitePath("relative"), /Proxy path must start with \//);
});

test("proxied site endpoint hosts use configured proxy base domain", () => {
  assert.equal(endpointHostForSlug("vite-dev-a8f2"), `vite-dev-a8f2.${config.proxyBaseDomain}`);
});

test("proxied site viewer cookies are parseable by reserved name", () => {
  const cookie = buildViewerCookie("token-value");
  assert.equal(readCookie(cookie, config.proxyViewerCookieName), "token-value");
  assert.equal(readCookie(`${cookie}; other=value`, "other"), "value");
});
