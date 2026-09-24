# Browser REPL review: 1575f787

Thread: `1575f787-2bf8-40af-87c4-fac3b65b4f6b`.
Reviewed September 24, 2026; run 07:07–07:08 UTC.
Related: [previous trace review](browser-repl-f44-trace-review.md),
[Phase 7](../plan/bud-owned-browser/repl-phase-7-actionability.md).

## Outcome and evidence

The agent opened the community, selected “Hegseth” (`1woqcva`) as the seventh
article in its observed feed, read two comments, inspected the post screenshot,
and drafted a reply without submitting it. Both invocations succeeded.

Reviewed every browser cell's exact code and persisted result, all 15 matching
local observation traces, provider usage records, and the retained screenshot.
Database reads were scoped to the requested thread and its owner. All 15
`daemon_result` values exactly match persisted tool `data`; no trace stages were
omitted or diagnostic values truncated. This checks daemon-to-transcript delivery,
not an independent capture of the final provider HTTP request.

Private evidence: `/tmp/bud-repl-1575-review.json`,
`/tmp/bud-repl-1575-traces/`, `/tmp/1575-screenshot.png`, with owner-only permissions.
Raw page dumps and images are not checked in. The exact cell code below makes
this review reproducible without publishing the full page records.

## Timing and context

Both invocations used gpt-5.6-luna/high. Opening the community used one browser
cell and two provider calls, with 5.06 seconds recorded work duration. The main
task used 14 cells and 15 provider calls. All browser calls were `browser_exec`.

| Main-task metric | Previous f44 | This run |
| --- | ---: | ---: |
| Recorded work duration | 134.9 s | 53.93 s |
| Browser cells | 28 | 14 |
| Provider calls | 29 | 15 |
| Inline browser text bytes | 22,921 | 15,699 |
| Inline output overflows | 4 | 4 |
| First → last provider input tokens | 15,444 → 42,120 | 13,477 → 26,262 |
| Input growth | 26,676 | 12,785 |
| Cumulative provider input | 832,065 | 281,566 |
| Cached input (included above) | 805,238 | 268,670 |
| Provider output tokens | 4,286 | 2,278 |
| Sum of tool durations | 9.38 s | 2.664 s |
| Emitted screenshots | 4 | 1 |

This is a substantially shorter run, but not a controlled Phase 7 comparison:
the selected post had two readily available short comments; the previous post
required collapsed-content and image investigation. Cumulative input includes
repeated history, not just new context. Output tokens include 739 reasoning
tokens. Inline bytes exclude code, envelopes and images. The remaining wall
time cannot be attributed solely to model compute from these records.

## Findings

### Phase 7 hints are present; clicking was not exercised

The first snapshot retained 368 nodes and 73 pointer hints; the second retained
219 nodes and 36 hints. Both report `truncated:false`, no continuation and
`accessible_dom` coverage. The agent explicitly queried `cursor` in its projection.
This demonstrates the new hint field survives into REPL observations.

There were **no element clicks, geometry queries or positioned clicks**. The agent
used an observed URL and `tab.goto()` to open the post. Therefore this run neither
validates nor disproves the native-click fix for collapsed disclosures. Also,
its pointer filter required a nonempty name, which would still discard an unnamed
pointer-hinted header like the one in the previous failure. Those projected
results overflowed, so the model did not receive them inline anyway.

### Output selection remains the main avoidable waste

Cells 2–4 produced three consecutive overflows: 21,733, 18,007 and 33,765 bytes.
The complete snapshot was available in memory. Reprinting the first 18,000
characters of an artifact cannot fit an 8,192-byte inline limit. The next attempt
filtered roles but still selected up to 100 records and redundant fields,
including potentially long URLs. This is emission/projection waste, not missing
page capture, and it did not require another page read.

Cell 8 captured a 7,884-byte JSON value, but its default inspected representation
formatted to 10,107 bytes and overflowed. Formatting overhead matters. Cell 9
successfully projected retained `posts2`, but printed all **28** articles:
8,151 bytes, about **52% of all inline browser text** in the main task. Only the
first seven eligible entries and the selected entry's identity were necessary
for this request. Array length and character slicing are weak output budgets.

Cell 13 added 3,343 bytes of whole-page text and all post attributes, including
irrelevant ad copy, CSS classes, feature flags and internal IDs. Together cells
9 and 13 account for about 73% of inline text. The general improvement is bounded
entity/field selection before emission, not domain-specific ad-URL removal or a
larger snapshot budget. Preserve exact URLs needed for actions.

### Stale scrolling still occurs

Cell 6 failed `tab.scroll(1031)` with `browser_stale_reference` in 43 ms. Its wait
and subsequent extraction did not run; the trace records only the failed scroll.
A new snapshot (cell 7) followed by scrolling (cell 8) succeeded. Memory and
runtime generation remained intact throughout the thread.

The first snapshot was only about 13 seconds old and advertised a 60-second
lifetime. Expiration by that advertised TTL alone does not explain the rejection.
The two snapshots retain the same document ID, although their node populations
changed. These records do not identify which internal validity condition failed.
This repeats the previous run's need to refresh a semantic observation before a
viewport scroll and warrants a focused guard/invalidation investigation.

### Selection is supported, but ad detection is heuristic

Cell 5 matched both article and nested post wrappers, returning each of three
stories twice. The agent recognized the duplication and switched to articles.
Cell 9 lists distinct article URLs, with “Hegseth” at index 6. Cell 10 reports no
ad matches for the first 15 articles, then cell 11 navigates to `posts2[6].href`.
This supports the chosen ordinal within the captured article list.

It does not prove complete ad exclusion: the text regex checks promoted,
advertising and sponsor wording, and attributes on the article itself. It does
not establish that every relevant wrapper exposes those signals. The ad metadata
and feed list were also read at different times, joined by index rather than
stable identity. No incorrect ordinal is demonstrated here. For general dynamic
lists, retain identity, ordering and eligibility evidence in one extraction.

### Comments are grounded; image paraphrase has a small attribution error

Cell 12 returns two short comments. Cell 13 exposes `comment-count:2`, and the
screenshot also shows two comments. Both returned bodies match the final answer.
There is no collapsed-body investigation or JSON-endpoint fallback. This supports
coverage at the observed moment, not a guarantee about future comments.

The screenshot belongs to the selected post and clearly shows its title and
meme. However, the final answer says Claude first states there was nothing on the
ship. In the image, that statement is part of the **user's correction** of a prior
claim attributed to Claude; Claude's visible response agrees with the correction.
The broad interpretation is plausible, but the speaker sequence is misstated.
This is a visual interpretation error, not evidence of an adjacent-post image
association bug or tool delivery failure. The draft was not posted.

## Recommended follow-ups

1. Investigate the repeated stale-reference scroll guard with a neutral changing
   page fixture; preserve ownership/document checks while identifying why a
   viewport action needs refreshed semantic references.
2. Reinforce selection from retained values after overflow: fewer records and
   explicit fields, with a byte-aware final emission. This run does not justify
   raising capture limits or adding a site-specific extractor.
3. Keep live Phase 7 click acceptance separate: exercise an actual disclosure
   with an unnamed pointer-hinted header and nested links. This run verifies
   hint retention, not native action targeting.
4. In visual summaries, preserve who said what and distinguish visible text from
   inferred prior dialogue. No browser API change is indicated by this mistake.

## All browser calls

Numbers cover the entire thread: cell 1 is the opening invocation; cells 2–15
are the substantive task. Times are service-recorded tool durations. The following
code is the exact stored argument; outcomes summarize the complete stored results.

### Cell 1 — 474 ms

Call ID: `call_bLmpyW8oit3OC6l2CiVmCEDg`.

```javascript
var tab = await browser.tabs.open('https://www.reddit.com/r/antiai/'); await tab.info()
```

Opened the requested community; info returned its URL and an empty title during loading.

### Cell 2 — 156 ms

Call ID: `call_U3earZZdMxfkpqBhLM4FjbWq`.

```javascript
var snap = await tab.snapshot(); ({title:snap.nodes.find(n=>n.role==='heading')?.name, url:await tab.url(), coverage:snap.coverage, limitations:snap.limitations, nodes:snap.nodes.slice(0,120).map(n=>({depth:n.depth,role:n.role,name:n.name,text:n.text,url:n.url,reference:n.reference,cursor:n.cursor}))})
```

Snapshot succeeded; 21,733-byte formatted projection omitted inline and retained as an artifact.

### Cell 3 — 47 ms

Call ID: `call_XHHaKU9gbvwy0Pj4Bo399Lu7`.

```javascript
var t = repl.files.read('df1a6dc0-fa45-4280-b71a-d875da6597aa.txt'); console.log(t.slice(0,18000))
```

Read the overflow artifact; 18,007-byte re-emission overflowed again.

### Cell 4 — 34 ms

Call ID: `call_fksakCD7xbhZuQfFJHEFowN9`.

```javascript
console.log(JSON.stringify(snap.nodes.filter(n=>n.role==='link'||n.role==='article'||n.role==='heading'||(n.cursor==='pointer'&&n.name)).map((n,i)=>({i,depth:n.depth,role:n.role,name:n.name,text:n.text,url:n.url,reference:n.reference,cursor:n.cursor})).slice(0,100)))
```

Filtered the retained snapshot; 33,765-byte projection overflowed again.

### Cell 5 — 38 ms

Call ID: `call_KdyiXwFU4YnfOcprVlfg9I5B`.

```javascript
var posts = await tab.evaluate(()=>Array.from(document.querySelectorAll('article, shreddit-post, [data-testid="post-container"]')).map((el,i)=>({i,tag:el.tagName,text:(el.innerText||'').slice(0,1000),href:el.querySelector('a[href*="/comments/"]')?.href}))); console.log(posts)
```

Returned six wrappers representing three duplicated stories.

### Cell 6 — 43 ms

Call ID: `call_o9PHi29U0htEaoQu98jRS2La`.

```javascript
await tab.scroll(1031); await new Promise(r=>setTimeout(r,800)); var posts2 = await tab.evaluate(()=>Array.from(document.querySelectorAll('article')).map((el,i)=>({i,text:(el.innerText||'').slice(0,500),href:el.querySelector('a[href*="/comments/"]')?.href}))); console.log(posts2)
```

Scroll failed with browser_stale_reference; remaining statements did not run.

### Cell 7 — 115 ms

Call ID: `call_zEkauDET7KX0biRmENkLXURb`.

```javascript
var snap2=await tab.snapshot(); console.log({url:await tab.url(),coverage:snap2.coverage,limitations:snap2.limitations})
```

Fresh snapshot succeeded; emitted URL, coverage and limitations only.

### Cell 8 — 1056 ms

Call ID: `call_mrGwT1xyBqSolFlI2NdrhVB4`.

```javascript
await tab.scroll(1000); await new Promise(r=>setTimeout(r,1000)); var posts2 = await tab.evaluate(()=>Array.from(document.querySelectorAll('article')).map((el,i)=>({i,text:(el.innerText||'').slice(0,500),href:el.querySelector('a[href*="/comments/"]')?.href}))); console.log(posts2)
```

Scroll and one-second wait succeeded; retained 28 article records; 10,107-byte formatted output overflowed.

### Cell 9 — 36 ms

Call ID: `call_TqeJCvwdp2mKwTJsn0qk6eNZ`.

```javascript
console.log(JSON.stringify(posts2.map(p=>({i:p.i,title:p.text.split('\n').slice(0,8),href:p.href}))))
```

Emitted 28 retained article projections in 8,151 bytes; index 6 is the selected post.

### Cell 10 — 43 ms

Call ID: `call_UYQxMrMwfwbdnKLw97g5nQfV`.

```javascript
var meta=await tab.evaluate(()=>Array.from(document.querySelectorAll('article')).map((el,i)=>({i,ad:/promot|advertis|sponsor/i.test(el.innerText||'')||el.matches('[data-promoted], [promoted]'),attrs:Array.from(el.attributes).filter(a=>/promot|ad|sponsor/i.test(a.name+' '+a.value)).map(a=>[a.name,a.value])}))); console.log(meta.slice(0,15))
```

Ad heuristic returned false and empty matching attributes for the first 15 articles.

### Cell 11 — 315 ms

Call ID: `call_HT1Jh8I9z00EgKJHSEMcw73f`.

```javascript
var targetUrl=posts2[6].href; await tab.goto(targetUrl); await tab.info()
```

Navigated to the observed index-6 URL; info confirmed the target URL.

### Cell 12 — 45 ms

Call ID: `call_CnbhzhD0tLI12BWUWsG7KrB3`.

```javascript
var postPage=await tab.evaluate(()=>({title:document.title,posts:Array.from(document.querySelectorAll('article')).map((el,i)=>({i,text:(el.innerText||'').slice(0,2200)})),comments:Array.from(document.querySelectorAll('shreddit-comment, [data-testid="comment"]')).map((el,i)=>({i,text:(el.innerText||'').slice(0,1200)}))})); console.log({title:postPage.title,posts:postPage.posts,commentCount:postPage.comments.length,comments:postPage.comments.slice(0,20)})
```

Returned the selected page title and both comment bodies; article selector returned no post wrappers.

### Cell 13 — 61 ms

Call ID: `call_3kXzT7mbBXxVlskRNctXcUbY`.

```javascript
var pageText=await tab.evaluate(()=>({body:(document.body.innerText||'').slice(0,10000),tags:Array.from(document.querySelectorAll('shreddit-post, article, [data-testid="post-container"]')).map(el=>({tag:el.tagName,text:(el.innerText||'').slice(0,3000),htmlAttrs:Array.from(el.attributes).map(a=>[a.name,a.value])}))})); console.log(pageText)
```

Returned page text and post attributes, including identity, media URL and comment-count 2.

### Cell 14 — 56 ms

Call ID: `call_O4Kun1HFHouiXlUAE1Biqr2n`.

```javascript
var media=await tab.evaluate(()=>Array.from(document.querySelectorAll('shreddit-post img, shreddit-post video, shreddit-post [role="img"]')).map(el=>({tag:el.tagName,alt:el.alt||'',src:el.currentSrc||el.src||'',aria:el.getAttribute('aria-label')}))); console.log(media)
```

Returned four image records: community icon plus three representations of the post image.

### Cell 15 — 619 ms

Call ID: `call_lBmLwDJ6jRIowI3D7vYjqTkQ`.

```javascript
await repl.emitImage(await tab.screenshot())
```

Emitted one screenshot of the selected post; inspected during this review.

No application code, prompts, runtime processes or browser state were changed for this review.
