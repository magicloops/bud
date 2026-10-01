import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as settle } from 'node:timers/promises';
import { registerThreadListStream } from './list-stream.js';
import { ThreadListFeed } from './list-feed.js';
import type { FastifyInstance } from 'fastify';

test('owner list stream authorizes before LISTEN and closes on continuity loss or revocation', async () => {
  let connects = 0, signedIn = false;
  let handler: (request: unknown, reply: unknown) => Promise<unknown> = async () => {};
  const feed = new ThreadListFeed();
  const server = { get: (_: string, fn: typeof handler) => { handler = fn; } };
  await registerThreadListStream(server as unknown as FastifyInstance,
    { ready: async () => { connects++; } } as never, feed,
    async () => signedIn ? { userId: 'alice', sessionId: 'session', email: null, authType: 'cookie' } : null);
  const reply = () => {
    const events: string[] = [];
    const raw = Object.assign(new EventEmitter(), { destroyed: false, writableLength: 0,
      end: () => { raw.destroyed = true; raw.emit('close'); } });
    return { events, raw, status: 200, code(n: number) { this.status = n; return this; }, send() {},
      sse(e: { event: string }) { events.push(e.event); } };
  };
  const anonymous = reply(); await handler({}, anonymous);
  assert.equal(anonymous.status, 401); assert.equal(connects, 0);
  signedIn = true;
  const owner = reply(); await handler({}, owner);
  assert.deepEqual(owner.events, ['ready']);
  feed.reset('other'); await settle(); assert.deepEqual(owner.events, ['ready']);
  feed.reset('alice'); await settle();
  assert.deepEqual(owner.events, ['ready', 'resync_required']);
  assert.equal(owner.raw.destroyed, true);
  const revoked = reply(); await handler({}, revoked);
  signedIn = false; feed.reset('alice'); await settle();
  assert.equal(revoked.raw.destroyed, true);
  assert.deepEqual(revoked.events, ['ready']);
});
