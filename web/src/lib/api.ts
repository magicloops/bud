export {
  normalizeAppRedirectPath,
  getCurrentAppPath,
  getLoginRedirectValue,
  buildLoginUrl,
  isAuthRedirectPending,
  redirectToLogin,
} from '@/lib/auth-redirect'
export {
  ApiError,
  apiFetch,
  apiFetchJson,
  buildApiUrl,
  buildAbsoluteApiUrl,
  createAuthEventSource,
  isApiError,
} from '@/lib/transport'
export { fetchCurrentUser, updateCurrentUserProfile } from '@/lib/auth-api'
export { decodeTerminalData } from '@/lib/terminal-data'
export { generateMessageClientId } from '@/lib/messages'
export type {
  ApiAgentState,
  ApiBud,
  ApiCurrentUser,
  ApiDeviceAuthApproval,
  ApiDeviceAuthFlow,
  ApiMessage,
  ApiMessagePage,
  ApiThread,
  ApiUpdateProfileInput,
} from '@/lib/api-types'
export { normalizeCapabilities } from '@/lib/api-types'
