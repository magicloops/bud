import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { PlacePinEditor } = await import('./place-pin-editor')

const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON())
// The token request resolves over several microtasks; let it land inside act.
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

test('without a Maps key the editor says so and still saves the starting pin with a new name, address and radius', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  const urls: string[] = []
  globalThis.fetch = async url => { urls.push(String(url)); return Response.json({ error: 'maps_unavailable' }, { status: 503 }) }
  Object.assign(globalThis, { window: { location: { origin: 'http://localhost:5173' } } })
  const saved: unknown[] = []
  let view!: ReactTestRenderer
  try {
    await act(async () => {
      view = create(createElement(PlacePinEditor, {
        title: 'Home', existing: true, start: { name: 'Home', center: { lat: 37.749003, lon: -122.416487 }, radius: 50 },
        onSave: pin => { saved.push(pin) }, onCancel: () => {},
      }))
    })
    await settle()
    assert.deepEqual(urls, ['/api/maps/token?origin=http%3A%2F%2Flocalhost%3A5173'])
    assert.match(text(view), /Maps aren't set up on this server/)
    assert.doesNotMatch(text(view), /Search for a place/)
    assert.match(text(view), /restarts its arrivals and departures/)
    await act(async () => {
      view.root.findByProps({ type: 'range' }).props.onChange({ target: { value: '75' } })
      view.root.findByProps({ required: true }).props.onChange({ target: { value: 'House' } })
      view.root.findByProps({ placeholder: 'Optional' }).props.onChange({ target: { value: ' 3327 26th St ' } })
    })
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {}, stopPropagation() {} }))
    assert.deepEqual(saved, [{ name: 'House', center: { lat: 37.749003, lon: -122.416487 }, radius: 75, address: '3327 26th St' }])
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})

test('without a map a search-only start has no pin to save', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window
  globalThis.fetch = async () => Response.json({ error: 'maps_unavailable' }, { status: 503 })
  Object.assign(globalThis, { window: { location: { origin: 'http://localhost:5173' } } })
  let view!: ReactTestRenderer
  try {
    await act(async () => {
      view = create(createElement(PlacePinEditor, {
        title: 'Home', start: { name: 'Home', center: null, radius: 100, query: '3327 26th St' },
        onSave: () => { throw new Error('unexpected save') }, onCancel: () => {},
      }))
    })
    await settle()
    assert.match(text(view), /no pin to save yet/)
    const save = view.root.findAll(node => node.type === 'button' && node.props.type !== 'button')[0]
    assert.equal(save.props.disabled, true)
  } finally {
    await act(async () => view?.unmount())
    globalThis.fetch = originalFetch
    Object.assign(globalThis, { window: originalWindow })
  }
})
