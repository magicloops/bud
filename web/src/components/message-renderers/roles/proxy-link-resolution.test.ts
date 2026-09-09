import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveProxyLink, type JsonRequest } from './proxy-link-resolution.ts'

test('old-host deep link resolves independently and preserves encoded path, query and fragment', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const api = (async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    return calls.length === 1 ? { proxied_site_id: 'old-site' } : { bootstrap_url: 'https://old.bud.show/__bud/bootstrap?grant=one' }
  }) as JsonRequest
  assert.equal(await resolveProxyLink('https://old.bud.show/people/a%20b?x=%2F#bio', api), 'https://old.bud.show/__bud/bootstrap?grant=one')
  assert.equal(calls[0].path, '/api/proxied-sites/resolve?endpoint_host=old.bud.show')
  assert.equal(calls[1].path, '/api/proxied-sites/old-site/viewer-grants')
  assert.deepEqual(JSON.parse(calls[1].init!.body as string), { path: '/people/a%20b?x=%2F#bio' })
})

test('unknown/non-owner host stays external; authorization and transport errors do not silently fall back', async () => {
  for (const status of [404, 401, 500]) {
    const api = (async () => { throw Object.assign(new Error('failed'), { status }) }) as JsonRequest
    if (status === 404) assert.equal(await resolveProxyLink('https://example.com/a', api), 'https://example.com/a')
    else await assert.rejects(resolveProxyLink('https://example.com/a', api))
  }
})

test('disabled/expired grant failure never opens a raw proxy URL', async () => {
  let calls = 0
  const api = (async () => {
    if (++calls === 1) return { proxied_site_id: 'old-site' }
    throw Object.assign(new Error('expired'), { status: 410 })
  }) as JsonRequest
  await assert.rejects(resolveProxyLink('https://old.bud.show/a', api), /expired/)
})
