import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { registerAccessLog } from "../access-log.js";
import { config } from "../config.js";
import {
  AUTH_ISSUER,
  buildProtectedResourceMetadataOverrides,
  registerAuthRoutes,
  auth,
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

test("auth responses complete once with access logging and delayed send hooks", async t => {
  const records: Record<string, unknown>[] = [];
  const server = Fastify({disableRequestLogging: true, logger: {level: "debug",
    stream: new Writable({write(chunk, _encoding, done) { records.push(JSON.parse(String(chunk))); done(); }})}});
  t.after(() => server.close());
  registerAccessLog(server);
  const sends = new Map<string, number>();
  server.addHook("onSend", async (request, _reply, payload) => {
    sends.set(request.url, (sends.get(request.url) ?? 0) + 1);
    await new Promise(resolve => setImmediate(resolve));
    return payload;
  });
  await registerAuthRoutes(server);
  t.mock.method(auth, "handler", async (request: Request) => {
    if (request.url.endsWith("/failure")) throw new Error("fixture auth failure");
    return new Response(JSON.stringify({ok: true}), {
      headers: {"content-type": "application/json"},
    });
  });
  const path = new URL(config.apiAudience).pathname.replace(/\/$/, "");
  const urls = [
    `/.well-known/oauth-protected-resource${path}`,
    `/.well-known/oauth-authorization-server${config.betterAuthBasePath}`,
    `${config.betterAuthBasePath}/.well-known/openid-configuration`,
    `${config.betterAuthBasePath}/fixture`,
    `${config.betterAuthBasePath}/failure`,
  ];
  for (const url of urls) {
    const response = await server.inject(url);
    assert.equal(response.statusCode, url.endsWith("/failure") ? 500 : 200);
    assert.ok(response.json());
    assert.match(String(response.headers["server-timing"]), /^total;dur=\d+\.\d+$/);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...sends.values()], urls.map(() => 1));
  assert.equal(records.filter(record => record.msg === "Request completed").length, urls.length);
  assert.deepEqual(records.filter(record => Number(record.level) >= 40).map(record => record.msg),
    ["Failed to handle Better Auth request", "Request completed"]);
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
