# Review: REPL latency in thread 3297763

Reviewed 2026-09-23. Thread `3297763e-fb32-403d-b30b-57baa1594e72`.
Read-only review of owner-scoped local messages, provider usage, invocation timing
and action receipts; no browser actions, installations or process restarts.

## Finding

The Phase 3 interaction API was not loaded in this run. The agent's upvote calls
failed twice with `postPage.getByReference is not a function` and once with
`postPage.getByRole is not a function`. Introspection returned only Phase 2 tab
methods: id/info/title/url/goto/snapshot/visibleDom/evaluate/frames/frame/screenshot.
The posting turn fetched a fresh tab and found the same methods, so this was not
only a retained old tab handle after an API upgrade.

The installed manifest was prepared at 22:13:49 UTC and points to
`~/.bud/browser/helper/v0.1.19-20-gb59dcbe-dirty/main.mjs`. Reading its sibling
`repl-api.mjs` confirms it lacks the Phase 3 methods present in the checkout.
The transcript's exception stack points to this same installed helper directory.
This establishes an installed-source mismatch; the version string alone does
not distinguish changes inside a dirty checkout. Do not treat this run as
acceptance or a speed measurement of the complete Phase 3 interaction API.

## Timing

All reviewed invocations used gpt-5.6-luna with high reasoning effort.
Work time is the service-owned `agent_invocation.work_duration_ms`; tool time is
the sum of tool-message `duration_ms` with `duration_source:service_wall_clock`.

| Request | Work time | Browser cells | Recorded tool execution | Provider calls |
| --- | ---: | ---: | ---: | ---: |
| Find tenth non-ad post, 21:36 UTC | 43.75s | 7 | 1.00s | 8 |
| Summarize comments, 21:37 | 8.29s | 0 | 0s | 1 |
| Open OpenAI subreddit, 22:14 | 13.24s | 2 | 0.87s | 3 |
| Search GPT-7 posts, 22:14 | 17.29s | 2 | 0.59s | 3 |
| Open first post and upvote, 22:15 | 86.69s | 18 | 1.07s | 19 |
| Read comments and propose draft, 22:17 | 15.01s | 1 | 0.04s | 2 |
| Revise draft, 22:23 | 3.85s | 0 | 0s | 1 |
| Post approved comment, 22:24 | 150.81s | 29 | 4.00s | 30 |

Median tool execution was 48ms for upvoting and 41ms for posting. Posting includes
explicit agent-authored waits of 1.5s and 1s. Approximately 85.62s and 146.81s of
the two slow turns were outside the recorded tool intervals. That remainder
includes provider latency, reasoning/code generation, request construction and
orchestration; the available ledger does not separate all of those accurately.
`llm_call.created_at` and `completed_at` are equal in these rows, so subtracting
them would falsely report zero provider latency. Reasoning-summary durations
alone are not complete model-call timing either.

## What consumed the steps

Upvoting used eleven navigation/DOM-discovery cells before its first accessible
snapshot, then three missing-method failures, facade introspection, an evaluated
shadow-root button click and verification. The final evidence shows pressed=true
and displayed count changing from 0 to 1. Broad document selectors initially
missed controls inside open shadow roots; the accessible snapshot later exposed
the upvote control directly. The exact fraction attributable to stale deployment
versus agent discovery choices cannot be established from this one run.

Posting took 29 cells. The agent inspected composer markup/prototypes, tried
`execCommand`, DOM replacement, synthetic input events and component setters,
then explored shadow-root rich-text state and form submission. The old facade
offered none of the advertised semantic click/fill methods. These workarounds
required repeated model decisions despite mostly millisecond tool execution.
One form attempt returned `browser_outcome_unknown`. A later reload confirmed
the approved comment appeared and displayed comment count increased from 13 to
14. The transcript does not establish which submit attempt committed it; future
guidance should continue requiring verification before repeating uncertain writes.

The upvote and posting turns emitted about 31.1 KiB and 30.0 KiB of text. Small
outputs can still be slow when they require many serial model round trips.
Provider input grew from 39,990 to 59,424 during upvoting and from 61,404 to
85,589 during posting. This is accumulated context per request, not summed billing.

## Comparison with the prior tool flow

Thread `ce762991-33b7-4cf2-89cb-1a8e9d54cad4` used the same model/effort and the
same initial task prompts, but different live page content:

| Task | Previous tools | REPL |
| --- | ---: | ---: |
| Find tenth non-ad post | 50.30s; 15 tools; 16 provider calls | 43.75s; 7 cells; 8 provider calls |
| Summarize comments | 16.82s; 3 tools; 4 provider calls | 8.29s; cached evidence; 1 provider call |

The finding turn's provider input grew 13,202 → 101,285 with old tools versus
19,017 → 33,182 with REPL. This supports reduced context and fewer steps for
selective reading. It is not a controlled benchmark, and there is no corresponding
old-tool upvote/posting task in that earlier thread for a direct speed comparison.

## Next steps

1. Rebuild the daemon binary and prepare the helper from that rebuilt binary,
   then restart the daemon. Verify the running facade has getByReference/getByRole,
   insertText/select/close and tabs.create before another interaction trial.
   Updating the checkout or restarting an old extracted helper is insufficient.
2. Repeat an appropriate user-authorized interaction with the matching stack.
   Prefer fresh accessible observations and semantic actions; evaluate remains
   useful for selective extraction, not a default replacement for click/fill.
3. Assess remaining delays after removing the deployment mismatch. Batch related
   local inspection/output where useful, without blindly batching uncertain writes.
   Keep guidance general across sites, as planned in Phase 4.

No production code was changed in this review. Matching-helper activation and
the subsequent interaction test remain outstanding.
