import { useEffect, useState } from 'react'
import { apiFetchJson, isApiError } from '@/lib/transport'

/**
 * MapKit JS (Phase 9), loaded from Apple's CDN only when a map is shown. Tokens come from
 * `/api/maps/token` for this page's origin; MapKit asks again through `authorizationCallback`
 * when one expires. Search results reached through it stay in the browser.
 */

const MAPKIT_SRC = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.core.js'

/** The small part of the MapKit JS API we use (no published types are installed). */
export type MapKitCoordinate = { latitude: number; longitude: number }
export type MapKitMap = {
  center: MapKitCoordinate
  setRegionAnimated(region: unknown, animate?: boolean): void
  addOverlay(overlay: unknown): void
  addAnnotation(annotation: unknown): void
  addEventListener(type: 'region-change-start' | 'region-change-end', listener: () => void): void
  destroy(): void
}
export type MapKitCircle = { coordinate: MapKitCoordinate; radius: number }
export type MapKitPlace = { name: string; formattedAddress?: string; coordinate: MapKitCoordinate }
export type MapKitSearch = {
  search(query: string, callback: (error: Error | null, data: { places?: MapKitPlace[] }) => void, options?: object): number
}
export type MapKit = {
  init(options: { authorizationCallback: (done: (token: string) => void) => void }): void
  Coordinate: new (latitude: number, longitude: number) => MapKitCoordinate
  CoordinateSpan: new (latitudeDelta: number, longitudeDelta: number) => unknown
  CoordinateRegion: new (center: MapKitCoordinate, span: unknown) => unknown
  Map: new (element: HTMLElement, options?: object) => MapKitMap
  CircleOverlay: new (coordinate: MapKitCoordinate, radius: number, options?: object) => MapKitCircle
  Style: new (options: object) => unknown
  MarkerAnnotation: new (coordinate: MapKitCoordinate, options?: object) => unknown
  Search: new (options?: object) => MapKitSearch
}

/** `ready` with MapKit, `unavailable` when the server has no Maps key (503), `error` otherwise. */
export type MapKitState = { status: 'loading' } | { status: 'ready'; mapkit: MapKit } | { status: 'unavailable' } | { status: 'error' }

const fetchToken = () =>
  apiFetchJson<{ token: string; expires_at: string }>(`/api/maps/token?${new URLSearchParams({ origin: window.location.origin })}`)

let loading: Promise<MapKit | null> | null = null

/** Loads and initialises MapKit once per page. Resolves null when maps aren't set up on this server. */
export function loadMapKit(): Promise<MapKit | null> {
  loading ??= (async () => {
    // A token first: it tells us whether maps are configured before we fetch Apple's script.
    let first: string | null
    try { first = (await fetchToken()).token }
    catch (error) { if (isApiError(error, 503)) return null; throw error }
    const mapkit = await new Promise<MapKit>((resolve, reject) => {
      const callback = '__budMapKitLoaded'
      ;(window as unknown as Record<string, unknown>)[callback] = () => resolve((window as unknown as { mapkit: MapKit }).mapkit)
      const script = document.createElement('script')
      script.src = MAPKIT_SRC
      script.crossOrigin = 'anonymous'
      script.dataset.libraries = 'map,services'
      script.dataset.callback = callback
      script.onerror = () => { script.remove(); reject(new Error('MapKit JS failed to load')) }
      document.head.append(script)
    })
    mapkit.init({
      authorizationCallback: done => {
        const token = first
        first = null
        if (token) done(token)
        else void fetchToken().then(next => done(next.token)).catch(error => console.warn('MapKit token refresh failed', error))
      },
    })
    return mapkit
  })()
  // A failed load (network, CDN) can be retried next time a map is shown; "unavailable" is kept.
  loading.catch(() => { loading = null })
  return loading
}

export function useMapKit(): MapKitState {
  const [state, setState] = useState<MapKitState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    loadMapKit().then(
      mapkit => { if (active) setState(mapkit ? { status: 'ready', mapkit } : { status: 'unavailable' }) },
      error => { console.warn('MapKit unavailable', error); if (active) setState({ status: 'error' }) },
    )
    return () => { active = false }
  }, [])
  return state
}
