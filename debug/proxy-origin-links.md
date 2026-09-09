# Debug: Proxy deep links

## Environment and reproduction
Production, September 9 2026. Persona Pages root site and Dennis page site both target 127.0.0.1:5176 on the same Bud. Root-site deep links fail while newly opened page-site links work.

## Observed
Read-only production inspection: both enabled and unexpired; only the Dennis site is currently attached. Site reuse compares default_path; mobile only intercepts current attachment host. Gateway forwards incoming path/query directly. Shell 401 is expected and does not establish a routing failure.

## Proposed fix
Reuse by owner/Bud/host/port; resolve any owned hostname at click time without changing attachment. Preserve aliases, path/query/fragment and existing private viewer grant flow. See ../plan/proxy-origin-links.md.

## Validation results

Service/web builds passed; 37 service proxy/route tests and 3 web resolver tests passed. Changed web files pass ESLint. iOS simulator build and 8 focused WebProxyModelsTests passed (including historical-site opening, attachment preservation, encoded path/query/fragment, external fallback, and reset cancellation). Device/authenticated browser end-to-end verification remains after deployment. No production writes or commits.
