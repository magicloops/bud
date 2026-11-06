import test from 'node:test'
import assert from 'node:assert/strict'
import { act, createElement } from 'react'
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { register } from 'node:module'

register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
  const result = await next(url, context);
  if (result.format === 'module' && result.source) return { ...result, source: String(result.source).replaceAll('import.meta.env', '({})') };
  return result;
}`)}`, import.meta.url)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { PlacePinEditor } = await import('./place-pin-editor')

/** Just enough of MapKit JS to draw nothing: setting a region recentres and ends the "pan". */
class FakeMap {
  center = { latitude: 0, longitude: 0 }
  listeners: Record<string, Array<() => void>> = {}
  constructor(_element: unknown, options: { region?: { center: FakeMap['center'] } }) { if (options.region) this.center = options.region.center }
  setRegionAnimated(region: { center: FakeMap['center'] }) { this.center = region.center; this.listeners['region-change-end']?.forEach(listener => listener()) }
  addEventListener(type: string, listener: () => void) { (this.listeners[type] ??= []).push(listener) }
  addOverlay() {}
  addAnnotation() {}
  destroy() {}
}
const mapkit = {
  init() {},
  Coordinate: class { constructor(public latitude: number, public longitude: number) {} },
  CoordinateSpan: class {},
  CoordinateRegion: class { constructor(public center: unknown) {} },
  Map: FakeMap,
  CircleOverlay: class { constructor(public coordinate: unknown, public radius: number) {} },
  Style: class {},
  MarkerAnnotation: class {},
}
const window = { location: { origin: 'http://localhost:5173' }, mapkit } as Record<string, unknown>
Object.assign(globalThis, {
  window,
  // MapKit's script "loads" as soon as it's appended.
  document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append: () => queueMicrotask(() => (window.__budMapKitLoaded as () => void)()) } },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
})

const searches: string[] = []
let replies: Response[] = []
globalThis.fetch = async url => {
  if (String(url).startsWith('/api/maps/token')) return Response.json({ token: 'token', expires_at: '2026-11-05T12:00:00Z' })
  searches.push(String(url))
  return replies.shift()!
}
const ATTRIBUTION = 'Powered by Geoapify · © OpenStreetMap contributors'
const RESULTS = [
  { name: null, address: '3327 26th St, San Francisco, CA 94110', coordinate: { lat: 37.749, lon: -122.4165 }, category: null },
  { name: 'Café', address: '500 Valencia St, San Francisco', coordinate: { lat: 37.76, lon: -122.42 }, category: 'catering.cafe' },
]

const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const textOf = (node: ReactTestInstance | string): string => typeof node === 'string' ? node : node.children.map(textOf).join('')
const button = (view: ReactTestRenderer, text: string) => view.root.findAll(node => node.type === 'button' && textOf(node).includes(text))[0]
const addressField = (view: ReactTestRenderer) => view.root.findByProps({ placeholder: 'Optional' })

test('search goes through the service: the seed search anchors the query, a pick fills the address, failures explain themselves', async () => {
  const saved: unknown[] = []
  let view!: ReactTestRenderer
  replies = [Response.json({ results: RESULTS, attribution: ATTRIBUTION })]
  await act(async () => {
    view = create(createElement(PlacePinEditor, {
      title: 'Where is Home?', start: { name: 'Home', center: null, radius: 100, query: '3327 26th St', address: '3327 26th St' },
      onSave: pin => { saved.push(pin) }, onCancel: () => {},
    }), { createNodeMock: () => ({}) })
  })
  await settle(); await settle()
  try {
    // The question's query, with no map centre yet; the first result centres the map and keeps the query as the address.
    assert.deepEqual(searches, ['/api/places/search?q=3327+26th+St'])
    assert.equal(addressField(view).props.value, '3327 26th St')
    assert.match(textOf(view.root), /Pin at 37\.749000, -122\.416500/)
    assert.ok(view.root.findByProps({ href: 'https://www.geoapify.com/' }))
    assert.ok(view.root.findByProps({ href: 'https://www.openstreetmap.org/copyright' }))

    await act(async () => button(view, 'Café').props.onClick())
    assert.equal(addressField(view).props.value, '500 Valencia St, San Francisco')
    await act(async () => view.root.findByType('form').props.onSubmit({ preventDefault() {}, stopPropagation() {} }))
    assert.deepEqual(saved, [{ name: 'Home', center: { lat: 37.76, lon: -122.42 }, radius: 100, address: '500 Valencia St, San Francisco' }])

    // A search of your own is biased to the map centre.
    replies = [Response.json({ error: 'place_search_rate_limited' }, { status: 429 })]
    await act(async () => view.root.findByProps({ type: 'search' }).props.onChange({ target: { value: 'coffee' } }))
    await act(async () => button(view, 'Search').props.onClick())
    await settle()
    assert.equal(searches[1], '/api/places/search?q=coffee&near=37.76%2C-122.42')
    assert.match(textOf(view.root), /Too many searches just now/)

    replies = [Response.json({ error: 'place_lookup_unavailable' }, { status: 503 })]
    await act(async () => button(view, 'Search').props.onClick())
    await settle()
    assert.match(textOf(view.root), /Search isn't set up on this server/)
    // The pin and address are untouched by a failed search.
    assert.equal(addressField(view).props.value, '500 Valencia St, San Francisco')
  } finally {
    await act(async () => view.unmount())
  }
})
