import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Cdp } from './cdp.mjs';

class Socket extends EventEmitter {
  bufferedAmount = 0;
  sent = [];
  terminated = false;
  send(value, callback) { this.sent.push(JSON.parse(value)); callback(); }
  terminate() { this.terminated = true; }
  receive(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

test('interleaves target events with out-of-order command replies', async () => {
  const socket = new Socket(), cdp = new Cdp(socket), events = [];
  cdp.on('event', event => events.push(event));
  const first = cdp.call('Page.startScreencast', {}, 'target-session');
  socket.receive({ method: 'Page.screencastFrame', sessionId: 'target-session', params: { sessionId: 17 } });
  const ack = cdp.call('Page.screencastFrameAck', { sessionId: 17 }, 'target-session');
  socket.receive({ id: 2, result: { ack: true } });
  socket.receive({ id: 1, result: { started: true } });
  assert.deepEqual(await first, { started: true });
  assert.deepEqual(await ack, { ack: true });
  assert.equal(events.length, 1);
  assert.equal(socket.sent[1].sessionId, 'target-session');
  assert.equal(socket.sent[1].params.sessionId, 17);
  cdp.close();
});

test('timeout closes every pending call and does not replay uncertain input', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const input = assert.rejects(cdp.call('Input.dispatchMouseEvent', {}, 's', 10), /cdp_timeout:Input.dispatchMouseEvent/);
  const other = assert.rejects(cdp.call('Page.enable'), /cdp_timeout:Input.dispatchMouseEvent/);
  await Promise.all([input, other]);
  socket.receive({ id: 1, result: {} });
  await assert.rejects(cdp.call('Page.enable'), /cdp_closed/);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.terminated, true);
});

test('capacity bounds close pending commands', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const pending = Array.from({ length: 32 }, () => assert.rejects(cdp.call('Page.enable'), /cdp_capacity/));
  await assert.rejects(cdp.call('Page.enable'), /cdp_capacity/);
  await Promise.all(pending);
  assert.equal(socket.sent.length, 32);
});

test('malformed JSON and excessive buffered writes close the channel', async () => {
  for (const failure of ['malformed', 'buffered']) {
    const socket = new Socket(), cdp = new Cdp(socket);
    if (failure === 'malformed') {
      const pending = assert.rejects(cdp.call('Page.enable'), /cdp_invalid_message/);
      socket.emit('message', Buffer.from('{'));
      await pending;
    } else {
      socket.bufferedAmount = 65537;
      await assert.rejects(cdp.call('Page.enable'), /cdp_capacity/);
      assert.equal(socket.sent.length, 0);
    }
    assert.equal(socket.terminated, true);
  }
});

test('CDP rejection is definitive and leaves the connection usable', async () => {
  const socket = new Socket(), cdp = new Cdp(socket);
  const rejected = assert.rejects(cdp.call('Page.startScreencast'), /cdp_rejected:Page.startScreencast:-32602/);
  socket.receive({ id: 1, error: { code: -32602, message: 'private details omitted' } });
  await rejected;
  const next = cdp.call('Page.enable');
  socket.receive({ id: 2, result: {} });
  await next;
  assert.equal(socket.terminated, false);
  cdp.close();
});

test('rejects non-loopback endpoints before connecting', async () => {
  await assert.rejects(Cdp.connect('ws://example.com/devtools/browser/id'), /non_owned_endpoint/);
});
