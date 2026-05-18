import assert from "node:assert/strict";
import test from "node:test";
import {
  CreateProxiedSiteBodySchema,
  buildViewerCookie,
  endpointHostForSlug,
  isProxyGatewayRequest,
  normalizeProxiedSitePath,
  normalizeProxiedSiteTargetHost,
  readCookie,
  resolveProxyGatewayHost,
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

test("proxy gateway host resolution preserves direct hosts and requires edge trust for forwarded hosts", (t) => {
  const originalBaseDomain = config.proxyBaseDomain;
  const originalEdgeSecret = config.proxyEdgeSecret;
  t.after(() => {
    config.proxyBaseDomain = originalBaseDomain;
    config.proxyEdgeSecret = originalEdgeSecret;
  });

  config.proxyBaseDomain = "bud.show";
  config.proxyEdgeSecret = "edge-secret";

  assert.equal(
    resolveProxyGatewayHost({ host: "vite-dev-a8f2.bud.show" }),
    "vite-dev-a8f2.bud.show",
  );
  assert.equal(
    resolveProxyGatewayHost({
      host: "bud-service.onrender.com",
      "x-forwarded-host": "VITE-DEV-A8F2.BUD.SHOW",
      "x-bud-edge-secret": "edge-secret",
    }),
    "vite-dev-a8f2.bud.show",
  );
  assert.equal(
    resolveProxyGatewayHost({
      host: "bud-service.onrender.com",
      "x-forwarded-host": "vite-dev-a8f2.bud.show",
    }),
    null,
  );
  assert.equal(
    resolveProxyGatewayHost({
      host: "bud-service.onrender.com",
      "x-forwarded-host": "vite-dev-a8f2.example.com",
      "x-bud-edge-secret": "edge-secret",
    }),
    null,
  );
});

test("proxy gateway request detection respects the gateway enable switch", (t) => {
  const originalBaseDomain = config.proxyBaseDomain;
  const originalEdgeSecret = config.proxyEdgeSecret;
  const originalGatewayEnabled = config.proxyGatewayEnabled;
  t.after(() => {
    config.proxyBaseDomain = originalBaseDomain;
    config.proxyEdgeSecret = originalEdgeSecret;
    config.proxyGatewayEnabled = originalGatewayEnabled;
  });

  config.proxyBaseDomain = "bud.show";
  config.proxyEdgeSecret = "edge-secret";
  config.proxyGatewayEnabled = true;

  assert.equal(isProxyGatewayRequest({ host: "vite-dev-a8f2.bud.show" }), true);

  config.proxyGatewayEnabled = false;
  assert.equal(isProxyGatewayRequest({ host: "vite-dev-a8f2.bud.show" }), false);
});

test("proxied site viewer cookies are parseable by reserved name", () => {
  const cookie = buildViewerCookie("token-value");
  assert.equal(readCookie(cookie, config.proxyViewerCookieName), "token-value");
  assert.equal(readCookie(`${cookie}; other=value`, "other"), "value");
});

test("proxied site viewer cookies use local HTTP and hosted HTTPS browser attributes", (t) => {
  const originalScheme = config.proxyPublicScheme;
  const originalCookieName = config.proxyViewerCookieName;
  t.after(() => {
    config.proxyPublicScheme = originalScheme;
    config.proxyViewerCookieName = originalCookieName;
  });

  config.proxyPublicScheme = "http";
  config.proxyViewerCookieName = "bud_proxy_viewer";
  const localCookie = buildViewerCookie("local-token");
  assert.match(localCookie, /^bud_proxy_viewer=local-token/);
  assert.match(localCookie, /HttpOnly/);
  assert.match(localCookie, /SameSite=Lax/);
  assert.doesNotMatch(localCookie, /Secure/);

  config.proxyPublicScheme = "https";
  config.proxyViewerCookieName = "__Host-bud_proxy_viewer";
  const hostedCookie = buildViewerCookie("hosted-token");
  assert.match(hostedCookie, /^__Host-bud_proxy_viewer=hosted-token/);
  assert.match(hostedCookie, /HttpOnly/);
  assert.match(hostedCookie, /SameSite=None/);
  assert.match(hostedCookie, /Secure/);
  assert.doesNotMatch(hostedCookie, /Domain=/i);
});
