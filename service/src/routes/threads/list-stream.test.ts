import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { registerThreadListStream } from './list-stream.js';
import type { FastifyInstance } from 'fastify';

test('thread-list stream authorizes before LISTEN, filters scopes, and closes on revocation', async () => {
  const connection = Object.assign(new EventEmitter(), {
    query: async () => ({rows:[{name:'public',count:2}]}), release: () => {},
  });
  let connects=0, allowed=true, signedIn=true;
  let handler: (request: unknown, reply: unknown) => Promise<unknown> = async () => {};
  let shutdown = async () => {};
  const server = { addHook: (_: string, fn: typeof shutdown) => { shutdown=fn; },
    get: (_: string, fn: typeof handler) => { handler=fn; } };
  await registerThreadListStream(server as unknown as FastifyInstance, {
    database: { connect: async () => { connects++; return connection; } } as never,
    resolveViewer: async () => signedIn ? {userId:'alice',sessionId:'session',email:null,authType:'cookie'} : null,
    authorizeBud: async (_viewer, id) => allowed && id==='mine' ? {} as never : null,
  });
  const reply = () => {
    const events: string[] = [];
    const raw = Object.assign(new EventEmitter(), {destroyed:false,writableLength:0,end:()=>{raw.destroyed=true; raw.emit('close');}});
    return {events,raw,status:200,code(n:number){this.status=n;return this;},send(){},sse(e:{event:string}){events.push(e.event);}};
  };
  const foreign=reply(); await handler({params:{budId:'foreign'}},foreign);
  assert.equal(foreign.status,404); assert.equal(connects,0);
  signedIn=false;
  const anonymous=reply(); await handler({params:{budId:'mine'}},anonymous);
  assert.equal(anonymous.status,401); assert.equal(connects,0);
  signedIn=true;
  const owner=reply(); await handler({params:{budId:'mine'}},owner);
  assert.deepEqual(owner.events,['ready']);
  connection.emit('notification',{channel:'bud_thread_list',payload:JSON.stringify({schema:'public',bud_id:'foreign'})});
  await settle(); assert.deepEqual(owner.events,['ready']);
  const notify=()=>connection.emit('notification',{channel:'bud_thread_list',payload:JSON.stringify({schema:'public',bud_id:'mine'})});
  notify(); await settle(); assert.deepEqual(owner.events,['ready','changed']);
  allowed=false; notify(); await settle();
  assert.equal(owner.raw.destroyed,true); assert.deepEqual(owner.events,['ready','changed']);
  await shutdown();
});
