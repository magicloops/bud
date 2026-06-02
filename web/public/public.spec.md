# public

Static assets served directly without processing.

## Purpose

Contains files served as-is from the web root. These bypass Vite's asset pipeline.

## Files

### Favicon and App Icon Assets

Browser and install-surface icons for Bud:

- `favicon.ico`
- `favicon-16x16.png`
- `favicon-32x32.png`
- `apple-touch-icon.png`
- `android-chrome-192x192.png`
- `android-chrome-512x512.png`

These are referenced from `web/index.html` and, for the Android Chrome icons,
from `site.webmanifest`.

### `site.webmanifest`

Web App Manifest served directly at `/site.webmanifest`. Vite treats this as a
normal public asset; the browser discovers it through the manifest link in
`web/index.html`.

### Logo and Provider Assets

- `bud_logo.png`
- `bud_logo_web.png`
- `bud_logo_web_dark.png`
- `GitHub_Invertocat_Black.png`

## Notes

Files in `public/`:
- Served at root URL path (e.g., `public/icon.png` → `/icon.png`)
- Not processed or hashed by Vite
- Should be used for assets that need stable URLs (favicons, robots.txt, etc.)
- Referenced in `index.html` or via absolute paths

---

*Referenced by: [../web.spec.md](../web.spec.md)*
