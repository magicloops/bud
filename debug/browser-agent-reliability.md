# Debug: focused browser agent reliability (Phase 3g)

## Environment and reproduction

Local macOS, Chrome for Testing, GPT-5.6 Luna; reviewed thread
`d34e4e7b-3571-4770-be5e-fac926330eca` via owner-scoped read-only local DB queries.
The two haiku requests covered six stories; see
[browser context measurements](browser-compact-observations.md).

## Evidence and proposed fixes

- Both rejected browser_act calls supplied action=click, a reference, target_id
  and observation_id (other strict-provider fields were null). The error envelope
  showed args={} because validation precedes normalization; the canonical output
  ledger preserved the real inputs. The strict reference-click schema allowed
  only action/reference. Accept the explicit identity pair through existing
  semantic inspect, preserving IDs and freshness validation. Bare reference
  clicks retain their legacy path. Reject ambiguous locator+reference, partial
  identity pairs and unrelated fields. Unsupported daemons reject before dispatch.
- A continuation from snapshot 7 was used after visible-DOM observations 8/9;
  a later click also used snapshot 7 after snapshot a. These are correctly stale.
  Clarify that fresh snapshot/visible-DOM/scoped reads replace the one retained
  observation, while continuation preserves it. Do not loosen fences or retry.
- Both visible-DOM reads reported scroll_y=104. This could be the page's maximum
  scroll at height=1110 rather than input loss. Reproduce bounded scrolling and
  viewport filtering on a deterministic page before changing the helper.
- The agent read partial article captures without following their continuations.
  Add concise coverage guidance: fetch more only when relevant evidence is missing,
  and accurately describe partial/blocked/fallback reading. No automatic page drain.

## Scope and contracts

No new route, DB field, viewer permission or wire variant. Owned invocation and
broker authorization continue to govern all operations. New service uses existing
semantic_observations capability for identity-qualified reference clicks; old
service/new daemon remains unchanged. No daemon upgrade is needed for that fix.
Existing five tools and observation budgets remain. No snapshot archive or REPL.

## Investigation notes

An initial read-only query used nonexistent llm_call_item.call_id and failed with
PostgreSQL 42703; reran with the schema's tool_call_id and recovered both canonical
inputs. No data was changed.

## Validation

- Service build passed; focused parser, broker, tool/execution and result-budget
  suites: 11 passed, one optional prototype test skipped.
- Real Chrome for Testing helper suite: 7 passed, none skipped. Explicit
  target/observation/reference click worked; stale identity rejected.
- A fixture with viewport height 1110 and document height 1214 produced scroll_y
  104 after both 875- and 1500-pixel wheel requests. Visible-node boxes intersected
  the viewport. This establishes a valid explanation, not the historical page's
  measured scrollHeight; original page bounds were not recorded. No scroll change.
- Existing compact fixture still measured 81.0% byte reduction.
- Updated concise tool descriptions for observation replacement and reading
  coverage. These guide the model but do not enforce complete article reading.
- Actual-agent rerun remains pending. No daemon restart, new model run, automatic
  retries or user-browser manipulation performed. Service changes use existing
  semantic inspect fields; no new daemon capability is needed.
