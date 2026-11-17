import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import Fastify from "fastify";
import { validateGoogleRedirectUri } from "./config.js";
import type { GoogleConnections } from "./connections.js";
import { registerGoogleRoutes } from "./routes.js";

test("Google connection construction does not prevent startup with an unusable callback", () => {
  for (const values of [
    { APP_BASE_URL: "http://192.168.1.8:5173", GOOGLE_REDIRECT_URI: "", NODE_ENV: "development" },
    { APP_BASE_URL: "http://bud.internal:3000", GOOGLE_REDIRECT_URI: "", NODE_ENV: "production" },
    { APP_BASE_URL: "https://bud.example", GOOGLE_REDIRECT_URI: "http://[invalid", NODE_ENV: "development" },
  ]) {
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { googleConnections } from "./src/google/connections.ts";
      import { googleConfigured } from "./src/google/config.ts";
      assert.equal(googleConfigured(), false);
      await assert.rejects(googleConnections.begin("fixture-owner", "fixture-session"), /google_invalid_redirect_uri/);
    `], { env: { ...process.env, ...values, DOTENV_CONFIG_PATH: "/nonexistent/bud-google-config-test.env",
      GOOGLE_CLIENT_ID: "fixture-client", GOOGLE_CLIENT_SECRET: "fixture-secret", GOOGLE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") },
    timeout: 20_000, stdio: "pipe" });
  }
});

test("Google callback validation still rejects unsafe destinations", () => {
  const config = { clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: "https://bud.example/api/google/callback" };
  assert.doesNotThrow(() => validateGoogleRedirectUri(config));
  for (const redirectUri of ["http://192.168.1.8/callback", "https://user:secret@bud.example/callback",
    "https://bud.example/callback?return=elsewhere", "https://bud.example/callback#fragment", "file:///callback"]) {
    assert.throws(() => validateGoogleRedirectUri({ ...config, redirectUri }), /google_invalid_redirect_uri/);
  }
  if (process.env.NODE_ENV !== "production") {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      assert.doesNotThrow(() => validateGoogleRedirectUri({ ...config, redirectUri: `http://${host}:5173/api/google/callback` }));
    }
  }
});

test("invalid Google callback configuration keeps inventory usable and rejects callbacks safely", async () => {
  for (const redirectUri of ["http://[invalid", "file:///callback", "http://192.168.1.8:5173/callback"]) {
    const app = Fastify();
    try {
      await registerGoogleRoutes(app, {
        config: { clientId: "fixture", clientSecret: "fixture", redirectUri },
        async list(owner: string) { assert.equal(owner, "alice"); return []; },
        async finish() { assert.fail("Invalid callback must not exchange credentials"); },
      } as unknown as GoogleConnections, async () => ({ userId: "alice", sessionId: "session", email: null, authType: "cookie" }), () => false);
      const inventory = await app.inject({ method: "GET", url: "/api/google/connection" });
      assert.equal(inventory.statusCode, 200);
      assert.deepEqual(inventory.json(), { configured: false, connections: [] });
      const callback = await app.inject({ method: "GET", url: "/api/google/callback?state=fixture&code=fixture" });
      assert.equal(callback.statusCode, 409);
      assert.deepEqual(callback.json(), { error: "google_invalid_redirect_uri" });
      assert.equal(callback.headers.location, undefined);
    } finally { await app.close(); }
  }
});
