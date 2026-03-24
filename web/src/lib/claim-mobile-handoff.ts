const callbackPrefixesRaw = import.meta.env.VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES as
  | string
  | undefined

const DEFAULT_ALLOWED_CALLBACK_PREFIXES = ['chat.bud.app://claim/']

export type ClaimMobileHandoff = {
  source: string | null
  isMobileSource: boolean
  isActive: boolean
  successCallbackUrl: string | null
  errorCallbackUrl: string | null
  allowedCallbackPrefixes: string[]
}

type ClaimSuccessCallbackPayload = {
  flowId: string
  budId: string
}

type ClaimErrorCallbackPayload = {
  flowId: string
  error: string
  errorDescription?: string | null
}

function parseAbsoluteUrl(value: string | null | undefined) {
  if (!value) {
    return null
  }

  try {
    return new URL(value)
  } catch {
    return null
  }
}

function normalizeAllowedCallbackPrefixes() {
  const configuredPrefixes = (callbackPrefixesRaw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)

  const sourcePrefixes =
    configuredPrefixes.length > 0 ? configuredPrefixes : DEFAULT_ALLOWED_CALLBACK_PREFIXES

  const normalized = sourcePrefixes
    .map((entry) => parseAbsoluteUrl(entry)?.toString() ?? null)
    .filter((entry): entry is string => entry !== null)

  return normalized
}

function validateCallbackUrl(
  value: string | null | undefined,
  allowedCallbackPrefixes: readonly string[],
) {
  const candidate = parseAbsoluteUrl(value)
  if (!candidate) {
    return null
  }

  const href = candidate.toString()
  return allowedCallbackPrefixes.some((prefix) => href.startsWith(prefix)) ? href : null
}

export function parseClaimMobileHandoff(search: string): ClaimMobileHandoff {
  const params = new URLSearchParams(search)
  const source = params.get('source')
  const allowedCallbackPrefixes = normalizeAllowedCallbackPrefixes()
  const successCallbackUrl = validateCallbackUrl(
    params.get('mobile_callback_url'),
    allowedCallbackPrefixes,
  )
  const errorCallbackUrl = validateCallbackUrl(
    params.get('mobile_error_callback_url'),
    allowedCallbackPrefixes,
  )
  const isMobileSource = source === 'ios'

  return {
    source,
    isMobileSource,
    isActive: isMobileSource && successCallbackUrl !== null,
    successCallbackUrl,
    errorCallbackUrl,
    allowedCallbackPrefixes,
  }
}

export function buildClaimSuccessCallbackUrl(
  baseUrl: string,
  payload: ClaimSuccessCallbackPayload,
) {
  const callbackUrl = new URL(baseUrl)
  callbackUrl.searchParams.set('flow_id', payload.flowId)
  callbackUrl.searchParams.set('bud_id', payload.budId)
  return callbackUrl.toString()
}

export function buildClaimErrorCallbackUrl(
  baseUrl: string,
  payload: ClaimErrorCallbackPayload,
) {
  const callbackUrl = new URL(baseUrl)
  callbackUrl.searchParams.set('flow_id', payload.flowId)
  callbackUrl.searchParams.set('error', payload.error)

  if (payload.errorDescription && payload.errorDescription.trim().length > 0) {
    callbackUrl.searchParams.set('error_description', payload.errorDescription)
  } else {
    callbackUrl.searchParams.delete('error_description')
  }

  return callbackUrl.toString()
}
