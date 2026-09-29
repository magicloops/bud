# Debug: Browser setup environment persistence

## Environment and observations
During implementation of the browser window setup option, inspection found that
the shared env writer replaced only the first matching assignment and treated
all read errors as an empty file. Managed startup applies the last assignment.

## Reproduction
Persist a new mode to a file with two BUD_BROWSER_HEADED assignments: a trailing
old value could continue winning. An unreadable file could be treated as blank.

## Expected and fix
Replace the setting once, remove duplicate assignments (including export and
whitespace forms), preserve unrelated lines, and propagate non-NotFound reads.
The browser CLI regression verifies both mode values and error handling. Related
spec: [daemon source](../bud/src/src.spec.md).
