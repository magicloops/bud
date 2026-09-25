import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import {auth} from "../auth/auth.js";
import {config} from "../config.js";
import {BrowserControl} from "./control.js";
import {BrowserMobileAuth, mobileCookie} from "./mobile-auth.js";
import {BrowserStateEvents} from "./state-events.js";
import {registerBrowserRoutes} from "./routes.js";

test("bootstrap rejects foreign Origin before consuming grants; stale scoped cookie never falls back", async t => {
  const server = Fastify();
  t.after(async () => { await server.close(); t.mock.restoreAll(); });
  t.mock.method(BrowserStateEvents.prototype, "ready", async () => {});
  const fullAuth = t.mock.method(auth.api, "getSession", async () => { throw Error("must not use full auth"); });
  const redeem = t.mock.method(BrowserMobileAuth.prototype, "redeem", async () => ({
    visit: {id:"visit",session_id:"session",viewer_id:"viewer",created_by_user_id:"alice"},token:"cookie",
  }));
  const resolve = t.mock.method(BrowserMobileAuth.prototype, "resolve", async () => null);
  const reads: string[][] = [];
  const control = new BrowserControl({get: async (...args: string[]) => { reads.push(args); return {}; }} as never);
  await server.register(websocket);
  await registerBrowserRoutes(server, control, {} as never);
  const request = {method:"POST" as const,url:"/api/browser/viewer-bootstrap",payload:{grant:"a".repeat(43)}};
  for (const origin of ["https://evil.test", "null", ""]) {
    assert.equal((await server.inject({...request, headers:{origin}})).statusCode,403);
  }
  assert.equal(redeem.mock.callCount(),0);
  for (const headers of [{}, {origin:config.betterAuthTrustedOrigins[0]}]) {
    const result = await server.inject({...request, headers});
    assert.equal(result.statusCode,303);
    assert.equal(result.headers.location,"/browser-mobile/session?viewer_id=viewer&visit_id=visit");
    assert.match(String(result.headers["set-cookie"]), /Secure; HttpOnly; SameSite=Strict/);
    assert.equal(result.headers["cache-control"],"no-store");
  }
  assert.deepEqual(reads,[["alice","session"],["alice","session"]]);
  for (const value of ["", "stale"]) {
    const result = await server.inject({url:"/api/browser/sessions/session",headers:{cookie:`${mobileCookie}=${value}; other=full-login`}});
    assert.equal(result.statusCode,401);
  }
  assert.equal(resolve.mock.callCount(),2);
  assert.equal(fullAuth.mock.callCount(),0);
});
