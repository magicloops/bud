# Review: REPL thread 15ed5c8e

Reviewed 2026-09-23. Thread `15ed5c8e-c1ef-46e7-978b-44b604511f44`.
Read-only inspection of local thread-owner-scoped messages, invocations and
provider usage. No browser interaction, installation or restart performed.

## Findings

1. **The interaction API was still missing.** Both `tab.getByReference` and
   `tab.getByRole` failed as “not a function.” `Object.keys(tab)` listed only
   Phase 2 methods. Exception stacks point to the installed
   `v0.1.19-20-gb59dcbe-dirty` helper. This repeats the previous thread's runtime
   mismatch; it does not validate Phase 3 click/fill behavior.
2. **The selected post does not match the recorded ordinal.** The agent called
   “Made entirely with Opus 5.5 + OpenRouter API key” the seventh regular post,
   but it is eighth in its emitted article groups. Seventh is “Looking back at
   how it all started: vibe coding with GPT-3 in 2020.” The transcript provides
   no explicit reason for excluding that entry. These are snapshot groups, not
   an independent reconstruction of the rendered viewport. The grouping code
   also collects everything until the next article, ignoring depth, so adjacent
   sponsored content leaks into preceding groups. Ordinal selection should use
   a compact explicitly numbered list with actual subtree boundaries.
3. **The draft was filled and revised, with no submit action in the transcript.**
   After the missing semantic methods, the agent tried execCommand, DOM
   replacement and synthetic input, then inspected and manipulated Lexical
   internals. Those are brittle workarounds. The later revision's immediate
   result still contained old text; a separate read confirmed the new text in
   both DOM and editor state. Immediate `ok:true` was not sufficient evidence.
4. **Context reduction is not consistent yet.** The main turn emitted 140,176
   bytes (~136.9 KiB) of inline text across its cells. Two broad outputs hit the
   32 KiB inline limit, another article grouping was ~29.9 KiB, and the comment
   extraction was ~21.3 KiB. Repeated links, long URLs, navigation and control
   metadata plus editor introspection remain costly. Selective extraction should
   happen before output; removing particular sites' URLs is unnecessary.

## Timing and usage

All three turns used gpt-5.6-luna, high reasoning effort.

| Task | Work time | Cells | Sum of tool duration | Provider calls | Input tokens, first → last |
| --- | ---: | ---: | ---: | ---: | ---: |
| Open subreddit | 8.94s | 3 | 0.61s | 4 | 12,714 → 13,669 |
| Find seventh post, read comments, fill unsent draft | 87.71s | 22 | 1.79s | 23 | 13,732 → 91,197 |
| Revise unsent draft | 10.58s | 2 | 0.10s | 3 | 91,594 → 92,955 |

Work time is service-owned invocation duration. Tool duration is the sum of
service-wall-clock tool metadata. The ~85.9 seconds outside tools in the main
turn includes provider latency/generation and orchestration; it cannot all be
attributed to reasoning. Input tokens are per-request context, not summed billing.
There is no identical earlier task for a controlled speed comparison.

The initial snapshot failed with `browser_document_changed` after navigation;
a subsequent info read confirmed the destination. A later editor introspection
returned `browser_outcome_unknown`. Neither establishes a viewer disconnect.
The visible comment extraction covered only part of the discussion; the agent's
reasoning acknowledged that limitation, but its final summary could state it
more clearly.

## Next steps

- Activate the rebuilt daemon and matching prepared helper and verify the actual
  runtime exposes the advertised Phase 3 interactions before further testing.
- Retest semantic fill on a rich-text editor and verify draft contents without
  submitting. Do not treat this run's internal-editor workaround as acceptance.
- In Phase 4, use general guidance for compact numbered extraction, subtree
  boundaries, selective output and verification after mutation. Keep guidance
  site-independent and distinguish observed comment samples from full coverage.

Related: [previous latency review](browser-repl-3297763-latency.md).
