import type { ApiCurrentUser, ApiUpdateProfileInput } from '@/lib/api-types'
import { ApiError, apiFetch, apiFetchJson } from '@/lib/transport'

export const fetchCurrentUser = async () => {
  const response = await apiFetch('/api/me', { redirectOnUnauthorized: false })
  if (response.status === 401) {
    return null
  }

  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new ApiError(`HTTP ${response.status}`, response.status, body)
  }

  return (await response.json()) as ApiCurrentUser
}

export const updateCurrentUserProfile = async (input: ApiUpdateProfileInput) =>
  apiFetchJson<ApiCurrentUser>('/api/me/profile', {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  })
