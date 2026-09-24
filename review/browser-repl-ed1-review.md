# Browser REPL review: ed1f95f0

Thread: `ed1f95f0-b967-4d5b-b663-08bd9d57c3be`.
Run: September 24, 2026, 08:41–08:42 UTC. Model: gpt-5.6-luna/high.
Related: [Phase 7b](../plan/bud-owned-browser/repl-phase-7b-output-compaction.md),
[previous 01ce review](browser-repl-01ce-review.md).

## Recheck after Phase 7d implementation

Requeried the local service database on September 24 using this thread ID and
the owning user recorded in the original export. There are still 23 messages,
12 provider calls and two invocations; the latest message is
`2026-09-24T08:42:22.571Z`. All shared exported fields of the messages, provider
calls and invocations match the original review exactly. No additional run is
present. Refreshed private export: `/tmp/bud-repl-ed1-current.json` (0600).

The findings below remain the historical baseline, not validation of the newer
runtime. [Phase 7c](../debug/browser-repl-phase7c.md) subsequently removed page
scroll's snapshot dependency and added generic semantic-role, coverage and
output-budget guidance. Its neutral fixtures reproduced child-frame navigation
invalidating a snapshot, but do not prove that was this run's trigger. Repeated
broad previews are not solved: controlled guidance comparisons did not establish
overall context reduction. [Phase 7d](../debug/browser-startup-helper-upgrade.md)
automates helper installation on restart; it does not change this transcript or
its output budget. A fresh product run is still needed for Phase 7c acceptance.

## Outcome and evidence

The agent opened r/OpenAI, selected the seventh observed post permalink,
“OpenAI rolls out upgraded prompt caching and reduced cached input rates for
GPT-6” (`1woal22`), summarized the loaded discussion and drafted an unsent reply.
This is the same target post as 01ce, but feed order/content and comments changed;
it is useful live evidence, not a controlled benchmark.

Reviewed all ten browser cells, their persisted results, twelve provider usage
records, two invocations and all ten matching local observation traces. Every
trace's daemon result exactly equals its persisted tool data; no recorded stages
or trace values were truncated. This establishes daemon-to-transcript fidelity,
not inspection of the final provider HTTP payload. Thread/owner-scoped database
export and private trace copies are at `/tmp/bud-repl-ed1-review.json` and
`/tmp/bud-repl-ed1-traces/` (0600 files).

Nine cells completed and one scroll failed with `browser_stale_reference`.
There was one generic output overflow, three marked snapshot previews, one
persistent REPL generation, no screenshots, no element clicks, no JSON endpoint
fallback, no artifact reads, and no explicit output-budget expansion. Both
invocations succeeded. No posting action was requested or executed.

## Main-task comparison

Opening turns are excluded from this table:

| Metric | Previous 01ce | This run |
| --- | ---: | ---: |
| Recorded work time | 69.386 s | 49.232 s |
| Browser cells | 15 | 8 |
| Provider calls | 16 | 9 |
| Tool duration total | 3.540 s | 3.629 s |
| Inline browser text bytes | 31,593 | 36,439 |
| Collector output overflows | 7 | 1 |
| First → final provider input | 15,699 → 32,748 | 17,028 → 33,202 |
| Input growth | 17,049 | 16,174 |
| Cumulative provider input | 364,536 | 229,720 |
| Cached input, included above | 347,375 | 213,444 |
| Provider output tokens | 3,388 | 2,333 |
| Loaded comment records evidenced | 19 | 20 |

Time fell 29%, browser calls 47%, and cumulative input 37%. Final context grew
1.4% and inline bytes grew 15%. The benefit is fewer model/recovery rounds, not
a smaller final transcript. Cumulative input repeatedly counts prior history;
cached input is included, not additional. Output includes reasoning tokens.
The new opening turn took 12.352 seconds, two cells, three provider calls,
8,342 inline bytes and 43,736 cumulative input tokens. Whole-thread totals are
273,456 input, 2,548 output and 240,221 cached input tokens.

## What worked

### Compact representation and budget enforcement are active

Cells 2, 5 and 7 used `snapshot.format`, requesting 12,000, 14,000 and 20,000
bytes respectively. None called `repl.setOutputBudget`; the formatter correctly
clamped output to remaining space within the 8,192-byte cell limit, including
cell 5's earlier `tab.info()` print. They showed 124/226, 121/226 and 127/336
nodes respectively, with explicit PREVIEW notices. `source_truncated:false`
means the retained source was complete under its stated accessibility coverage,
not that the printed view contained every captured node.

Short refs and snapshot identity appeared correctly. A repeated opaque URL was
printed once per feed view (1,426 bytes including JSON quotes), referenced seven
times in cell 2 and five in cell 5. Exact strings remained local. No short-ref
click or URL-lookup action was attempted, so this is presentation evidence only.

### Useful overflow prevented another recovery loop

Cell 6's full formatted result was 10,451 bytes. The collector returned exactly
8,192 bytes as an explicitly incomplete excerpt and retained the full artifact.
The excerpt included all first seven post URLs and enough text to identify the
target. The agent navigated to that observed URL next, without reading/reprinting
the artifact, repeating the scroll or losing the successful execution.

The full trace confirms 29 article records, scrollY 1,800 and document height
13,539. Some tail data and the scroll metrics were absent from the model-facing
excerpt, but the requested seventh record was present. This is a concrete
improvement over 01ce's whole-artifact reprint and repeated overflow.

## Remaining issues

### 1. Accessibility roles were mistaken for HTML tags

The post snapshot retained 20 named comment `article` roles and their hierarchy.
The agent queried `document.querySelectorAll('main article')`, then literal
`article` tags with comment links. Both returned empty arrays. It then read
`document.body.innerText`; that returned the discussion successfully, plus only
one literal ARTICLE in its tag probe.

A semantic `article` role does not imply an HTML `<article>` element, and DOM
selectors also do not automatically traverse shadow roots. These observations
show the mismatch; the traces do not include enough DOM structure to determine
the exact custom-element/shadow implementation of every comment. The empty
queries were not evidence that Bud lost comment text: it was already retained
in `postSnap.nodes` and the final body read.

The simplest next step was to select the retained Comments region and its
paragraph/text nodes while preserving article boundaries. There is no need for
a dedicated comment extractor or site recipe. General guidance should distinguish
semantic roles from DOM tag names and prefer already-retained relevant data.

### 2. Broad previews still spend context on repeated structure

Cell 2 spent approximately 3.9 KB before reaching the first feed article, then
included its actions and an opaque URL dictionary entry. Cell 5 printed almost
the same prefix again after recovering from stale state. Source order and honest
omission notices worked, but printing the start of the entire tree repeatedly
still prioritizes navigation/wrappers over task evidence.

Cell 7's first 127 nodes showed three complete comments and the next author
header; the rest of the 336 nodes remained local. The agent did not select that
retained remainder or use a scoped view. It also requested larger `maxBytes`
without increasing the shared cell budget. Explicit larger views require budget
expansion first; blindly raising the default would conceal this distinction.

This run supports better use of selection/scoping before another budget increase.
Further default wrapper suppression needs generic fixtures that retain hierarchy,
identity and actionability, rather than advertising- or site-specific filters.

### 3. One stale scroll recovered, but its invalidation cause is not isolated

Cell 4 failed at its first operation, `tab.scroll(1600)`, so its sleep and DOM
query never ran. The failure happened about 25 seconds after the earlier snapshot,
below the current engine's 60-second TTL. The subsequent snapshot reported the
same target and document. Thus ordinary expiry or established top-level navigation
is not a sufficient explanation; intervening invalidation remains unproven.

Cell 5 reacquired the tab and captured again; cell 6 captured once more and then
successfully scrolled. The facade shares observation state by target, so fetching
a new tab handle alone is not the documented remedy; fresh observation matters.
Investigate observation invalidation separately if this recurs. Do not add blind
mutation retries or weaken stale-element checks based on this one run.

### 4. Ordinal selection and coverage deserve more precise claims

The excerpt contains a community-description article at index 0, followed by
seven post permalinks at indices 1–7. The selected index 7 is the seventh post
among those records and matches the final title. The agent also checked article
text for Ad/sponsored; all 29 results were false, while a separate ad block was
clearly present in the accessibility snapshot. This is stronger than no filter,
but does not prove a general ad-classification contract. No wrong ordinal is
established. Filtering should preserve entity identity/order and explicit
eligibility evidence, not assume every article is a post or every ad is an article.

The final body read used `.slice(0,8000)`, but its actual returned body was 4,697
characters and reached the footer: no character clipping occurred here. It
contained the 20 loaded comment entries also evidenced by the retained snapshot.
The page exposed “22 Go to comments”; two additional comments were not established
as read. The summary should say it covers the loaded discussion, rather than
leave completeness implicit. No expansion/load-more or viewport visibility check
was performed.

The summary's substantive themes are supported by that body text; claims about
pricing, savings and model behavior are discussion claims, not verified facts
from the linked source (which was not opened). The startup/agent-loop bullet
combines related comments into a theme; it should not imply one author made all
of those statements. The requested skeptical draft was not submitted.

## Recommendation and acceptance

Keep 8 KiB for now. Phase 7b's presentation, shared-budget clamp and useful
collector excerpt all worked in this live run. It does not establish universal
context reduction, complete discussion coverage, short-ref click acceptance,
private takeover/recovery, or Phase 8 workspace lifecycle acceptance.

Prioritize a bounded, generic follow-up: select retained semantic evidence before
probing guessed HTML selectors, preserve entity boundaries and explicitly state
coverage. Track stale-scroll invalidation independently. No runtime/prompt changes,
service restarts or browser actions were performed during this review.

## All browser calls

Cells 1–2 are the opening invocation; 3–10 are the main task. All are
`browser_exec`. Sizes count inline text only, excluding envelopes and arguments.

### Cell 1 — 1608 ms

Call: `call_Qoka46VLS4XfCX10iONJWsMZ`. Inline text: 162 bytes.

```javascript
var tabs = await browser.tabs.list(); console.log(tabs); var tab = await browser.tabs.current(); if (!tab) { tab = await browser.tabs.create('https://www.reddit.com/r/OpenAI/'); } else { await tab.goto('https://www.reddit.com/r/OpenAI/'); } console.log(await tab.info());
```

Create the tab and confirm its info.

### Cell 2 — 109 ms

Call: `call_HCw0AwUG68twdlDTnVb9ES8e`. Inline text: 8,180 bytes.

```javascript
var snapshot = await tab.snapshot(); console.log(snapshot.format({maxBytes:12000}));
```

Compact feed view; 124/226 nodes shown.

### Cell 3 — 47 ms

Call: `call_Q6a83UyJyRYSvFcpDIVjoRCh`. Inline text: 5,315 bytes.

```javascript
var arts = await tab.evaluate(() => Array.from(document.querySelectorAll('article')).map((a,i)=>({i, text:(a.innerText||'').slice(0,1200), links:Array.from(a.querySelectorAll('a')).map(x=>({text:(x.innerText||'').trim(),href:x.href})).filter(x=>x.text||x.href.includes('/comments/')).slice(0,8)}))); console.log(arts);
```

Literal article query; three posts plus community wrappers.

### Cell 4 — 37 ms

Call: `call_2s5pQBQ8Tq1FPyvSCVZf4764`. Inline text: 11 bytes.

```javascript
await tab.scroll(1600); await new Promise(r=>setTimeout(r,1200)); var arts2 = await tab.evaluate(() => Array.from(document.querySelectorAll('article')).map((a,i)=>({i, text:(a.innerText||'').replace(/\s+/g,' ').trim().slice(0,350), href:Array.from(a.querySelectorAll('a')).map(x=>x.href).find(h=>h.includes('/comments/'))||null, ad:/\bAd\b|sponsored/i.test(a.innerText||'')}))); console.log(arts2);
```

First scroll fails stale; later statements not executed.

### Cell 5 — 111 ms

Call: `call_BmaajZSeSLobcl811ReRyGwU`. Inline text: 8,172 bytes.

```javascript
var tab2 = await browser.tabs.current(); console.log(await tab2.info()); var snap2 = await tab2.snapshot(); console.log(snap2.format({maxBytes:14000}));
```

Fresh compact feed view; 121/226 nodes shown after info output.

### Cell 6 — 1612 ms

Call: `call_IgESgD7L9xLJQtgeto9RCiAt`. Inline text: 8,192 bytes.

```javascript
var snap3 = await tab2.snapshot(); await tab2.scroll(1800); await new Promise(r=>setTimeout(r,1500)); console.log(await tab2.evaluate(() => ({y:scrollY,h:document.body.scrollHeight, articles:Array.from(document.querySelectorAll('article')).map((a,i)=>({i,txt:(a.innerText||'').replace(/\s+/g,' ').trim().slice(0,260),href:Array.from(a.querySelectorAll('a')).map(x=>x.href).find(h=>h.includes('/comments/'))||null,ad:/\bAd\b|sponsored/i.test(a.innerText||'')}))})));
```

Fresh capture, successful scroll, 1.5-second wait; useful overflow excerpt.

### Cell 7 — 1670 ms

Call: `call_jBqehd3hP9KcVepJnWP0ud7N`. Inline text: 8,184 bytes.

```javascript
await tab2.goto('https://www.reddit.com/r/OpenAI/comments/1woal22/openai_rolls_out_upgraded_prompt_caching_and/'); await new Promise(r=>setTimeout(r,1400)); var postSnap = await tab2.snapshot(); console.log(postSnap.format({maxBytes:20000}));
```

Observed URL navigation, 1.4-second wait, post view; 127/336 nodes shown.

### Cell 8 — 55 ms

Call: `call_PssnIkpAwIl1LGOSF2x1Fqc8`. Inline text: 3 bytes.

```javascript
var commentData = await tab2.evaluate(() => Array.from(document.querySelectorAll('main article')).map((a,i)=>({i,level:(a.getAttribute('aria-level')||null),text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:Array.from(a.querySelectorAll('a')).map(x=>x.href).find(h=>h.includes('/comment/'))||null}))); console.log(JSON.stringify(commentData));
```

Literal main/article query returns [].

### Cell 9 — 52 ms

Call: `call_XTfcv3fUCQbVeo5Kz7pVs9HC`. Inline text: 3 bytes.

```javascript
var allComments = await tab2.evaluate(() => Array.from(document.querySelectorAll('article')).map((a,i)=>({i,text:(a.innerText||'').replace(/\s+/g,' ').trim(),href:Array.from(a.querySelectorAll('a')).map(x=>x.href).find(h=>h.includes('/comment/'))||null})).filter(x=>x.href)); console.log(JSON.stringify(allComments));
```

Broader literal article/comment-link query also returns [].

### Cell 10 — 45 ms

Call: `call_Zna3qxdjl4pyJ3AI0V02WjYe`. Inline text: 6,559 bytes.

```javascript
console.log((await tab2.evaluate(() => ({title:document.title,body:(document.body.innerText||'').slice(0,8000), tags:Array.from(document.body.querySelectorAll('*')).filter(e=>e.tagName.toLowerCase().includes('article')).slice(0,10).map(e=>e.tagName)}))));
```

Body-text fallback returns 4,697 characters including footer; no source slice reached.
