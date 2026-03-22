# lib

Utility functions and shared helpers.

## Purpose

Provides common utilities for API communication, browser auth, theming, and class name management.

## Files

### `api.ts`

API utilities and type definitions.

**URL Building**:
```typescript
export const buildApiUrl = (path: string) => {
  if (apiBaseUrl) return new URL(path, apiBaseUrl).toString()
  return path
}

export const buildAbsoluteApiUrl = (path: string) => {
  if (apiBaseUrl) return new URL(path, apiBaseUrl).toString()
  return new URL(path, window.location.origin).toString()
}

export const apiFetch = (path: string, init?: ApiRequestInit) =>
  fetch(buildApiUrl(path), {
    ...init,
    credentials: init?.credentials ?? 'include',
  })
```

**Auth-Aware Transport**:
- `apiFetch()` always includes credentials
- runtime `401` responses redirect the browser back to `/login`
- login redirects are deduplicated in-module so long-lived reconnect loops can detect an in-flight auth redirect
- `fetchCurrentUser()` normalizes `/api/me`
- `updateCurrentUserProfile()` writes Bud-owned profile updates back to `/api/me/profile`
- `createAuthEventSource()` centralizes credentialed SSE setup plus auth-expiry checks
- `buildAbsoluteApiUrl()` exists specifically for clients like Better Auth that require a fully-qualified base URL even in same-origin/proxy dev mode

Uses `VITE_API_BASE_URL` env var if set.

**Auth Utilities**:
- `normalizeAppRedirectPath()` - sanitizes internal return targets
- `buildLoginUrl()` / `redirectToLogin()` - browser login redirects
- `ApiError` / `isApiError()` - typed error handling for loaders/runtime calls

**Terminal Data Decoding**:
```typescript
export const decodeTerminalData = (data: string) => {
  // Decode base64 → binary → UTF-8 text
}
```

**API Types**:

| Type | Description |
|------|-------------|
| `ApiBud` | Bud response (id, name, status, capabilities) |
| `ApiThread` | Thread response (id, title, session info) |
| `ApiMessage` | Message response (id, role, content) |
| `ApiCurrentUser` | Authenticated user/session/profile payload from `/api/me` |
| `ApiUpdateProfileInput` | Username update payload for `/api/me/profile` |

**Capability Normalization**:
```typescript
export function normalizeCapabilities(caps: unknown): {
  sessions: boolean
  sessions_backends: string[]
  tmux_version?: string
  terminal: boolean
  terminal_backends: string[]
} | null
```

Safely extracts capability fields from API response.

### `auth-client.ts`

Better Auth React client configuration.

**Responsibilities**:
- Creates the Better Auth client for the web app
- Points auth actions at an absolute `/api/auth` URL
- In proxy-mode local dev, derives that absolute URL from `window.location.origin`
- In cross-origin mode, uses `VITE_API_BASE_URL`
- Installs the OAuth Provider client plugin so hosted auth pages automatically include Better Auth's signed `oauth_query` when starting social sign-in or consent/continue requests
- Powers OAuth entrypoints for `/login` and `/auth/mobile`

### `oauth-provider.ts`

Hosted OAuth Provider helpers for app-served mobile auth pages.

**Responsibilities**:
- Detect Better Auth signed OAuth queries from `window.location.search`
- Parse mobile-OAuth request details such as `client_id`, `redirect_uri`, requested scopes, and `prompt`
- Build a safe authorize-resume URL that drops the consumed `login` prompt before sending an already-authenticated browser back to `/api/auth/oauth2/authorize`
- Format first-party scope labels for the hosted login and consent UIs

**Exports**:
- `getSignedOAuthQuery(search)` - returns the raw Better Auth signed query string when present
- `getOAuthRequestDetails(search)` - normalized request details for hosted mobile login/consent pages
- `hasOAuthPrompt(prompt, value)` - prompt inspection helper
- `formatOAuthScopeLabel(scope)` - user-facing scope label helper

### `theme-colors.ts`

Color manipulation for bud-specific theming.

**OKLCH Parsing**:
```typescript
function parseOklch(color: string): { l, c, h } | null
```

Parses `oklch(0.70 0.25 330)` format.

**Color Utilities**:

| Function | Purpose |
|----------|---------|
| `getMutedColor(color, factor)` | Reduce chroma (saturation) |
| `resolveCssVar(variable)` | Resolve CSS variable to computed value |
| `deriveBudPalette(color)` | Generate vibrant/muted/soft variants |

**Default Avatar Colors**:
```typescript
export const DEFAULT_AVATAR_COLORS = [
  'oklch(0.70 0.25 330)',  // Pink
  'oklch(0.65 0.24 50)',   // Orange
  'oklch(0.68 0.22 190)',  // Cyan
  'oklch(0.72 0.23 280)',  // Purple
  'oklch(0.66 0.21 140)'   // Green
]
```

**Palette Generation**:
```typescript
deriveBudPalette(color) → {
  vibrant: color,           // Full saturation
  muted: getMutedColor(color, 0.6),   // 60% chroma
  soft: getMutedColor(color, 0.35)    // 35% chroma
}
```

### `utils.ts`

General utilities.

**Class Name Utility**:
```typescript
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

Combines:
- `clsx` - Conditional class names
- `twMerge` - Deduplicates Tailwind classes

**Usage**:
```typescript
cn('text-red-500', isActive && 'font-bold', className)
// Properly merges Tailwind utilities
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `better-auth/react` | Better Auth browser client |
| `@better-auth/oauth-provider/client` | Signed OAuth Provider query propagation for hosted auth pages |
| `clsx` | Conditional class names |
| `tailwind-merge` | Tailwind class deduplication |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | Optional API server URL for cross-origin |
| `VITE_API_PROXY_TARGET` | Vite dev proxy target for `/api/*` and `/.well-known/*` |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
