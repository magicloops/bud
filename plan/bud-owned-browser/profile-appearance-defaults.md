# Bud browser profile appearance defaults

Follow-up: [Phase 3n](phase-3n-bud-color-sync.md) scopes syncing the theme color
from the owning Bud on each browser launch. It is not implemented yet; the current
first-creation behavior below remains in effect.

Seed new empty persistent profiles with the user-selected name `Bud Browser`,
Chrome avatar 44 and theme seed `#FF00FF`, variant 1. Let Chrome derive highlights;
its toolbar is not guaranteed to exactly reproduce the seed, especially in dark mode.
Do not change existing profiles or overwrite later user choices. Reset followed
by a new launch reapplies defaults. No service, wire or database changes.

Implementation: `bud/src/browser/profile.rs`, under the existing ownership lock
and surviving-Chrome check, atomically publish `Default/Preferences` before launch.
Only the five selected appearance preferences are seeded; no account data copied.
Chrome preference keys are implementation details, so validate them on the supported
Chrome version when upgrading. Interrupted staging fails conservatively: an existing
nonempty profile is never rewritten for cosmetic reasons.

Validation: unit coverage for seeding, preservation and reset; daemon build;
disposable Chrome launch to verify it retains the chosen appearance preferences.
Spec: `bud/src/browser/browser.spec.md`.

Implemented and validated: all three profile tests and daemon build pass;
disposable Chrome 152 retains the preferences and derives the expected profile
name/avatar metadata. See [validation details](../../debug/browser-profile-appearance-validation.md).
