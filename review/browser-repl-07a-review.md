# Browser REPL review: 07a5739b

Thread: `07a5739b-b9a2-4a2f-9706-472ec793ad3b`.
Run: September 24, 2026, 07:48–07:49 UTC.
Related: [previous 1575 review](browser-repl-1575-review.md),
[Phase 7](../plan/bud-owned-browser/repl-phase-7-actionability.md).

## Outcome and evidence

The agent opened r/OpenAI, selected “Thank you Google 🎉🥳🥳” (`1wktdag`),
read 42 loaded comment records, and produced a summary and an unsent draft.
All 14 browser cells succeeded. There were no clicks, screenshots, scrolling,
private-control interruptions, session-limit failures or JSON-endpoint fallback.
One REPL generation persisted throughout both invocations.

Reviewed every cell's exact code and full saved result, both invocations,
provider usage, and all 14 matching local observation traces. Database reads
were scoped to the requested thread and owner. Every trace's `daemon_result`
exactly matches persisted tool `data`; no diagnostic stages or captured trace
values were omitted/truncated. This establishes daemon-to-transcript fidelity,
not independent verification of the final provider HTTP payload.
Private evidence remains in `/tmp/bud-repl-07a-review.json` and
`/tmp/bud-repl-07a-traces/`, with owner-only permissions. Raw page records are not
checked in; the exact cell arguments are included below.

## Timing and context

Both invocations used gpt-5.6-luna/high. Opening the community used two browser
cells, three provider calls, 5,266 inline text bytes and 12.816 seconds recorded
work time. The main task used 12 cells and 13 provider calls.

| Main-task metric | Previous 1575 | This run |
| --- | ---: | ---: |
| Recorded work duration | 53.928 s | 54.787 s |
| Browser cells | 14 | 12 |
| Provider calls | 15 | 13 |
| Recorded tool duration total | 2.664 s | 0.912 s |
| Inline browser text bytes | 15,699 | 25,332 |
| Overflow cells | 4 | 5 |
| First → final provider input tokens | 13,477 → 26,262 | 15,973 → 29,365 |
| Input growth | 12,785 | 13,392 |
| Cumulative provider input | 281,566 | 281,998 |
| Cached input (included above) | 268,670 | 268,485 |
| Provider output tokens | 2,278 | 2,738 |
| Loaded comments extracted | 2 | 42 |
| Emitted screenshots | 1 | 0 |

The new run processed much more discussion in roughly the same time, with fewer
calls and nearly identical cumulative input. Inline text grew about 61%, while
input growth rose only about 5%; images, code and envelopes also affect provider
context. These are different pages/tasks, not a controlled efficiency benchmark.
Cumulative input counts repeated history, not the context-window size. Recorded
tool time does not isolate model generation or orchestration latency.

## Findings

### Useful recovery: removing nested-record duplication

Initial comment extraction read each enclosing comment's `innerText`, so parent
records included descendant replies that also appeared as separate records.
Cell 10 makes this visible. The agent investigated the DOM and changed to the
body's observed `[slot="comment"]` element. Cells 13–14 then emitted the 42
nonempty bodies in two batches, retaining author, score and depth.

This is a useful example of general REPL inspection: discover the actual record
boundary, retain the data, and project only the relevant body. It does not call
for a dedicated comment extractor. The query still searches any descendant of
each wrapper, rather than proving the selected body belongs to that wrapper;
for a missing parent body it could pick a child's body. No such mismatch is
established in this run, but the general entity-ownership check remains useful.

### Five overflows and expensive structural discovery

Cells 3–5 overflowed consecutively at 37,929, 20,478 and 8,782 bytes. Cell 4
successfully reused retained `posts` but selected too many records/fields; cell 5
switched to a DOM query matching both outer articles and inner post wrappers.
Cell 6 reduced the emitted fields enough to fit, but still repeated every story.

Cells 8–9 overflowed at 13,799 and 15,055 bytes. Cell 9's first console write
(the post metadata) survived; the comments write did not fit. Its
`truncated:true` and artifact describe the omitted output. It is not a runtime
failure or a reason to repeat navigation/extraction.

Cells 11–12 emitted 9,260 bytes of attributes and nested HTML to identify the
comment body: about 37% of main-task inline text. The final two clean comment
batches together used only 5,873 bytes. A compact structural description—tag,
slot/role and ancestry of the relevant body—would have supplied the needed
selector evidence without repeating CSS, SVG, loaders and avatar markup.

The two full feed snapshots had identical recorded upstream content and each
materialized 1,398 nodes with 156 pointer hints, `truncated:false`, into a
253,535-byte local result. This large local value did **not** automatically enter
model context. The opening turn printed 5,107 bytes of mostly navigation/header
nodes; the next turn took another snapshot. Refreshing for current state is
reasonable, but dumping the first nodes is poorly targeted to finding feed items.

### Coverage was qualified, but two bodies were silently shortened

The final answer explicitly says **42 loaded comments**, which appropriately
limits its claim. It does not establish full-thread coverage: no expansion,
load-more interaction or full-count verification occurred. The captured post
text ends in `103`, but without its semantic label the trace is insufficient to
assert that this is the authoritative total comment count.

All 42 nonempty extracted bodies were represented in the final batches. However,
agent-selected `.slice(0,600)` / `.slice(0,700)` shortened records 21 and 34 without
an explicit per-record truncation marker. The full retained bodies were 652 and
1,485 characters respectively, before newline normalization. Tool
`truncated:false` only means those already-sliced writes fit the output budget.
It does not mean every comment was read in full by the model.

The summary's substantive themes are supported by the emitted comments, including
the credential-handling anecdote, which was correctly framed as a claim. The
omitted tails do not demonstrate a contradictory final summary here. Still,
explicit length/cut metadata or selective retrieval of a long body's remainder
would make coverage more reliable for other tasks.

### Ordinal selection works within the observed list, with heuristic ad exclusion

Cell 6 contains one non-post community article followed by duplicate outer/inner
wrappers for feed posts. Counting unique post permalinks gives the selected post
as seventh. The agent ignored the community article and duplicate wrappers and
navigated to the exact observed permalink. That supports the selection within
this captured list rather than guessing from raw wrapper index.

Ad exclusion is weaker: the displayed projection includes `promoted:null`, but
omits the separately collected `isSponsored` field. No explicit eligibility or
stable-ID deduplication step is emitted. Null on one attribute is not universal
proof that an item is organic. No wrong ordinal is demonstrated. A general
improvement is one record per entity with identity, order and relevant eligibility
evidence, rather than having the model reconcile duplicated UI wrappers.

### What this says about Phase 7 and the workspace limit

Pointer hints are present in both full snapshots and the opening inline output.
No click, geometry or positioned-click method was called; navigation used `goto`.
The run therefore does not validate native-click/disclosure acceptance. Likewise,
successful admission shows this thread could open a workspace, but is not a
capacity-boundary or cleanup test for the interim ten-workspace limit.

## Recommended next steps

1. Keep selective record/body projection as the generic direction. Avoid larger
   default budgets or a site-specific extraction API based on these overflows.
2. Prefer compact structural evidence over full HTML when locating an entity's
   body; verify it belongs to that entity rather than a nested record.
3. Preserve explicit coverage when slicing text. Inspect omitted tails when they
   matter to the requested summary instead of implying complete body reads.
4. Complete an actual disclosure/click task separately for Phase 7, and keep
   workspace admission/cleanup acceptance in Phase 8. This successful read task
   does not close either gate.

## All browser calls

Cells 1–2 belong to the opening invocation; cells 3–14 to the main task.
All calls are `browser_exec`; code below is the exact persisted argument.

### Cell 1 — 1222 ms

Call ID: `call_cTWbnpsvdUPwqp3Gz3G5fGvN`.

```javascript
var tab = await browser.tabs.open('https://www.reddit.com/r/OpenAI/'); await tab.info()
```

Opened the community; info returned the URL while title was still empty.

### Cell 2 — 322 ms

Call ID: `call_TNvADH7OGtT5ov2gJRKfQrX7`.

```javascript
var snap = await tab.snapshot(); ({title:snap.nodes.find(n=>n.role==='heading')?.name || snap.nodes.find(n=>n.role==='main')?.name, url:await tab.url(), coverage:snap.coverage, limitations:snap.limitations, nodes:snap.nodes.slice(0,40)})
```

Snapshot plus first 40 nodes: 5,107 bytes, mostly page chrome; pointer hints retained.

### Cell 3 — 266 ms

Call ID: `call_Teafaa6wkI8sQJlC7pGVgeIi`.

```javascript
var snap2 = await tab.snapshot(); var posts = snap2.nodes.filter(n => n.role==='link' || n.role==='heading' || n.role==='article' || n.role==='button').map(n=>({depth:n.depth,role:n.role,name:n.name,text:n.text,url:n.url,ref:n.reference})); posts.slice(35,180)
```

Fresh snapshot; oversized projection produced a 37,929-byte artifact.

### Cell 4 — 33 ms

Call ID: `call_pqJWWKr04McijCPi4AnMU02N`.

```javascript
console.log(JSON.stringify(posts.filter(x=>x.url && (x.url.includes('/comments/') || x.url.includes('/r/OpenAI/'))).slice(0,80)))
```

Filtered retained links; output still overflowed at 20,478 bytes.

### Cell 5 — 46 ms

Call ID: `call_NVG8iB3cz6scgbwfHoUnvPAQ`.

```javascript
var feed = await tab.evaluate(() => [...document.querySelectorAll('shreddit-post, article')].map((el,i)=>({i,tag:el.tagName,attrs:{id:el.id,post:el.getAttribute('post-id'),permalink:el.getAttribute('permalink'),promoted:el.getAttribute('promoted'),isSponsored:el.getAttribute('is-sponsored')},text:(el.innerText||'').slice(0,500)})).slice(0,20)); console.log(JSON.stringify(feed))
```

Retained 20 article/post wrappers; 8,782-byte output overflowed.

### Cell 6 — 31 ms

Call ID: `call_z8rgif5z2F7ZGc7LuP03aRXM`.

```javascript
console.log(feed.map(x=>({i:x.i,tag:x.tag,permalink:x.attrs.permalink,post:x.attrs.post,promoted:x.attrs.promoted,text:x.text.replace(/\n+/g,' | ').slice(0,220)})))
```

Compact retained feed fit in 6,459 bytes; exposed duplicates and the seventh unique permalink.

### Cell 7 — 271 ms

Call ID: `call_MI3wKizldDTpnau0HOjJb06p`.

```javascript
await tab.goto('https://www.reddit.com/r/OpenAI/comments/1wktdag/thank_you_google/'); await tab.info()
```

Navigated to the selected observed post URL.

### Cell 8 — 39 ms

Call ID: `call_2FUCEV17NRYSLBNAXJke8tXx`.

```javascript
var thread = await tab.evaluate(() => ({posts:[...document.querySelectorAll('shreddit-post')].map(el=>({title:el.getAttribute('post-title'),author:el.getAttribute('author'),score:el.getAttribute('score'),text:(el.innerText||'').slice(0,1800)})),comments:[...document.querySelectorAll('shreddit-comment')].map((el,i)=>({i,author:el.getAttribute('author'),score:el.getAttribute('score'),depth:el.getAttribute('depth'),text:(el.innerText||'').slice(0,1000)})).slice(0,50)})); console.log(JSON.stringify(thread))
```

Retained post and 42 comment wrappers; 13,799-byte output overflowed.

### Cell 9 — 37 ms

Call ID: `call_IVRUQqra66O3GJLnsMMoNCYp`.

```javascript
console.log('POST',thread.posts); console.log('COMMENTS',thread.comments.map(c=>({i:c.i,author:c.author,score:c.score,depth:c.depth,text:c.text.replace(/\n+/g,' | ')})))
```

Post metadata printed; comments exceeded the budget; combined artifact 15,055 bytes.

### Cell 10 — 28 ms

Call ID: `call_bFK8Ihbg5fhneRRCZDLHASpB`.

```javascript
console.log('count',thread.comments.length); console.log(thread.comments.slice(0,12).map(c=>`${c.i} [${c.author}] ${c.score} d${c.depth}: ${c.text.replace(/\n+/g,' | ').slice(0,500)}`).join('\n'))
```

Printed count and first 12 parent-inclusive previews; exposed duplicated descendant replies.

### Cell 11 — 52 ms

Call ID: `call_ZIjaZZ40TJJvodzpmsH3sg15`.

```javascript
var structure = await tab.evaluate(() => {let el=document.querySelector('shreddit-comment'); return {html:el?.outerHTML.slice(0,5000),attrs:el? [...el.attributes].map(a=>[a.name,a.value]):[]}}); console.log(structure.attrs); console.log(structure.html)
```

Printed first comment attributes and up to 5,000 HTML characters; 5,925 output bytes.

### Cell 12 — 31 ms

Call ID: `call_afOqR8qVJIeb3NdXpGdfLFIW`.

```javascript
var bodyInfo = await tab.evaluate(() => {let el=[...document.querySelectorAll('shreddit-comment')][0]; return [...el.querySelectorAll('*')].filter(x=>(x.innerText||'').trim()==='Don’t spend all the tokens in one place 😂').map(x=>({tag:x.tagName,cls:x.className,html:x.outerHTML.slice(0,1200)})).slice(0,5)}); console.log(bodyInfo)
```

Found nested elements matching one observed body; 3,335 bytes of repeated HTML identified the body slot.

### Cell 13 — 43 ms

Call ID: `call_YbGqYsRLhMxA8pkNNuzFSkbZ`.

```javascript
var commentsClean = await tab.evaluate(() => [...document.querySelectorAll('shreddit-comment')].map((el,i)=>({i,author:el.getAttribute('author'),score:el.getAttribute('score'),depth:el.getAttribute('depth'),permalink:el.getAttribute('permalink'),text:el.querySelector('[slot="comment"]')?.innerText?.trim()||''})).filter(x=>x.text)); console.log('count',commentsClean.length); console.log(commentsClean.slice(0,25).map(c=>`${c.i} [${c.author}] ${c.score} d${c.depth}: ${c.text.replace(/\n+/g,' | ').slice(0,600)}`).join('\n'))
```

Extracted 42 nonempty body records; printed first 25 with 600-character caps.

### Cell 14 — 35 ms

Call ID: `call_oZby1yQiHqAIYEHTRb4EPGm0`.

```javascript
console.log(commentsClean.slice(25).map(c=>`${c.i} [${c.author}] ${c.score} d${c.depth}: ${c.text.replace(/\n+/g,' | ').slice(0,700)}`).join('\n'))
```

Printed remaining 17 retained body records with 700-character caps.

No runtime, prompt, browser-state or application-code changes were made during this review.
