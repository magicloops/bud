import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createContactApp } from './server.mjs';

test('example serves bounded query routes and fixed assets without exposing backend state', async t => {
  const calls = [];
  let deny = false;
  const server = createContactApp({ keyId: 'public-key-id', appData: { query: async (...args) => {
    calls.push(args);
    if (deny) throw Object.assign(new Error('private diagnostic must not escape'), { code: 'app_data_permission_denied' });
    return { data: { items: [{ id: 'contact', fields: { given_name: '<script>untrusted</script>' } }], next_cursor: null } };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /My contact history/);
  const query = await fetch(`${origin}/api/contacts?search=Ada`);
  assert.equal(query.status, 200);
  assert.deepEqual(calls, [['public-key-id', 'contacts', { search: 'Ada', limit: 20 }]]);
  for (const path of ['/server.mjs', '/../app-key-backend.mjs', '/api/location', '/api/contacts?owner=other']) {
    const response = await fetch(origin + path);
    assert.ok([400, 404].includes(response.status));
  }
  assert.equal(calls.length, 1);
  assert.equal((await fetch(origin + '/api/contacts', { method: 'POST' })).status, 405);
  deny = true;
  const denied = await fetch(origin + '/api/contacts');
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: 'permission_denied' });
  const script = await (await fetch(origin + '/app.js')).text();
  assert.doesNotMatch(script, /innerHTML|Authorization|Bearer|private_key|credential/);
});
