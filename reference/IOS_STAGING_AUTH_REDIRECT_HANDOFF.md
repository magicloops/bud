# iOS Staging Auth Redirect Handoff

**Status:** Investigation complete; callback contract updated for split app IDs  
**Audience:** Backend, web platform, iOS  
**Last updated:** 2026-04-23

## Purpose

This document captures the current staging auth failure observed on a real iPhone and translates the investigation into a concrete backend/web handoff.

The immediate goal is to determine why the hosted staging sign-in flow does not return to the iOS app after GitHub auth, even though the staging build is configured for a native OAuth callback.

This document now reflects the current non-production callback contract:

- staging/debug callback URI: `chat.bud.app.staging://oauth/callback`
- staging/debug callback scheme: `chat.bud.app.staging`

## Observed Behavior

On 2026-03-24, the `Bud Staging` iPhone build was launched from Xcode against `https://staging.bud.dev`.

Observed runtime behavior:

1. iOS launches the hosted sign-in flow successfully.
2. The hosted page shows provider options as expected.
3. The user signs in with GitHub.
4. After GitHub auth completes, the browser lands on the `https://staging.bud.dev` homepage.
5. The flow does **not** redirect back into the iOS app.

Expected behavior:

1. iOS starts one Authorization Code + PKCE flow.
2. Hosted login and provider auth complete in browser context.
3. The final redirect returns to the native callback URI.
4. `ASWebAuthenticationSession` delivers that callback back to the app.
5. iOS exchanges the code and continues bootstrapping.

## What iOS Is Actually Configured To Do

The staging build is configured with these effective auth values:

- environment: `staging`
- app origin: `https://staging.bud.dev`
- issuer: `https://staging.bud.dev/api/auth`
- client id: `bud-ios-staging`
- redirect URI: `chat.bud.app.staging://oauth/callback`
- callback scheme: `chat.bud.app.staging`
- scopes: `openid profile email offline_access api`

Important implementation facts:

- the iOS app includes `redirect_uri=chat.bud.app.staging://oauth/callback` in the authorize request
- the app starts `ASWebAuthenticationSession` with `callbackURLScheme = "chat.bud.app.staging"`
- for sign-in, the app does **not** depend on `application(_:open:)` or SwiftUI `onOpenURL` to receive the OAuth completion
- if the backend emits the native callback redirect, `ASWebAuthenticationSession` should capture it directly

This means the iOS app is not waiting for a web homepage redirect. It is waiting for a custom-scheme OAuth callback.

## Investigation Conclusion

This failure is much more consistent with a backend/web auth-resume or client-registration issue than with an iOS callback-handling bug.

Why:

- the staging app has the correct callback scheme registered
- the staging bundle resolves the expected redirect URI
- the native auth session is started with that callback scheme
- the observed result is a browser landing on the staging homepage, which implies the hosted auth flow completed in browser context but did not resume the native OAuth transaction

In short:

- if the backend had emitted `chat.bud.app.staging://oauth/callback?...`, the iOS auth session should have resumed
- landing on `https://staging.bud.dev` instead strongly suggests the hosted web flow lost, rejected, or failed to resume the OAuth provider state

## Most Likely Backend/Web Causes

### 1. Staging iOS client is not correctly registered

The staging client may be missing, misnamed, or registered with the wrong redirect URI.

Please verify:

- `bud-ios-staging` exists as a real public OAuth client
- its allowed redirect URIs include `chat.bud.app.staging://oauth/callback` exactly
- it supports Authorization Code + PKCE
- it supports refresh tokens for `offline_access`
- if consent skipping depends on trusted-client registration, the staging client is included there

### 2. Hosted login is not preserving OAuth resume state

This is the most likely explanation for the exact observed symptom.

If the hosted sign-in page or social-provider handoff drops Better Auth's signed OAuth resume payload, the login can still succeed as a normal browser session, but the user will land on a normal web destination such as the staging homepage instead of returning to the native redirect URI.

Please verify:

- the hosted staging login flow preserves the signed OAuth resume payload across GitHub auth
- after GitHub returns, the flow resumes the original `/api/auth/oauth2/authorize` transaction
- the final redirect target remains the original `redirect_uri` from the iOS authorize request

### 3. Staging auth environment drift

The staging web/backend environment may be split or partially configured in a way that is valid for browser auth but not for native OAuth-provider resume.

Please verify:

- `BETTER_AUTH_URL`
- `APP_BASE_URL`
- staging OAuth provider configuration
- staging iOS `client_id`
- staging iOS redirect URI
- any trusted-client or cached-client config used by consent/resume logic

If these values disagree across staging services, the hosted flow may fall back to a default web destination instead of the native callback.

## Why This Is Not Likely To Be An iOS Callback Bug

The sign-in path uses `ASWebAuthenticationSession`, which directly waits for a callback matching the app's registered callback scheme.

That means:

- the app does not need to poll
- the app does not need manual browser dismissal to continue
- the app does not need a separate web-to-app bridge for this first OAuth completion step

If no native callback is emitted, iOS cannot complete the sign-in flow regardless of local app state.

The symptom we saw is not "the callback returned to the app but parsing failed." The symptom is "the browser ended on a normal staging web page instead of the app callback."

## Concrete Backend/Web Checks

Please check these first:

1. Inspect the staging iOS authorize request and confirm the server receives:
   - `client_id=bud-ios-staging`
   - `redirect_uri=chat.bud.app.staging://oauth/callback`
   - `response_type=code`
   - PKCE parameters
2. Confirm `bud-ios-staging` is registered with `chat.bud.app.staging://oauth/callback` exactly.
3. Inspect the post-GitHub redirect chain and determine where the flow stops resuming the original OAuth transaction.
4. Confirm the hosted login page preserves the signed OAuth resume state across GitHub auth.
5. Confirm the final redirect after successful hosted auth is a `302` to `chat.bud.app.staging://oauth/callback?...`, not a navigation to `https://staging.bud.dev`.

## Suggested Validation Pass

We would consider staging auth fixed when the backend team can demonstrate this exact runtime sequence:

1. iOS opens the staging authorize URL.
2. Hosted mobile login appears.
3. GitHub sign-in succeeds.
4. Hosted auth resumes the original OAuth transaction.
5. The final redirect target is `chat.bud.app.staging://oauth/callback?code=<code>&state=<state>`.
6. The iOS app resumes immediately from `ASWebAuthenticationSession`.
7. Token exchange succeeds.
8. `/api/me` loads successfully.

## If You Want One Fast Isolation Test

Two quick comparisons would narrow the issue sharply:

1. Try the same staging build with Google instead of GitHub.
   - If both providers land on the staging homepage, the shared hosted login/resume layer is the likely problem.
   - If only GitHub fails, provider-specific staging config becomes more likely.
2. Log the final redirect target after provider auth on staging.
   - If it is the homepage or another normal web route, the OAuth transaction is not being resumed.
   - If it is `chat.bud.app.staging://oauth/callback?...`, then iOS investigation should continue.

## Requested Backend Response

Please respond with:

1. confirmation that `bud-ios-staging` exists and is registered with `chat.bud.app.staging://oauth/callback`
2. confirmation that staging hosted login preserves OAuth resume state through GitHub auth
3. the exact final redirect URL or redirect chain observed after successful GitHub auth on staging
4. any staging-specific auth env values or topology differences that could affect OAuth-provider resume
5. whether any deployed staging client rows or test builds are still using the retired `chat.bud.app://oauth/callback` URI
