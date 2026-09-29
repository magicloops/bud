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
  for (const headers of [{}, {cookie:`${mobileCookie}=stale`}]) {
    const result = await server.inject({method:"POST",url:"/api/browser/sessions/session/return-from-chat",
      headers,payload:{handoff_id:"h",revision:1}});
    assert.equal(result.statusCode, headers.cookie ? 403 : 401);
  }
  assert.equal(resolve.mock.callCount(),2);
  assert.equal(fullAuth.mock.callCount(),0);
});

test('saved-frame read respects scoped visits, live auth and owner lookup', async t => {
  const {BrowserMedia} = await import('./media.js');
  const {BrowserError} = await import('./repository.js');
  const {browserImages} = await import('./image-artifacts.js');
  const server=Fastify();
  t.mock.method(BrowserStateEvents.prototype,'ready',async()=>{});
  let authorized=true, owner='alice';
  t.mock.method(BrowserMobileAuth.prototype,'resolve',async()=>authorized ? {
    id:'visit',session_id:'session',viewer_id:'viewer',created_by_user_id:'alice',
  } : null);
  const lookup=t.mock.method(browserImages,'latest',async()=>({image:'public',mime_type:'image/png',captured_at:1}));
  const control=new BrowserControl({get:async(user:string,id:string)=>{
    if(user!==owner || id!=='session')throw new BrowserError('browser_not_found');
    return {id,thread_id:'thread',generation:'gen',desired_state:'open'};
  }} as never);
  const media=new BrowserMedia(control,'ws://unused');
  t.after(async()=>{media.stop();await server.close();t.mock.restoreAll()});
  await server.register(websocket);
  await registerBrowserRoutes(server,control,media);
  const headers={cookie:`${mobileCookie}=visit`};
  const get=(id='session')=>server.inject({url:`/api/browser/sessions/${id}/shared-frame`,headers});
  const ok=await get();
  assert.equal(ok.statusCode,200);
  assert.equal(ok.headers['cache-control'],'no-store');
  assert.deepEqual(ok.json(),{snapshot:{image:'public',mime_type:'image/png',captured_at:1}});
  assert.equal((await get('other')).statusCode,404);
  owner='bob';
  assert.equal((await get()).statusCode,404);
  authorized=false;
  assert.equal((await get()).statusCode,401);
  assert.equal(lookup.mock.callCount(),1,'deny before any artifact read');
});
