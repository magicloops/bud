import assert from "node:assert/strict";
import test from "node:test";
import { config } from "./config.js";
import { buildServer } from "./server.js";

test("trusted-origin preflight advertises the full browser API method set", async (t) => {
  const server = await buildServer();
  t.after(async () => {
    await server.close();
  });

  const origin = config.betterAuthTrustedOrigins[0];
  assert.ok(origin, "expected at least one trusted origin");

  const response = await server.inject({
    method: "OPTIONS",
    url: "/api/threads/ff8fcd38-a0b8-47b1-851a-921d9ed2892c",
    headers: {
      origin,
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "authorization, content-type",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], origin);
  assert.equal(
    response.headers["access-control-allow-methods"],
    "GET,HEAD,POST,PATCH,DELETE,OPTIONS",
  );
});
