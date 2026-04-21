import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/react'
import { buildAbsoluteApiUrl } from './transport'

export const authClient = createAuthClient({
  baseURL: buildAbsoluteApiUrl('/api/auth'),
  plugins: [oauthProviderClient()],
})
