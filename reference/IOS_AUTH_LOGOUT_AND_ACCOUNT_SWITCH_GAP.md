# iOS Auth Logout And Account-Switch Gap

**Status:** Open production auth gap  
**Audience:** Backend, web platform, iOS  
**Last updated:** 2026-03-20

## Purpose

This document captures a production auth gap discovered during local iOS OAuth validation:

- mobile sign-out currently clears native tokens and revokes bearer access
- but it does not fully sign the user out of the hosted auth session used by `ASWebAuthenticationSession`
- as a result, signing out and then signing back in can silently reuse the previous account

That behavior is acceptable for the current local auth tranche, but it is not sufficient for a production-quality logout and account-switch story.

## Current Observed Behavior

In the current iOS implementation:

1. the app signs out
2. native bearer credentials are cleared locally
3. the app calls `POST /api/me/oauth/revoke`
4. the next sign-in starts a new hosted OAuth flow
5. the hosted auth flow remembers the prior user and signs back into the same account automatically

This means the user cannot reliably:

- sign out and remain signed out from the hosted auth context
- sign out and then choose a different account on the next sign-in

## Why This Happens

This is not just an iOS token-storage issue. It is a multi-layer session issue.

There are three distinct auth states involved:

1. **Native app session**
   - access token
   - refresh token
   - local Keychain state

2. **Hosted auth-server session**
   - Better Auth cookie/session state
   - reused by `ASWebAuthenticationSession`

3. **Provider session**
   - Google session
   - GitHub session
   - any upstream provider account-selection state

Today, mobile sign-out only clears the first layer and revokes bearer credentials. It does not explicitly terminate the second layer, and it does not attempt to clear the third layer.

## Current Contract Shape

The current first-tranche contract intentionally treats mobile sign-out as:

- revoke bearer token
- delete local native session

and explicitly does **not** require RP-initiated logout or browser-session logout.

That is consistent with:

- `reference/IOS_LOCAL_AUTH_HANDOFF.md`
- `reference/mobile-team-handoff-guide.md`

It is also consistent with the current iOS auth launcher using persistent browser auth state rather than an ephemeral session.

## Why This Is A Production Gap

For production, users need two separate guarantees:

### 1. Sign out

When the user taps `Sign out`, the app should:

- clear native tokens
- revoke the refresh token or access token as appropriate
- terminate the hosted first-party auth session for this app

Without that hosted-session termination, the sign-out UX is incomplete and misleading.

### 2. Sign in with different account

When the user explicitly wants a different account, the system must not silently reuse the previous hosted session.

That means the product needs a supported way to force one of:

- fresh hosted login
- account chooser / account selection
- explicit reauthentication

This is a product/auth contract question, not just a native-client implementation detail.

## Production Recommendation

The recommended production behavior is:

1. **Normal sign-in**
   - keep using hosted OAuth through `ASWebAuthenticationSession`
   - allow session reuse for convenience when the user is still signed in

2. **Sign out**
   - clear local app tokens
   - revoke the mobile token set
   - clear the hosted Better Auth session for the app

3. **Switch account**
   - explicitly force a fresh hosted login or account-selection path
   - do not depend on token revocation alone to achieve this

## What Backend/Auth Needs To Provide

### 1. A first-class mobile logout contract

Backend should define and support one of these:

- OIDC end-session / RP-initiated logout flow
- a backend-owned mobile logout endpoint that clears the hosted auth session
- another explicit hosted logout path that is safe for native-app use

The important requirement is that mobile can clear the first-party hosted auth session, not just revoke bearer tokens.

### 2. Clear account-switch semantics

Backend/web should define the supported way to force a different-account login on the hosted OAuth flow.

Examples of what needs to be decided:

- should the authorize flow support `prompt=login`?
- should the hosted flow support `prompt=select_account` where providers allow it?
- should there be a dedicated "switch account" entry path?
- should mobile call hosted logout first, then start authorize?

### 3. Provider-specific expectations

Backend should document what behavior is expected for:

- Google
- GitHub

Important note:

- production mobile logout should not be designed around globally logging the user out of Google or GitHub
- the main goal is to clear the Bud-hosted auth session and force a fresh first-party auth decision

### 4. Environment bundle additions

If logout/account-switch becomes part of the formal mobile contract, backend should publish these per environment:

- end-session or hosted logout URL
- whether RP-initiated logout is supported
- whether `prompt=login` is supported
- whether `prompt=select_account` is supported
- any required post-logout redirect values
- any provider-specific caveats

## Open Questions For Backend

1. What is the intended production logout primitive for mobile:
   - revoke only
   - RP-initiated logout
   - custom hosted logout
2. Can the hosted OAuth flow support a reliable "switch account" path?
3. Should mobile treat `Sign out` and `Sign in with different account` as distinct flows?
4. Does Better Auth in the current deployment already support an end-session flow we can adopt?
5. If not, what backend-owned logout route should mobile use instead?

## Recommended Backend Decision

Recommended direction:

- keep revoke for token invalidation
- add a first-party hosted-session logout mechanism for mobile
- define an explicit account-switch flow that forces a new hosted auth decision
- do not make mobile depend on global provider logout

## Suggested Validation Once Backend Is Ready

After backend publishes the updated contract, the joint validation should confirm:

1. sign out clears native tokens
2. sign out clears the hosted Better Auth session
3. next sign-in does not silently reuse the prior user unless that is the intended UX
4. switch-account flow allows selecting a different Google/GitHub-backed Bud user
5. token revoke behavior still works for public clients

## iOS-Side Notes

This gap is not solely caused by iOS, but the native app will need to align with the final backend contract.

Likely client-side follow-up after backend direction is finalized:

- preserve the current normal sign-in flow for convenience
- update sign-out to use the new hosted logout/end-session mechanism
- add a distinct switch-account path if product wants stronger guarantees than normal sign-out
- only consider ephemeral browser sessions as a fallback or explicit account-switch tactic, not as the default global behavior

## Related Docs

- `IOS_AUTH_BACKEND_HANDOFF.md`
- `reference/IOS_LOCAL_AUTH_HANDOFF.md`
- `reference/mobile-team-handoff-guide.md`
- `design/auth/ios-backend-integration.md`
