import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../db/client.js";
import {
  CreateProxiedSiteBodySchema,
  createOrReuseProxiedSite,
  resolveAuthorizedProxiedSiteHost,
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


test("viewer paths preserve deep links and reject origin-changing redirects", () => {
  assert.equal(normalizeProxiedSitePath("/people/a%20b?x=%2F#bio"), "/people/a%20b?x=%2F#bio");
  for (const path of ["//evil.test", "/\\evil.test", "/\nevil.test", "/\tevil.test"]) {
    assert.throws(() => normalizeProxiedSitePath(path));
  }
});


test("reuse matches owner/Bud/origin rather than path and only renews the oldest alias", async (t) => {
  t.after(() => mock.restoreAll());
  const dialect = new PgDialect();
  let predicate = "";
  let ordering = "";
  const existing = { proxiedSiteId: "old-root", defaultPath: "/", endpointHost: "old.bud.show" };
  mock.method(db, "select", () => ({ from: () => ({ where: (where: never) => {
    const query = dialect.sqlToQuery(where);
    predicate = query.sql;
    assert.deepEqual(query.params, ["bud-1", "owner", "127.0.0.1", 5176, "private_owner", true]);
    return { orderBy: (...order: never[]) => {
      ordering = order.map(value => dialect.sqlToQuery(value).sql).join(",");
      return { limit: async () => [existing] };
    } };
  } }) }) as never);
  mock.method(db, "update", () => ({ set: (values: object) => {
    assert.deepEqual(Object.keys(values).sort(), ["expiresAt", "lastRenewedAt", "updatedAt"]);
    return { where: () => ({ returning: async () => [existing] }) };
  } }) as never);
  const result = await createOrReuseProxiedSite({
    viewer: { userId: "owner", sessionId: null, email: null, authType: "cookie" },
    budId: "bud-1", body: CreateProxiedSiteBodySchema.parse({ target_host: "127.0.0.1", target_port: 5176, path: "/people/dennis/index.html" }),
  });
  assert.equal(result.site.endpointHost, "old.bud.show");
  assert.equal(result.site.defaultPath, "/");
  assert.equal(result.reused, true);
  assert.doesNotMatch(predicate, /default_path/);
  assert.match(ordering, /created_at.*asc/);
});

test("hostname resolution scopes the SQL query to the acting owner", async (t) => {
  t.after(() => mock.restoreAll());
  const dialect = new PgDialect();
  mock.method(db, "select", () => ({ from: () => ({ where: (where: never) => {
    const query = dialect.sqlToQuery(where);
    assert.match(query.sql, /endpoint_host/);
    assert.match(query.sql, /created_by_user_id/);
    assert.deepEqual(query.params, ["old.bud.show", "owner"]);
    return { limit: async () => [] };
  } }) }) as never);
  assert.equal(await resolveAuthorizedProxiedSiteHost(
    { userId: "owner", sessionId: null, email: null, authType: "cookie" }, "OLD.BUD.SHOW",
  ), null);
});
