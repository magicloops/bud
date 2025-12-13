# public

Static assets served directly without processing.

## Purpose

Contains files served as-is from the web root. These bypass Vite's asset pipeline.

## Files

### `vite.svg`

Vite logo SVG. Default template asset.

**Served at**: `/vite.svg`

## Notes

Files in `public/`:
- Served at root URL path (e.g., `public/icon.png` → `/icon.png`)
- Not processed or hashed by Vite
- Should be used for assets that need stable URLs (favicons, robots.txt, etc.)
- Referenced in `index.html` or via absolute paths

---

*Referenced by: [../web.spec.md](../web.spec.md)*
