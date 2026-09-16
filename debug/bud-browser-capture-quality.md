# Debug: blurry browser screenshots

The legacy path caps JPEG quality at 65 and resolution at 1280px; enlarged Retina
panes therefore cannot display one captured pixel per device pixel. Implement
negotiated PNG/high-density captures without changing CSS layout or input authority.
See plan/bud-owned-browser/phase-3c-screenshot-quality.md.

Validation build `pnpm build` from web initially failed with
`src/features/browser/media.ts(30,5): error TS1294: This syntax is not allowed when
'erasableSyntaxOnly' is enabled.` Replaced the constructor parameter property with
an explicit class field and assignment; no compiler settings changed.
