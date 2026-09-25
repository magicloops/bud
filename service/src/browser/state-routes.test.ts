import test from 'node:test';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import type {SQL} from 'drizzle-orm';
import type {BrowserStateHint} from './state-events.js';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import {auth} from '../auth/auth.js';
import {db} from '../db/client.js';
import {config} from '../config.js';
import {BrowserStateEvents} from './state-events.js';
import {BrowserMobileAuth,mobileCookie} from './mobile-auth.js';
import {BrowserControl} from './control.js';
import {BrowserError} from './repository.js';
import {registerBrowserRoutes} from './routes.js';

test('state routes deny anonymous/foreign and out-of-scope mobile viewers before subscription',async t=>{
  const server=Fastify();
  t.after(async()=>{await server.close();t.mock.restoreAll();});
  t.mock.method(BrowserStateEvents.prototype,'ready',async()=>{});
  const subscribe=t.mock.method(BrowserStateEvents.prototype,'subscribe',()=>()=>{});
  let loggedIn=false;
  t.mock.method(auth.api,'getSession',async()=>loggedIn?{user:{id:'alice'},session:{id:'auth'}} as never:null);
  t.mock.method(db,'select',()=>({from:()=>({where:()=>({limit:async()=>[{id:'auth'}]})})}) as never);
  t.mock.method(db.query.threadTable,'findFirst',async()=>null);
  t.mock.method(db.query.budTable,'findFirst',async()=>null);
  const get=t.mock.fn(async()=>{throw new BrowserError('browser_not_found');});
  const control=new BrowserControl({get} as never);
  await server.register(websocket);
  await registerBrowserRoutes(server,control,{} as never);
  const thread='00000000-0000-4000-8000-000000000001';
  const paths=[`/api/threads/${thread}/browser-state`,'/api/browser/sessions/foreign/state','/api/buds/foreign/browser/state'];
  const headers={origin:config.betterAuthTrustedOrigins[0],upgrade:'websocket',connection:'upgrade'};
  for(const url of paths)assert.equal((await server.inject({url,headers})).statusCode,401);
  loggedIn=true;
  assert.equal((await server.inject({url:paths[0],headers:{upgrade:'websocket',connection:'upgrade'}})).statusCode,403);
  for(const url of paths)assert.equal((await server.inject({url,headers})).statusCode,404);
  assert.equal(subscribe.mock.callCount(),0);
  t.mock.method(BrowserMobileAuth.prototype,'resolve',async()=>({created_by_user_id:'alice',session_id:'allowed',viewer_id:'viewer',id:'visit'}) as never);
  const before=get.mock.callCount();
  for(const url of paths) assert.equal((await server.inject({url,headers:{...headers,cookie:`${mobileCookie}=token`,authorization:"Bearer extra"}})).statusCode,404);
  assert.equal(get.mock.callCount(),before,'mobile scope rejects before reading a different workspace');
  assert.equal(subscribe.mock.callCount(),0);
});

test('native thread feed verifies bearer scope, expiry and live ownership without widening other routes', {timeout:15000}, async t => {
  const {generateKeyPairSync, sign} = await import('node:crypto');
  const {AUTH_ISSUER} = await import('../auth/auth.js');
  const {publicKey, privateKey} = generateKeyPairSync('rsa', {modulusLength:2048});
  const jwk = {...publicKey.export({format:'jwk'}), kid:'mobile-m1', alg:'RS256', use:'sig'};
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({keys:[jwk]}), {status:200, headers:{'content-type':'application/json'}}));
  const token = (sub='alice', exp=Math.floor(Date.now()/1000)+60) => {
    const encoded = [Buffer.from(JSON.stringify({alg:'RS256',kid:'mobile-m1'})).toString('base64url'),
      Buffer.from(JSON.stringify({sub,exp,iss:AUTH_ISSUER,aud:config.apiAudience,scope:'api'})).toString('base64url')].join('.');
    return `${encoded}.${sign('RSA-SHA256',Buffer.from(encoded),privateKey).toString('base64url')}`;
  };
  const thread='00000000-0000-4000-8000-000000000001';
  const server=Fastify();
  t.after(async()=>{await server.close();t.mock.restoreAll();});
  t.mock.method(BrowserStateEvents.prototype,'ready',async()=>{});
  let publish: (()=>void) | undefined;
  let subscriptions=0;
  t.mock.method(BrowserStateEvents.prototype,'subscribe',(callback: (hint: BrowserStateHint)=>void)=>{
    subscriptions++; publish=()=>callback({bud_id:'bud',thread_id:thread});
    let subscribed=true;
    return ()=>{if(subscribed) subscriptions--; subscribed=false;};
  });
  t.mock.method(auth.api,'getSession',async()=>null);
  let userExists=true, threadExists=true, budExists=true;
  t.mock.method(db.query.authUserTable,'findFirst',async()=>userExists?{id:'alice'} as never:undefined);
  // Inspect bound owner values to ensure the real helpers pass the bearer principal.
  const {PgDialect}=await import('drizzle-orm/pg-core');
  const dialect=new PgDialect();
  t.mock.method(db.query.threadTable,'findFirst',async (options: {where: SQL})=>{
    const params=dialect.sqlToQuery(options.where as never).params;
    return threadExists && params.includes('alice') ? {threadId:thread,budId:'bud'} as never:undefined;
  });
  t.mock.method(db.query.budTable,'findFirst',async (options: {where: SQL})=>{
    const params=dialect.sqlToQuery(options.where as never).params;
    return budExists && params.includes('alice') ? {budId:'bud'} as never:undefined;
  });
  await server.register(websocket);
  await registerBrowserRoutes(server,new BrowserControl({} as never),{} as never);
  await server.ready();
  const url=`/api/threads/${thread}/browser-state`;
  const headers=(access=token(),origin?:string)=>({authorization:`Bearer ${access}`,upgrade:'websocket',connection:'upgrade',...(origin?{origin}:{})});
  for(const access of ['invalid',token('alice',1)]) {
    assert.equal((await server.inject({url,headers:headers(access)})).statusCode,401);
  }
  assert.equal((await server.inject({url,headers:headers(token('bob'))})).statusCode,404);
  assert.equal((await server.inject({url,headers:headers(token(),'https://evil.test')})).statusCode,403);
  for(const path of ['/api/browser/sessions/session/state','/api/buds/bud/browser/state','/api/browser/sessions/session/media','/api/browser/sessions/session']) {
    assert.equal((await server.inject({url:path,headers:headers()})).statusCode,401);
  }
  assert.equal(subscriptions,0);
  const address=await server.listen({port:0,host:'127.0.0.1'});
  t.mock.timers.enable({apis:['Date']});
  for(const revoke of [()=>{threadExists=false;},()=>{budExists=false;},()=>{userExists=false;},()=>{t.mock.timers.tick(120_000); }]) {
    userExists=threadExists=budExists=true;
    const socket=new WebSocket(address.replace('http:','ws:')+url,{headers:{authorization:`Bearer ${token()}`}});
    const ready=once(socket,'message');
    t.after(()=>socket.terminate());
    const [raw]=await ready;
    assert.equal(JSON.parse(String(raw)).type,'ready');
    assert.equal(subscriptions,1);
    const closed=once(socket,'close');
    revoke(); publish!();
    const [code]=await closed;
    assert.equal(code,4404); assert.equal(subscriptions,0);
  }
});
