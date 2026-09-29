import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrivateCapture } from './private-capture.mjs';

class Source extends EventEmitter {
  calls = [];
  closed = false;
  async attach(target) { this.target = target; return 'session'; }
  async call(method, params) {
    this.calls.push([method, params]);
    if (this.closed) throw new Error('closed');
  }
  close() { this.closed = true; this.emit('ended'); }
  frame(sessionId = 'session') {
    this.emit('event', { sessionId, method: 'Page.screencastFrame', params: { sessionId: 1, data: 'fixture' } });
  }
}

test('only admitted target frames pass; retirement fences late frames immediately', async () => {
  const source = new Source();
  let admitted = true, frames = 0;
  const capture = new PrivateCapture(source, 'owned', () => admitted, () => frames++);
  await capture.start();
  source.frame('foreign');
  source.frame();
  assert.equal(frames, 1);
  admitted = false;
  source.frame();
  const stopped = capture.stop();
  assert.equal(stopped, capture.stop());
  source.frame();
  await stopped;
  assert.equal(frames, 1);
  assert.equal(source.closed, true);
  assert.deepEqual(source.calls.filter(([m]) => m === 'Emulation.setFocusEmulationEnabled').map(([, p]) => p.enabled), [true, false]);
});

test('loss of admission without frames still retires focus', async () => {
  const source = new Source();
  let admitted = true;
  const capture = new PrivateCapture(source, 'owned', () => admitted, () => assert.fail());
  await capture.start();
  admitted = false;
  for (let i = 0; !source.closed && i < 20; i++) await sleep(10);
  assert.equal(source.closed, true);
  assert.equal(capture.reason, 'admission_lost');
});

test('revocation during attach cannot enable focus or start capture', async () => {
  const source = new Source();
  let finish;
  source.attach = () => new Promise(resolve => { finish = resolve; });
  const capture = new PrivateCapture(source, 'owned', () => true, () => assert.fail());
  const starting = capture.start();
  const rejected = assert.rejects(starting, /not_admitted/);
  const stopped = capture.stop('return');
  finish('session');
  await rejected;
  await stopped;
  assert.equal(source.calls.some(([m, p]) => m === 'Page.startScreencast' || p.enabled === true), false);
});

test('source failure fences delivery and reports unconfirmed cleanup', async () => {
  const source = new Source();
  const capture = new PrivateCapture(source, 'owned', () => true, () => assert.fail());
  await capture.start();
  source.close();
  await capture.stop();
  assert.equal(capture.reason, 'source_lost');
  assert.equal(capture.failure, 'cleanup_unconfirmed');
});

test('revocation drains pending enable then disables without starting a stream', async () => {
  const source = new Source();
  let finish;
  const call = source.call.bind(source);
  source.call = async (method, params) => {
    await call(method, params);
    if (method === 'Emulation.setFocusEmulationEnabled' && params.enabled) {
      await new Promise(resolve => { finish = resolve; });
    }
  };
  const capture = new PrivateCapture(source, 'owned', () => true, () => assert.fail());
  const starting = capture.start();
  const rejected = assert.rejects(starting, /not_admitted/);
  while (!finish) await sleep(1);
  const stopped = capture.stop('lease_expired');
  finish();
  await rejected;
  await stopped;
  assert.equal(source.calls.some(([m]) => m === 'Page.startScreencast'), false);
  assert.deepEqual(source.calls.filter(([m]) => m === 'Emulation.setFocusEmulationEnabled').map(([, p]) => p.enabled), [true, false]);
});
