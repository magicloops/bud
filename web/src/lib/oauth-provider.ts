import { buildAbsoluteApiUrl } from './transport'

const OAUTH_EXPIRATION_PARAM = 'exp'
const OAUTH_SIGNATURE_PARAM = 'sig'

const splitSpaceDelimited = (value: string | null) =>
  (value ?? '')
    .split(/\s+/)
    .map((entry) => entry.trim())
    .filter(Boolean)

const toSearchString = (value: string) => (value.startsWith('?') ? value.slice(1) : value)

const removePromptValue = (prompt: string | null, value: string) => {
  const nextPrompt = splitSpaceDelimited(prompt).filter((entry) => entry !== value).join(' ')
  return nextPrompt || null
}

export type OAuthRequestDetails = {
  signedQuery: string | null
  clientId: string | null
  redirectUri: string | null
  scopes: string[]
  prompt: string | null
  authorizeResumeUrl: string | null
}

export const getSignedOAuthQuery = (search: string) => {
  const query = toSearchString(search)
  if (!query) {
    return null
  }

  const params = new URLSearchParams(query)
  return params.has(OAUTH_SIGNATURE_PARAM) ? query : null
}

export const hasOAuthPrompt = (prompt: string | null, value: string) =>
  splitSpaceDelimited(prompt).includes(value)

export const formatOAuthScopeLabel = (scope: string) => {
  switch (scope) {
    case 'api':
      return 'Bud API'
    case 'email':
      return 'Email'
    case 'offline_access':
      return 'Offline access'
    case 'openid':
      return 'OpenID identity'
    case 'profile':
      return 'Profile'
    default:
      return scope.replace(/_/g, ' ')
  }
}

export const getOAuthRequestDetails = (search: string): OAuthRequestDetails => {
  const signedQuery = getSignedOAuthQuery(search)
  if (!signedQuery) {
    return {
      signedQuery: null,
      clientId: null,
      redirectUri: null,
      scopes: [],
      prompt: null,
      authorizeResumeUrl: null,
    }
  }

  const authorizationQuery = new URLSearchParams(signedQuery)
  authorizationQuery.delete(OAUTH_EXPIRATION_PARAM)
  authorizationQuery.delete(OAUTH_SIGNATURE_PARAM)

  const resumeQuery = new URLSearchParams(authorizationQuery)
  const nextPrompt = removePromptValue(authorizationQuery.get('prompt'), 'login')
  if (nextPrompt) {
    resumeQuery.set('prompt', nextPrompt)
  } else {
    resumeQuery.delete('prompt')
  }

  const resumePath = `/api/auth/oauth2/authorize?${resumeQuery.toString()}`

  return {
    signedQuery,
    clientId: authorizationQuery.get('client_id'),
    redirectUri: authorizationQuery.get('redirect_uri'),
    scopes: splitSpaceDelimited(authorizationQuery.get('scope')),
    prompt: authorizationQuery.get('prompt'),
    authorizeResumeUrl: buildAbsoluteApiUrl(resumePath),
  }
}
