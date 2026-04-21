const toSameOriginPath = (value: string) => {
  try {
    const parsed = new URL(value)
    if (typeof window !== 'undefined' && parsed.origin !== window.location.origin) {
      return null
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/'
  } catch {
    return null
  }
}

const normalizeInternalRedirectPath = (value: string | null | undefined) => {
  if (!value) {
    return '/'
  }

  if (value.startsWith('/') && !value.startsWith('//')) {
    return value
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    return toSameOriginPath(value) ?? '/'
  }

  return '/'
}

let authRedirectPending = false

export const normalizeAppRedirectPath = normalizeInternalRedirectPath

export const getCurrentAppPath = () => {
  if (typeof window === 'undefined') {
    return '/'
  }

  return `${window.location.pathname}${window.location.search}${window.location.hash}`
}

export const getLoginRedirectValue = (pathname: string, search = '', hash = '') =>
  normalizeInternalRedirectPath(`${pathname}${search}${hash}`)

export const buildLoginUrl = (returnTo = getCurrentAppPath()) => {
  const loginUrl = new URL('/login', window.location.origin)
  loginUrl.searchParams.set('redirect', normalizeInternalRedirectPath(returnTo))
  return loginUrl.toString()
}

export const isAuthRedirectPending = () => authRedirectPending

export const redirectToLogin = (returnTo = getCurrentAppPath()) => {
  if (typeof window === 'undefined') {
    return
  }

  const loginUrl = buildLoginUrl(returnTo)
  if (authRedirectPending && window.location.href === loginUrl) {
    return
  }

  authRedirectPending = true
  window.location.assign(loginUrl)
}
