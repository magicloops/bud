# Bud browser profile appearance defaults

[Phase 3n](phase-3n-bud-color-sync.md) now syncs the theme seed from the owning Bud
on each actual Chrome process launch. Running Chrome is never edited/restarted.
The first-creation name/avatar defaults below remain in effect.

Seed new empty persistent profiles with the user-selected name `Bud Browser`,
Chrome avatar 44 and theme seed `#FF00FF`, variant 1. Let Chrome derive highlights;
its toolbar is not guaranteed to exactly reproduce the seed, especially in dark mode.
Preserve later name/avatar and theme-variant choices. Color alone is Bud-managed:
new/existing profiles use the service's current accent seed at launch, retaining
magenta only when no valid color is supplied. Installed themes are not removed
and may take precedence. Reset followed by launch reapplies defaults and current
Bud color. Optional service-owned browser_color metadata adds no database field.

Implementation: `bud/src/browser/profile.rs`, under the existing ownership lock
and surviving-Chrome check, atomically publish `Default/Preferences` before launch.
Only the five selected appearance preferences are seeded; no account data copied.
Chrome preference keys are implementation details, so validate them on the supported
Chrome version when upgrading. Interrupted staging fails conservatively: an existing
nonempty profile is never re-seeded. Launch-time color updates parse the full
Preferences object and atomically replace only changed theme seed/absent variant;
unsafe or malformed files are not overwritten. Local State is left to Chrome.

Validation: unit coverage for seeding, preservation and reset; daemon build;
disposable Chrome launch to verify it retains the chosen appearance preferences.
Spec: `bud/src/browser/browser.spec.md`.

Implemented and validated: all three profile tests and daemon build pass;
disposable Chrome 152 retains the preferences and derives the expected profile
name/avatar metadata. See [validation details](../../debug/browser-profile-appearance-validation.md).
