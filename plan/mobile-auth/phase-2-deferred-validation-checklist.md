# Phase 2 Deferred Validation Checklist

Companion checklist for [implementation-spec.md](./implementation-spec.md) and [phase-2-auth-ux-readiness.md](./phase-2-auth-ux-readiness.md).

This checklist captures the hosted mobile OAuth validation that is intentionally deferred while prototype work moves into Phase 3.

## Why This Exists

- Direct browser testing already confirmed that `/auth/mobile` can complete ordinary Bud sign-in.
- The real OAuth transaction path is still unverified because it must begin with a signed `/api/auth/oauth2/authorize` request, not a direct navigation to `/auth/mobile`.
- We are explicitly choosing to continue with API-contract work before closing that gap.

## Status Legend

- `[ ]` not yet run
- `[x]` verified
- `[-]` intentionally deferred

## Verified So Far

- [x] Direct browser entry to `/auth/mobile` can complete ordinary Bud sign-in.

## Deferred Hosted-OAuth Validation

- [ ] A real signed `/api/auth/oauth2/authorize` request reaches `/auth/mobile` correctly.
- [ ] GitHub sign-in resumes the OAuth transaction correctly from that signed request.
- [ ] Google sign-in resumes the OAuth transaction correctly from that signed request.
- [ ] The signed OAuth query survives social-provider redirects intact.
- [ ] Forced `prompt=consent` reaches `/auth/mobile/consent` correctly.
- [ ] The consent page can approve and redirect back into the OAuth transaction.
- [ ] Trusted first-party clients skip consent where expected without breaking authorize completion.
- [ ] The frontend-origin proxy supports the full hosted OAuth flow, including `/.well-known/*`.
- [ ] Normal browser `/login` still works after the shared hosted-auth refactor.

## Prototype Rule

Phase 3 may proceed while these items remain open, but this checklist remains a release and mobile-handoff blocker.

If iOS auth behaves unexpectedly, close these items before assuming the bug is in later API-contract work.

## Preferred Way To Close This

Use the first real iOS-facing client registration from Phase 4 rather than creating a separate throwaway local-only client just for browser validation.

---

*Last Updated: 2026-03-19*
