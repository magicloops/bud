# lib

Utility functions and shared helpers.

## Purpose

Provides common utilities for API communication, browser auth, route auth
redirects, model loading, terminal input/data handling, proxied web-view
contracts, theming, and class name management.

## Files

### `api.ts`

Compatibility re-export surface for older imports.

**Purpose**:
- Re-exports auth redirect helpers, transport helpers, auth API helpers, API types, terminal decoding, and message-id generation from the new split modules below
- Lets existing routes continue importing from `@/lib/api` while the web refactor migrates call sites toward narrower modules

### `transport.ts`

Low-level auth-aware browser transport helpers.

**Responsibilities**:
- `buildApiUrl()` / `buildAbsoluteApiUrl()` for same-origin and cross-origin API calls
- `apiFetch()` with `credentials: 'include'`
- `apiFetchJson()` with structured `ApiError`
- `readResponseErrorMessage()` for consistent browser mutation/load error extraction from JSON or text responses
- `createAuthEventSource()` for SSE plus post-close unauthorized checks
- Redirect-on-`401` behavior unless callers explicitly pass `redirectOnUnauthorized: false`

**Types**:
- `ApiRequestInit`
- `ApiError`

### `auth-redirect.ts`

Browser login redirect helpers.

**Responsibilities**:
- Normalize safe same-origin in-app redirect targets
- Preserve current pathname/search/hash when bouncing to `/login`
- Deduplicate browser redirects so reconnect loops can detect an in-flight auth redirect
- Accept either app-relative paths or same-origin absolute URLs and collapse everything else to `/`

### `auth-redirect.test.ts`

Node-runner coverage for the lowest-risk browser auth redirect helpers.

**Coverage**:
- internal relative path preservation
- protocol-relative and cross-origin redirect rejection
- same-origin absolute redirect normalization
- login URL construction with encoded redirect targets

### `auth-api.ts`

Authenticated browser session/profile calls.

**Exports**:
- `fetchCurrentUser()` - normalized `/api/me` loader helper returning `ApiCurrentUser | null`
- `updateCurrentUserProfile()` - `PATCH /api/me/profile`

### `api-types.ts`

Shared browser API types plus narrow response normalization helpers.

**Types**:

| Type | Description |
|------|-------------|
| `ApiBud` | Bud response (id, name, status, capabilities) |
| `ApiThread` | Thread response (id, title, session info, stored/effective model selection) |
| `ApiMessage` | Message response (`message_id`, `client_id`, role, content) |
| `ApiMessagePage` | Cursor-paged thread transcript window with `{ messages, page }` |
| `ApiAgentEnvironment` | Client-safe Bud environment snapshot (`normal` or `bud_offline`) plus terminal, web-view, and user-question tool availability |
| `ApiCreateMessageResponse` | Message-create response with canonical message fields plus optional `agent` startup metadata such as mode, Bud status, and stream cursor |
| `ApiAgentState` | Current in-flight agent snapshot with `stream_cursor`, environment, `pending_tool.client_id`, `pending_tool.started_at`, `pending_tool.args.wait_for` for terminal tools, `waiting_for_user` phase support, `draft_assistant.client_id`, and optional `context_budget` |
| `ApiContextBudget` | Browser-visible context budget snapshot for the current conversation since the latest compaction checkpoint, including hard model window, Bud usable context window, output reserve, usable input window, compaction-threshold usage, authoritative estimate basis, message/tool-schema token split, provenance (`source`, `phase`, `turn_id`, `checked_at`), optional provider usage diagnostics, confidence, and unknown/failure states |
| `ApiAgentCompactionStartEvent` / `ApiAgentCompactionDoneEvent` / `ApiAgentCompactionFailedEvent` | Agent SSE activity markers for automatic context compaction, including token counts, phase/reason, checkpoint id on success, optional post-compaction `context_budget`, and sanitized failure metadata |
| `ApiCurrentUser` | Authenticated user/session/profile payload from `/api/me` |
| `ApiUpdateProfileInput` | Username update payload for `/api/me/profile` |
| `ApiDeviceAuthFlow` / `ApiDeviceAuthApproval` | Device-claim browser contracts |
| `ApiFileSession` / `ApiOpenThreadFileResponse` | File-viewer session and thread-open response contracts |
| `ApiProxyTransport` | Browser-visible proxy data-plane availability and health summary |
| `ApiProxiedSite` / `ApiProxiedSiteListResponse` | Durable Bud-owned proxied-site contracts, including separate HTTP proxy and WebSocket/HMR transport readiness |
| `ApiThreadWebView` / `ApiThreadWebViewResponse` | Current thread web-view attachment contract |
| `ApiViewerGrantResponse` | One-time hosted-auth bootstrap URL for private proxied sites |
| `ApiAskUserQuestionsRequest` / `ApiAskUserQuestionsResponseInput` / `ApiAskUserQuestionsToolResult` | `ask_user_questions` prompt, response, and completed tool-result contracts |

**Capability Normalization**:
```typescript
export function normalizeCapabilities(caps: unknown): {
  sessions: boolean
  terminal: boolean
} | null
```

Safely extracts the behavior-oriented capability fields the browser actually cares about from the API response. tmux identity/version details are no longer surfaced in the normal browser contract.

Tool transcript note:
- tool rows still expose generic `metadata: Record<string, unknown>`, and completed canonical tool rows may now include additive timing fields such as `started_at`, `finished_at`, and `duration_ms` inside that metadata object
- terminal tool rows and live pending-tool snapshots expose the effective `wait_for` value so clients can detect settled waits without elapsed-time heuristics
- web-view tool rows may expose a `web_view` runtime payload instead of
  terminal `output`/`readiness` fields
- message-create responses may expose `agent.mode: "bud_offline"` and `agent.stream_cursor` so routes can treat an offline Bud send as a successful assistant turn rather than a failed submit
- user-question pending tool rows expose normalized `ask_user_questions_request_v1` payloads, and completed rows may expose `ask_user_questions_tool_result_v1` Q/A summaries

### `route-auth.ts`

Route-level auth helpers shared across loaders and authenticated screens.

**Exports**:
- `toLoginRedirect(pathname, search?, hash?)` - TanStack Router redirect object targeting `/login`
- `useRequireAuthenticatedUser(currentUser)` - runtime browser redirect helper for routes like `/settings`

### `models.ts`

Shared model-list loading for workbench routes.

**Exports**:
- `ModelInfo`
- `ReasoningLevel`
- `ReasoningOption`
- `getSelectedModelInfo(models, selectedModel)`
- `getReasoningOptionsForModel(models, selectedModel)`
- `getDefaultReasoningForModel(models, selectedModel)`
- `normalizeReasoningForModel(models, selectedModel, currentReasoning)`
- `useAvailableModels(budId?)`

**Behavior**:
- Loads `/api/models` globally or `/api/models?bud_id=...` for Bud-scoped
  workbench routes
- Consumes catalog-backed product models directly
- Consumes Bud-local ds4 metadata (`request_mode`, `compatibility`, and
  `source.kind`) without exposing endpoint or compatibility-mode selectors
- Consumes usable-context policy fields (`usable_context_window_tokens`,
  `reserved_output_tokens`, and `usable_input_window_tokens`) without
  recomputing budget thresholds client-side
- Preserves an existing selection when possible
- Tracks `service_default_model`, falls back to `default_model` or the first available model, and exposes `default_reasoning_effort`
- Exposes per-model reasoning options and defaults so routes do not hardcode provider behavior
- Normalizes stale reasoning selections to the selected model's default level

### `messages.ts`

Small message helper module.

**Exports**:
- `generateMessageClientId()` - browser UUIDv7 generator for optimistic/new-thread sends

### `file-paths.ts`

Conservative parser for user-clickable file references in rendered assistant
Markdown and Markdown file previews.

**Exports**:
- `parseFilePathCandidate(input, sourceSurface)` - returns a relative or absolute POSIX path candidate with optional line/column metadata or `null`
- `FilePathCandidate` - parsed path union plus source surface (`markdown_link`, `inline_code`, or future `plain_text`)
- `OpenFileCandidate` / `OpenFileSource` - click payload sent to the thread file-open route
- `filePathCandidateDisplayPath(...)` and `toOpenFileCandidate(...)` - helpers for renderer labels and source-stamped open payloads

**Behavior**:
- accepts relative file-like paths, leading `./`, known file names such as `README`, and known source/doc extensions
- accepts high-confidence absolute POSIX paths such as `/Users/adam/bud/README.md` when they have file-like signals
- parses `:line`, `:line:column`, and `#Lline` / `#Lline-Lend`
- rejects app-like slash paths, home, parent traversal, Windows/backslash, URL, email, NUL, directory, and low-confidence non-file forms

### `file-paths.test.ts`

Node-runner coverage for accepted relative and absolute POSIX paths,
line/column extraction, and unsafe/false-positive rejection.

### `terminal-data.ts`

Terminal-history/output decode helper.

**Exports**:
- `decodeTerminalData(data)` - base64 → binary → UTF-8 text

### `terminal-input.ts`

Browser-terminal input translation helpers.

**Responsibilities**:
- Detect whether the browser is on a Mac-like platform for shortcut precedence
- Translate supported keydown events into explicit terminal byte/text intents
- Preserve browser-native copy/paste shortcuts instead of pretending to support full terminal modifier forwarding
- Build explicit paste intents from clipboard text
- Log unsupported modifier/composition cases in development so phase-1 omissions are visible

**Supported terminal actions**:
- Printable text
- `Enter`, `Tab`, `Backspace`, `Escape`
- Arrows, `Home`, `End`, `PageUp`, `PageDown`
- Raw `Ctrl+A` through `Ctrl+Z`
- Multiline paste text

**Exports**:
- `detectTerminalInputPlatform()` - `mac` vs `non-mac` shortcut precedence
- `translateTerminalKeydown()` - keydown to terminal/browser/unsupported intent translation
- `createTerminalPasteIntent()` - clipboard text to explicit paste intent
- `logUnsupportedTerminalKeydown()` - dev-only unsupported key logging
- `logUnsupportedTerminalComposition()` - dev-only IME/composition logging

### `claim-mobile-handoff.ts`

Hosted-claim callback helpers for native/mobile app handoff.

**Responsibilities**:
- Parse `/devices/claim/$flowId` search params for `source=ios`, `mobile_callback_url`, and `mobile_error_callback_url`
- Validate candidate callback URLs against the allowlisted prefixes from `VITE_MOBILE_CLAIM_CALLBACK_ALLOWED_PREFIXES`
- Normalize whether mobile callback mode is active for the hosted claim route
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
| `uuid` | UUIDv7 message `client_id` generation |
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
