import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { config } from "../config.js";
import {
  AUTH_ISSUER,
  buildProtectedResourceMetadataOverrides,
  registerAuthRoutes,
} from "./auth.js";

test("protected resource metadata advertises the mounted OAuth issuer", () => {
  const metadata = buildProtectedResourceMetadataOverrides();

  assert.equal(metadata.resource, config.apiAudience);
  assert.equal(
    AUTH_ISSUER,
    new URL(config.betterAuthBasePath, `${config.betterAuthUrl}/`).toString(),
  );
  assert.deepEqual(metadata.authorization_servers, [AUTH_ISSUER]);
});

test("protected resource metadata route advertises the mounted OAuth issuer", async (t) => {
  const server = Fastify({ logger: false });
  t.after(async () => {
    await server.close();
  });

  await registerAuthRoutes(server);

  const { pathname } = new URL(config.apiAudience);
  const normalizedPath = pathname !== "/" && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  const response = await server.inject({
    method: "GET",
    url: `/.well-known/oauth-protected-resource${normalizedPath === "/" ? "" : normalizedPath}`,
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "public, max-age=3600, stale-while-revalidate=15, stale-if-error=86400");
  const metadata = response.json() as {
    resource: string;
    authorization_servers?: string[];
  };
  assert.equal(metadata.resource, config.apiAudience);
  assert.deepEqual(metadata.authorization_servers, [AUTH_ISSUER]);
});

test("issuer discovery overrides provider freshness at the HTTP boundary", async t => {
  const server = Fastify({ logger: false });
  t.after(() => server.close());
  await registerAuthRoutes(server);
  for (const url of [`/.well-known/oauth-authorization-server${config.betterAuthBasePath}`,
    `${config.betterAuthBasePath}/.well-known/openid-configuration`]) {
    const response = await server.inject(url);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "public, max-age=3600, stale-while-revalidate=15, stale-if-error=86400");
    const metadata = response.json();
    assert.equal(metadata.issuer, AUTH_ISSUER);
    assert.equal(metadata.token_endpoint, `${AUTH_ISSUER}/oauth2/token`);
    assert.equal(metadata.jwks_uri, `${AUTH_ISSUER}/jwks`);
  }
});
