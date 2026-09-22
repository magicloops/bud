# Debug: browser observations exhausted by layout nodes

## Evidence
Thread 41322550-2dce-41c3-84b4-6927fc405b12 returns successful observations
with 100 elements, truncated=true, mostly empty table rows and footer links.
The adapter copies Chrome's flat AX array order and spends the observation budget
on structural nodes before reaching story links. Transport success does not imply
useful page evidence.

## Fix
Traverse childIds in reading order, omitting layout-only nodes while preserving
their descendants. Keep unlabeled controls, named semantic content and text;
omit duplicate text labels beneath an already named semantic element. Bound output
at 256 elements and 64 KiB serialized element bytes, preserving truncated=true.
References remain document/observation scoped. Never serialize AX values/properties.
No new action/schema fields; old services accept the same bounded result shape.
A rebuilt daemon is required. Larger pages can still truncate; pagination remains
separate scope, rather than pretending the observation is complete.

## Validation
Use a table-heavy local page in real Chrome, verify story 16 and its actionable
reference, reading order, truncation and absence of synthetic password values.

Initial full browser suite found two blank-page fixtures failing with
`called Option::unwrap() on a None value` in manager.rs:1091/1185. The filter
removed an unnamed RootWebArea; preserve the page root even when untitled so a
blank document remains identifiable. Table fixture and privacy checks passed.

Final validation: all 14 browser tests pass with the installed Chrome for Testing;
`cargo build` passes. The local table fixture returns 30 ordered story links and
clicks story 16 through its opaque reference, verifies stale references fail after
a new observation, excludes a synthetic password value, and reports truncation on
400 controls. AgentTranscriptWriter persists/returns the full execution payload;
the observed loss occurs before transport, in the old AX selection.
