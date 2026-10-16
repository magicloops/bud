import { useEffect, useMemo, useState } from 'react'
import type { ApiPlace } from '@/lib/api-types'
import { apiFetchJson } from '@/lib/transport'

/** The owner's saved places, reloaded when `refresh` changes. Null while loading or after an error. */
export function usePlaces(enabled = true, refresh = 0) {
  const [places, setPlaces] = useState<ApiPlace[] | null>(null)
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    apiFetchJson<{ items: ApiPlace[] }>('/api/data/places', { signal: controller.signal })
      .then(page => { if (!controller.signal.aborted) setPlaces(page.items) })
      .catch(() => { if (!controller.signal.aborted) setPlaces(null) })
    return () => controller.abort()
  }, [enabled, refresh])
  const names = useMemo(() => new Map((places ?? []).map(place => [place.id, place.name])), [places])
  return { places, names }
}
