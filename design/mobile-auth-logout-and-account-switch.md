# Design: Mobile Auth Logout And Account-Switch Contract

Status: Draft

Audience: Backend, web platform, and iOS

Last updated: 2026-03-20

## 1. Goal

Define the backend/web contract for mobile logout and account switching after local iOS auth became functional.

This document is not about fixing local token exchange or `/api/me`. Those paths already work. It is about the next product/auth gap:

- app sign-out clears native credentials
- but the next hosted sign-in can silently reuse the previous Bud browser session
- that makes logout semantics incomplete and makes provider/account-switch testing unreliable

## 2. Validated Current Behavior

The mobile team note in [`reference/IOS_AUTH_LOGOUT_AND_ACCOUNT_SWITCH_GAP.md`](../reference/IOS_AUTH_LOGOUT_AND_ACCOUNT_SWITCH_GAP.md) is directionally correct.

Confirmed in the current repo:

- bearer-mode mobile sign-out is revoke-only
  - [`POST /api/me/oauth/revoke`](../service/src/routes/me.ts) revokes OAuth tokens for the mobile client
  - [`POST /api/me/logout`](../service/src/routes/me.ts) is cookie-session-only and rejects bearer callers with `cookie_session_required`
- the local/mobile handoff explicitly documents that current mobile sign-out is revocation plus local token clearing, not hosted-session logout
  - see [`IOS_LOCAL_AUTH_HANDOFF.md`](../IOS_LOCAL_AUTH_HANDOFF.md)
- the hosted mobile login page auto-resumes the OAuth transaction when a Bud browser session already exists
  - [`web/src/routes/auth.mobile.tsx`](../web/src/routes/auth.mobile.tsx) checks `currentUser` and immediately redirects back into `/api/auth/oauth2/authorize`
- the hosted OAuth resume helper currently strips `prompt=login` before resuming the authorize request
  - [`web/src/lib/oauth-provider.ts`](../web/src/lib/oauth-provider.ts)

Conclusion:

- this is not just an iOS token-storage bug
- this is also not a regression against the current local handoff
- it is a real backend/web contract gap for production-quality mobile logout and account switching

## 3. Why Sign-In Reuses The Prior Account

There are three independent session layers:

1. Native app session
   - access token
   - refresh token
   - local Keychain/session state
2. Bud-hosted auth session
   - Better Auth cookie/session state in the hosted browser context
3. Upstream provider session
   - Google or GitHub browser session state

Today, mobile sign-out only clears layer 1 and revokes the OAuth token set. It does not explicitly terminate layer 2, and it does not attempt to clear layer 3.

Because layer 2 remains active, the next trip through `/auth/mobile` can skip straight back into the OAuth authorization flow under the same Bud user. In practice, that means Google/GitHub account choice often never appears.

## 4. Important Nuances

### 4.1 This is not proof that iOS is wrong

If the app really is:

- clearing native tokens locally
- calling `POST /api/me/oauth/revoke`

then it is already following the current documented local contract.

The missing behavior is that Bud does not yet expose a first-class mobile logout mechanism for the hosted Better Auth session.

### 4.2 This is not proof that Better Auth or ASWebAuthenticationSession is broken

Persistent browser-session reuse is expected behavior for hosted OAuth flows. It is useful for normal sign-in convenience.

The problem is that Bud has not yet defined:

- what "Sign out" means for mobile
- what "Sign in with different account" means for mobile
- which hosted/browser session transitions are required for each

### 4.3 Provider prompts are not enough by themselves

Google is already configured with `prompt: "select_account"` in [`service/src/auth/auth.ts`](../service/src/auth/auth.ts).

That does not solve the current gap, because an existing Bud browser session means the hosted login page can resume authorization without sending the user back through Google at all.

## 5. Problem Statement

Bud currently has only one mobile-adjacent logout primitive:

- token revocation

That is sufficient for local bearer invalidation, but insufficient for either of these user expectations:

1. "Sign out"
   - the user expects the app and hosted Bud auth context to be signed out
2. "Use a different account"
   - the user expects the next sign-in to force a fresh auth decision instead of silently reusing the prior Bud session

Those are separate product flows and should not be treated as accidental side effects of token revocation.

## 6. Design Direction

### 6.1 Separate `sign out` from `switch account`

Bud should support two distinct mobile actions:

1. `Sign out`
   - clear native app credentials
   - revoke the mobile token set
   - terminate the Bud-hosted auth session used by the hosted mobile flow
2. `Switch account`
   - do everything from `Sign out`
   - then start a fresh hosted authorization flow with account-selection / reauthentication semantics

This gives product and iOS a clean contract instead of relying on incidental browser-state behavior.

### 6.2 Add a first-party hosted logout primitive

Bud needs a mobile-safe way to clear the Better Auth browser session, not just revoke OAuth tokens.

Acceptable shapes include:

- a backend-owned mobile logout route
- a hosted logout page/flow
- an RP-initiated logout/end-session flow if we choose to support one

The implementation shape is still open. The design requirement is not:

- "globally log the user out of Google or GitHub"

The requirement is:

- "clear Bud's hosted first-party auth session so the next hosted mobile flow starts from a known Bud-auth state"

### 6.3 Add an explicit account-switch entry path

Bud should define a supported way to force a fresh hosted auth decision for mobile.

That likely means one of:

- preserve and honor `prompt=login`
- preserve and honor `prompt=select_account` where supported
- add a dedicated `switch_account` hosted entry path or query flag
- require hosted logout before the follow-up authorize request

Current code is not ready for this as-is because the hosted resume helper strips `prompt=login`.

### 6.4 Keep provider logout out of scope

Production mobile logout should not depend on fully logging the user out of Google or GitHub in the system browser.

That is too broad, provider-specific, and not necessary for Bud's first-party logout semantics.

## 7. Proposed Contract

### 7.1 Mobile sign-out contract

Target contract:

1. iOS clears local app session state
2. iOS revokes the refresh token or current token set
3. iOS invokes Bud's hosted logout primitive
4. Bud clears the hosted Better Auth session
5. Bud returns a completion signal or post-logout redirect

Result:

- app is signed out locally
- Bud-hosted session is gone
- next sign-in starts from a clean Bud-hosted state

### 7.2 Mobile switch-account contract

Target contract:

1. iOS invokes Bud's account-switch path
2. Bud ensures the hosted Better Auth session is not silently reused
3. Bud starts a new hosted auth decision flow
4. provider-specific account-choice prompts are applied where available

Result:

- the next sign-in does not silently continue as the previous Bud user

## 8. Required Backend/Web Outputs

Once this work is formalized, backend/web should publish these per environment:

- hosted logout URL or endpoint
- whether Bud supports end-session / RP-initiated logout
- whether Bud supports `prompt=login`
- whether Bud supports `prompt=select_account`
- any required post-logout redirect values
- provider-specific caveats for Google and GitHub

## 9. Non-Goals

This design does not require:

- global Google logout
- global GitHub logout
- ephemeral browser sessions as the default sign-in mode

Ephemeral browser sessions may still be useful as a testing tactic or fallback, but they should not be the core product answer.

## 10. Open Questions

1. What exact hosted logout primitive do we want to own in Bud?
2. Should `Sign out` and `Switch account` be two separate UI actions in mobile?
3. Should switch-account semantics be implemented as authorize prompts, a dedicated hosted path, or both?
4. Do we want Google and GitHub to share one generic Bud contract even if their provider-level behavior differs?
5. What should the post-logout redirect/return experience look like in the hosted browser context?

## 11. Recommendation

Recommended direction:

- keep revoke for token invalidation
- add a Bud-owned hosted-session logout mechanism for mobile
- add an explicit switch-account path instead of assuming revoke implies account choice
- document provider-specific behavior, but do not make Bud depend on provider-global logout

This matches the mobile team's assessment in principle, while grounding it in the current Bud implementation details.
