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
});
