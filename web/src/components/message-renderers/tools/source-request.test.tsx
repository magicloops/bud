import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { act, create } from 'react-test-renderer'
import { register } from 'node:module'
// The closed row links to the Data page; a plain anchor stands in for the router's Link.
const link = 'data:text/javascript,' + encodeURIComponent(
  "export const Link = ({ to, children }) => globalThis.React.createElement('a', { href: to }, children)")
Object.assign(globalThis, { React })
register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format !== 'module' || !result.source) return result;
  let source = String(result.source).replaceAll('import.meta.env', '({})');
  for (const quote of ['"', "'"]) source = source.replaceAll(quote + '@tanstack/react-router' + quote, ${JSON.stringify(JSON.stringify(link))});
  return { ...result, source };
}`)}`, import.meta.url)
const { SourceRequestContent } = await import('./source-request')
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test('a request closed elsewhere loses its actions and is read again', async () => {
  const id = 'dsr_01M2KFXEFBTPXR71B57JFBW9Z1'
  const request = { request_id: id, source: 'health', purpose: 'check your sleep', level: null, status: 'pending' }
  const source = { id: 'health', label: 'Health', enabled: false, agent: { allowed: false }, installations: [] }
  let reads = 0
  let status = 'pending'
  const original = globalThis.fetch
  globalThis.fetch = (async () => { reads++; return Response.json({ request: { ...request, status }, source }) }) as typeof fetch
  try {
    let tree!: ReturnType<typeof create>
    await act(async () => { tree = create(<SourceRequestContent payload={{ pending: true, request }} />) })
    assert.ok(tree.root.findAllByType('button').some(button => button.children.join('') === 'Turn on Health'))
    assert.equal(reads, 1)
    // The stored answer is slower than the conversation: the card closes on the payload alone.
    await act(async () => { tree.update(<SourceRequestContent payload={{ pending: false, request_id: id, source: 'health', outcome: 'superseded' }} />) })
    assert.equal(tree.root.findAllByType('button').length, 0)
    assert.match(JSON.stringify(tree.toJSON()), /Health request closed/)
    assert.equal(reads, 2)
    status = 'superseded'
    await act(async () => { tree.unmount() })
  } finally { globalThis.fetch = original }
})
