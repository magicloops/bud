import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { buildRelay } from './relay.mjs';

const require = createRequire(new URL('../../service/package.json', import.meta.url));
const { WebSocket } = require('ws');
const origin = 'http://localhost:3444';
const authorize = async (request, reply, thread) => {
  if (!request.headers['x-test-user']) { reply.code(401).send({ error: 'unauthorized' }); return null; }
  if (request.headers['x-test-user'] !== 'owner' || thread !== 'owned-thread') {
    reply.code(404).send({ error: 'not_found' }); return null;
  }
  return 'owner';
};
const headers = { origin, 'x-test-user': 'owner' };
const basePath = '/api/browser-spike/threads/owned-thread';

test('ownership, origin and single-use host ticket checks precede connections', async t => {
  const app = await buildRelay({ origin, authorize });
  t.after(() => app.close());
  assert.equal((await app.inject({ method: 'POST', url: basePath, headers: { origin } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: basePath, headers: { ...headers, 'x-test-user': 'other' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: basePath, headers: { ...headers, origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: basePath, headers })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: basePath, headers })).statusCode, 409);
  assert.equal((await app.inject({ method: 'GET', url: `${basePath}/view`, headers: { ...headers, 'x-test-user': 'other' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `${basePath}/agent`, headers, payload: { epoch: 1, command: { action: 'observe', target: 'x', viewer: 'forged' } } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'DELETE', url: basePath, headers })).statusCode, 200);
});

test('real Chromium across separate outbound control/media sockets and viewer', { skip: !process.env.BUD_BROWSER_EXECUTABLE, timeout: 30000 }, async t => {
  const app = await buildRelay({ origin, authorize });
  t.after(() => app.close());
  app.get('/fixture', async (_, reply) => reply.type('text/html').send('<!doctype html><title>Relay fixture</title><label>Name<input aria-label="Name"></label><button onclick="document.title=\'Clicked\'">Submit</button>'));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const tickets = (await app.inject({ method: 'POST', url: basePath, headers })).json();
  const host = spawn(fileURLToPath(new URL('./target/debug/bud-browser-spike', import.meta.url)), [], {
    env: { ...process.env, BUD_BROWSER_SPIKE_RELAY: address.replace('http:', 'ws:'), BUD_BROWSER_SPIKE_HOST_TICKET: tickets.host_ticket, BUD_BROWSER_SPIKE_MEDIA_TICKET: tickets.media_ticket },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Do not print raw host errors or tickets; test failures identify the boundary.
  let exited = false;
  host.on('exit', () => { exited = true; });
  t.after(async () => { if (!exited) { host.kill('SIGINT'); await once(host, 'exit'); } });
  const agent = command => app.inject({ method: 'POST', url: `${basePath}/agent`, headers, payload: command });
  let targets;
  for (let i = 0; i < 100; i++) {
    assert.equal(exited, false, 'browser host exited before ready');
    const response = await agent({ epoch: 1, command: { action: 'targets' } });
    if (response.statusCode === 200) { targets = response.json().result; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(targets?.length, 'outbound host did not become ready');
  const target = targets[0].target_id;
  assert.equal((await agent({ epoch: 1, command: { action: 'navigate', target, url: `${address}/fixture` } })).statusCode, 200);
  const replay = new WebSocket(`${address.replace('http:', 'ws:')}/ws/browser-spike/host`, { headers: { authorization: `Bearer ${tickets.host_ticket}` } });
  replay.on('error', () => {});
  const [, rejected] = await once(replay, 'unexpected-response');
  assert.equal(rejected.statusCode, 401); replay.terminate();

  const viewer = new WebSocket(`${address.replace('http:', 'ws:')}${basePath}/viewer`, { headers });
  t.after(() => viewer.terminate());
  const ready = once(viewer, 'message');
  await once(viewer, 'open');
  const [initial] = await ready;
  assert.equal(JSON.parse(initial).epoch, 1);
  const rpc = async (epoch, command) => {
    const response = once(viewer, 'message');
    viewer.send(JSON.stringify({ epoch, command }));
    const [bytes, binary] = await response;
    return binary ? bytes : JSON.parse(bytes);
  };
  const takeover = await rpc(1, { action: 'takeover' });
  assert.equal(takeover.epoch, 2);
  assert.equal((await agent({ epoch: 2, command: { action: 'observe', target } })).json().error, 'browser_command_rejected');
  const snapshot = await rpc(2, { action: 'observe', target });
  assert.ok(snapshot.result.elements.some(element => element.name === 'Name'));
  const image = await rpc(2, { action: 'capture', target });
  assert.ok(Buffer.isBuffer(image));
  assert.equal(image[0], 0xff); assert.equal(image[1], 0xd8);
  const captures = [];
  let captureBytes = 0;
  for (let index = 0; index < 20; index++) {
    const start = performance.now();
    const bytes = await rpc(2, { action: 'capture', target });
    captures.push(performance.now() - start);
    captureBytes += bytes.length;
  }
  captures.sort((a, b) => a - b);
  console.log(`fixture_capture_samples=20 p50_ms=${captures[9].toFixed(1)} p95_ms=${captures[18].toFixed(1)} mean_bytes=${Math.round(captureBytes / 20)}`);
  const returned = await rpc(2, { action: 'return', target });
  assert.equal(returned.epoch, 3);
  assert.ok(returned.result.elements.length);
  assert.equal((await rpc(2, { action: 'insert_text', text: 'stale' })).error, 'browser_command_rejected');
  assert.ok((await agent({ epoch: 3, command: { action: 'observe', target } })).json().result.elements.length);
});
