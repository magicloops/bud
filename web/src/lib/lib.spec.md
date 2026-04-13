# lib

Utility functions and shared helpers.

## Purpose

Provides common utilities for API communication, browser auth, terminal transport boundaries, theming, and class name management.

## Files

### `api.ts`

API utilities and type definitions.

**Key responsibilities**:
- Build relative or absolute API URLs for same-origin and cross-origin modes
- Centralize credentialed `fetch(...)` calls plus auth-expiry redirects
- Create auth-aware `EventSource` instances for SSE routes
- Decode base64 terminal output into bytes or UTF-8 text
- Define shared API response/request types used by routes and controllers

**Terminal helpers**:
```typescript
export const decodeBase64Bytes = (data: string) => Uint8Array
export const decodeTerminalChunk = (data: string, skipBytes = 0) => ({ byteLength, text })
export const decodeTerminalData = (data: string) => string
```

`decodeTerminalChunk(...)` exists so terminal replay code can trim overlapping bytes before decoding a durable chunk back into text.

**Terminal-related API types**:
- `BrowserTerminalInputSource` - Browser source taxonomy: `human` or `emulator_protocol`
- `ApiTerminalState` - Safe terminal bootstrap response with `session_id`, `state`, `latest_byte_offset`, `readiness`, `bootstrap`, `updated_at`, plus transitional `snapshot`
- `ApiTerminalSendRequest` / `ApiTerminalSendResponse` - Structured browser terminal-send contract, including optional nested `observe`

**Other important API types**:
- `ApiBud` - Bud response (id, name, status, capabilities)
- `ApiThread` - Thread response (id, title, session info)
- `ApiMessage` - Message response (`message_id`, `client_id`, role, content)
- `ApiMessagePage` - Cursor-paged thread transcript window with `{ messages, page }`
- `ApiAgentState` - Current in-flight agent snapshot with `stream_cursor`, `pending_tool.client_id`, and `draft_assistant.client_id`
- `ApiCurrentUser` - Authenticated user/session/profile payload from `/api/me`
- `ApiUpdateProfileInput` - Username update payload for `/api/me/profile`

### `terminal-xterm-input.ts`

xterm-specific browser input classification.

**Responsibilities**:
- Hooks xterm internal `coreService.onUserInput` and `coreService.onData`
- Distinguishes likely human keystrokes from xterm-emitted emulator protocol replies
- Falls back to public `terminal.onData(...)` classification when the internal hooks are unavailable
- Exposes `{ data, source }` events for the terminal controller

### `thread-terminal-controller.ts`

Browser-side terminal transport controller.

**Responsibilities**:
- Attaches to xterm and consumes classified input from `terminal-xterm-input.ts`
- Routes normal browser typing and modeled keys through structured `/terminal/send`, explicitly setting `observe: null` so typing is not gated on post-send observation
- Keeps a narrow raw fallback for unsupported human sequences and emulator protocol traffic
- Tracks `lastRenderedByteOffset` so reconnects can resume with `after_offset=<n>`
- Applies richer `/terminal/state` bootstrap payloads before live stream attach
- Uses `bootstrap.kind: "grid"` as the preferred restore path, rendering exact visible rows plus explicit cursor placement through xterm's public write path
- Explicitly degrades `grid` bootstrap to text when local xterm geometry does not match the captured pane geometry
- Restricts trailing-blank trimming to degraded/text bootstrap paths instead of applying it to full-fidelity grid restores
- Trims overlapping durable replay bytes before writing into xterm
- Logs bootstrap-shape and xterm buffer metrics in dev so cursor/bootstrap regressions remain inspectable while the richer contract rolls out

**Structured coverage in the first pass**:
- Printable text batches
- Enter / submit
- Tab
- Backspace
- Escape
- Arrow keys, Home/End, Delete, PageUp/PageDown
- Ctrl+C through the existing interrupt route

### `claim-mobile-handoff.ts`

Hosted-claim callback helpers for native/mobile app handoff.

**Responsibilities**:
- Parse `/devices/claim/$flowId` search params for `source=ios`, `mobile_callback_url`, and `mobile_error_callback_url`
- Validate candidate callback URLs against the allowlisted prefixes from `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES`
- Normalize whether mobile callback mode is active for the claim route
- Build final success and error callback URLs while preserving any existing callback query params

**Exports**:
- `parseClaimMobileHandoff(search)` - normalized mobile-callback state for the claim route
- `buildClaimSuccessCallbackUrl(baseUrl, payload)` - appends `flow_id` and `bud_id`
- `buildClaimErrorCallbackUrl(baseUrl, payload)` - appends `flow_id`, `error`, and optional `error_description`

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

### `theme-colors.ts`

Color manipulation for bud-specific theming.

**Key functions**:
- `getMutedColor(color, factor)` - Reduce chroma (saturation)
- `resolveCssVar(variable)` - Resolve CSS variable to computed value
- `deriveBudPalette(color)` - Generate vibrant/muted/soft variants

### `utils.ts`

General utilities.

**Key function**:
```typescript
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

## Dependencies

| Import | Purpose |
|--------|---------|
| `better-auth/react` | Better Auth browser client |
| `@better-auth/oauth-provider/client` | Signed OAuth Provider query propagation for hosted auth pages |
| `uuid` | UUIDv7 message `client_id` generation |
| `xterm` | Terminal types for browser transport helpers |
| `clsx` | Conditional class names |
| `tailwind-merge` | Tailwind class deduplication |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | Optional API server URL for cross-origin |
| `VITE_API_PROXY_TARGET` | Vite dev proxy target for `/api/*` and `/.well-known/*` |
| `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES` | Comma-separated allowlist of hosted mobile-claim callback prefixes |

---

*Referenced by: [../src.spec.md](../src.spec.md)*
