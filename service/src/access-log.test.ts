import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Writable} from 'node:stream';
import {accessLogLevel, registerAccessLog} from './access-log.js';

test('access logs retain failures and slow finite requests without long-stream warnings', () => {
  const route='/api/browser/sessions/:session_id';
  assert.equal(accessLogLevel('GET',route,200,20,false),'debug');
  assert.equal(accessLogLevel('GET',route,502,20,false),'error');
  assert.equal(accessLogLevel('GET',route,503,20,false),'error');
  assert.equal(accessLogLevel('GET',route,200,1200,false),'warn');
  assert.equal(accessLogLevel('GET',route,200,90000,true),'debug');
  assert.equal(accessLogLevel('POST',route,200,20,false),'info');
});
test('one completion contains template/correlation and no query, body or raw IDs', async () => {
  const records:Record<string,unknown>[]=[];
  const server=Fastify({disableRequestLogging:true,logger:{level:'debug',stream:new Writable({write(chunk,_encoding,done){records.push(JSON.parse(String(chunk)));done()}})}});
  registerAccessLog(server);
  server.get('/api/browser/sessions/:session_id',async()=>({ok:true}));
  await server.inject('/api/browser/sessions/secret-id?viewer_id=secret-viewer');
  await server.close();
  assert.equal(records.length,1);
  assert.equal(records[0].route,'/api/browser/sessions/:session_id');
  assert.equal(records[0].level,20); assert.ok(records[0].reqId);
  assert.equal(JSON.stringify(records).includes('secret'),false);
  assert.equal(records[0].response_bytes, Buffer.byteLength(JSON.stringify({ok:true})));
  assert.ok(Number(records[0].handler_ms) >= 0);
});

test('server timing covers successful and failed finite responses', async () => {
  const server = Fastify();
  registerAccessLog(server);
  server.get('/rows', async () => ({messages: [{message_id: 'one'}]}));
  server.get('/failure', async () => { throw new Error('fixture'); });
  for (const path of ['/rows', '/failure']) {
    const response = await server.inject(path);
    assert.match(String(response.headers['server-timing']), /^total;dur=\d+\.\d+$/);
  }
  await server.close();
});

test('SSE timing records one complete frame across split CRLF without contents', async () => {
  const records: Record<string, unknown>[] = [];
  const server = Fastify({disableRequestLogging: true, logger: {level: 'debug',
    stream: new Writable({write(chunk, _encoding, done) { records.push(JSON.parse(String(chunk))); done(); }})}});
  registerAccessLog(server);
  server.get('/events', async (_request, reply) => {
    reply.hijack();
    reply.raw.setHeader('content-type', 'text/event-stream');
    reply.raw.writeHead(200);
    reply.raw.write('data: secret-content\r\n\r');
    reply.raw.write('\n');
    reply.raw.write('data: another-secret\n\n');
    reply.raw.end();
  });
  await server.inject('/events');
  await server.close();
  const frames = records.filter(record => record.msg === 'SSE first frame');
  assert.equal(frames.length, 1);
  assert.ok(Number(frames[0].headers_ms) >= 0);
  assert.ok(Number(frames[0].first_event_ms) >= Number(frames[0].headers_ms));
  assert.equal(JSON.stringify(records).includes('secret'), false);
});
