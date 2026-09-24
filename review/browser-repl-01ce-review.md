# Browser REPL review: 01ce2c56

Thread: `01ce2c56-c966-463b-808f-e8f87480b1b6`.
Run: September 24, 2026, 07:58–08:04 UTC.
Related: [previous 07a review](browser-repl-07a-review.md),
[Phase 7](../plan/bud-owned-browser/repl-phase-7-actionability.md).

## Outcome and evidence

The agent opened r/OpenAI, selected the seventh loaded post, “OpenAI rolls out
upgraded prompt caching and reduced cached input rates for GPT-6” (`1woal22`),
read 19 comment bodies, summarized them and drafted an unsent reply. All 19
browser cells completed successfully across two invocations and one persistent
REPL generation. There were seven output overflows, not execution failures.

Reviewed all cell arguments and saved results, provider usage, and all 19 matching
local traces. Each trace's daemon result matches the persisted tool data exactly;
no diagnostic stages were omitted and no recorded trace values were truncated.
This checks daemon-to-transcript fidelity, not the final provider HTTP payload.
Owner-scoped database evidence and trace copies remain private in
`/tmp/bud-repl-01ce-review.json` and `/tmp/bud-repl-01ce-traces/`.

No screenshots, clicks, JSON endpoint requests, private-control resets or
workspace-limit errors occurred. There was one successful scroll and explicit
navigation to an observed permalink. This does not exercise Phase 7 click
acceptance or Phase 8 workspace cleanup/capacity acceptance.

## Comparison

Both runs used gpt-5.6-luna/high. Compare main tasks, excluding their opening turns:

| Metric | Previous 07a | This run |
| --- | ---: | ---: |
| Recorded work time | 54.787 s | 69.386 s |
| Browser cells | 12 | 15 |
| Provider calls | 13 | 16 |
| Tool duration total | 0.912 s | 3.540 s |
| Inline browser text bytes | 25,332 | 31,593 |
| Output overflows | 5 | 7 |
| First → final provider input tokens | 15,973 → 29,365 | 15,699 → 32,748 |
| Input growth | 13,392 | 17,049 |
| Cumulative provider input | 281,998 | 364,536 |
| Cached input, included above | 268,485 | 347,375 |
| Provider output tokens | 2,738 | 3,388 |
| Comment bodies ultimately emitted | 42 | 19 |

This run used about 27% more time, 25% more inline text, and 29% more cumulative
input. Different posts and loading states prevent treating this as a controlled
benchmark. Cumulative input includes repeated history; final input is the
context size at the last model call. Output totals include provider reasoning
usage, not just the final answer.

The opening invocation separately took 12.892 seconds, four browser cells, five
provider calls and 3,168 inline bytes. It listed/current-checked an empty workspace,
created a tab, slept 1.5 seconds before observing, then explicitly selected it.
The main invocation adds two fixed sleeps totaling 2.6 seconds. Those sleeps
account for most of its recorded tool duration, but not most of its overall time.

## Findings

### 1. Artifact recovery repeated the same overflow

Cell 5 emitted a 27,647-byte snapshot projection and received an overflow artifact.
Cell 6 read that whole artifact and printed it unchanged, producing another
27,648-byte overflow. The artifact mechanism worked; the chosen recovery made no
progress. The original structured `relevant` value was still retained.

This is the clearest generic improvement: after overflow, select smaller fields
or records from retained data, or read a bounded artifact excerpt. Reprinting the
whole artifact cannot solve the same output limit. Increasing the budget would
only hide this instance of the pattern.

### 2. A loading gap was handled, but ad exclusion was not verified

Both feed snapshots contained 228 nodes and reported `truncated:false`. The
subsequent DOM query found only three post entities, plus duplicate outer wrappers
and non-post community articles. After one 800-pixel scroll and a 1.2-second wait,
the DOM contained 27 posts with 27 unique IDs. Thus the initial short list was
not evidence that the snapshot output budget discarded the seventh item; the DOM
query independently found too few items. The trace establishes the before/after
loading change, but does not isolate scrolling from waiting as its cause.

The agent then selected `postSummary[6]` and navigated to its observed permalink.
The seventh loaded entity and final title agree. However, unlike the previous run,
no promoted/sponsored attributes or explicit ad eligibility were queried. Matching
`shreddit-post` alone does not prove every entry is organic. The final claim
“7th non-ad post” is stronger than the recorded exclusion evidence. There is no
established wrong selection; the missing verification should be addressed generically
by preserving entity identity, order and relevant eligibility evidence.

### 3. Repeated large projections dominate the extra work

Seven cells overflowed: 5, 6, 8, 9, 12, 13 and 15. Artifact sizes were respectively
27,647; 27,648; 14,668; 12,947; 10,743; 10,669; and 10,315 bytes.

After the feed grew, cell 8 printed all 27 records; cell 9 queried the DOM again
with a smaller projection but still printed too much. Cell 10 finally selected
first/last subsets from retained data. It could have projected the retained
`more` records before issuing another page query.

Comment extraction repeated the previous run's parent-`innerText` issue: enclosing
comments include replies, so their text is duplicated and attribution becomes
ambiguous. Cells 12–14 narrowed these parent-inclusive records until they fit,
but shrinking previews did not fix the entity boundary. Cell 15 then overflowed
while printing five HTML fragments.

Cells 16–17 collected page links (4,087 bytes), mostly navigation/footer links and
repeated source links. They found the source URL but did not open or verify it;
this was a detour from summarizing the discussion. Cell 18 emitted 7,621 bytes of
structural previews, including repeated body text and CSS classes, to identify the
body slot. Those three calls alone consumed 11,708 bytes, about 37% of main-task
inline text. A compact entity-local description of tag, slot and ancestry would
have been more useful than broad link and styling dumps.

### 4. The final body extraction is better than the intermediate previews

Cell 19 emitted all 19 nonempty bodies with author, score, depth and metadata in
5,350 bytes. It did not slice the bodies; the longest normalized body was 536
characters. This improves on the previous run's silent per-body cuts. Earlier
220-character previews were incomplete, but the final read superseded them.

As before, `e.querySelector('[slot="comment"]')` searches any descendant, not
necessarily a body owned by that specific comment. No incorrect attribution is
established here; a missing parent body could still accidentally select a reply's
body. This is a generic nested-entity concern, not a reason for a comments API.

The final summary explicitly limits itself to “19 visible comments.” The stronger
technical description is 19 loaded DOM bodies: the query did not test viewport
visibility. No load-more/expansion or full discussion coverage was established.
The post text includes a trailing `82` without a semantic label; it is insufficient
to assert a verified total count.

The substantive summary is supported by the final emitted bodies, and the startup
savings claim is attributed to a commenter. The linked source itself was not
verified. The draft's caching conclusions should be understood as its requested
skeptical perspective, not a validated technical explanation of provider caching.

## Recommended next steps

1. Improve generic overflow recovery: project retained data first; never re-emit
   a whole oversized artifact into the same limit.
2. Discover entity-owned body boundaries with compact structural evidence, then
   emit complete relevant bodies or explicit per-body omissions.
3. Separate loaded coverage from complete/visible coverage and verify the filter
   used for an ordinal request rather than treating a CSS selector as proof.
4. Keep the current budget for now. The final relevant evidence fit comfortably;
   the larger cost came from discovery, repeated wrappers and retries.

No runtime or prompt changes were made during this review.

## All browser calls

Cells 1–4 belong to the opening invocation; 5–19 to the main task. Every call is
`browser_exec`. Exact persisted code follows; byte counts include the returned
inline text, including overflow notices, but exclude envelopes and code.

### Cell 1 — 291 ms

Call: `call_1G5revhQNuvDcbdrP11NcWCU`. Inline text: 8 bytes.

```javascript
var tabs = await browser.tabs.list(); console.log(tabs); var cur = await browser.tabs.current(); console.log(cur ? {id:cur.id,title:cur.title,url:cur.url} : null);
```

Workspace inventory empty; runtime created.

### Cell 2 — 209 ms

Call: `call_jUnyXBEpZavdQr9M2QLsE1PX`. Inline text: 159 bytes.

```javascript
var tab = await browser.tabs.create('https://www.reddit.com/r/OpenAI/'); await tab.info();
```

Created the community tab.

### Cell 3 — 1646 ms

Call: `call_vpOG1iYQdKmvuct1RwVpmjSx`. Inline text: 2,940 bytes.

```javascript
await new Promise(r=>setTimeout(r,1500)); var s=await tab.snapshot(); console.log({title:(await tab.title()),url:(await tab.url()),coverage:s.coverage,limitations:s.limitations,nodes:s.nodes.slice(0,25)});
```

Waited 1.5 seconds and printed 25 mostly header nodes.

### Cell 4 — 52 ms

Call: `call_Uu6fgn1goqMq6Wv8gVhkV239`. Inline text: 61 bytes.

```javascript
await tab.select(); console.log({title:await tab.title(),url:await tab.url()});
```

Selected the tab and confirmed title/URL.

### Cell 5 — 130 ms

Call: `call_i1JKORToR2Bd1U0XwKmsBud3`. Inline text: 106 bytes.

```javascript
var snap = await tab.snapshot(); var relevant = snap.nodes.filter(n => n.text || n.name || n.url).map(n => ({d:n.depth,role:n.role,name:n.name,text:n.text,url:n.url,ref:n.reference})); console.log(relevant.slice(-180));
```

Oversized snapshot projection.

### Cell 6 — 25 ms

Call: `call_zQ7DesJMaaK61FnBLkdtjwqo`. Inline text: 106 bytes.

```javascript
var raw = await repl.files.read('c19c8f4f-5ced-45b4-af3b-fcb1ee071b6d.txt'); console.log(raw);
```

Reprinted entire overflow artifact; overflowed again.

### Cell 7 — 44 ms

Call: `call_2JWQgLHcWT9YnugyBS9sUDOO`. Inline text: 3,916 bytes.

```javascript
var posts = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-post, article, [data-testid="post-container"]')).map((e,i)=>({i,tag:e.tagName,attrs:{id:e.id,post:e.getAttribute('data-post-id'),permalink:e.getAttribute('permalink')},text:(e.innerText||'').trim().slice(0,800)})).filter(x=>x.text)); console.log(posts.slice(0,20));
```

Found three unique posts plus duplicate/community wrappers.

### Cell 8 — 1273 ms

Call: `call_wTRUMk8U4RlEErfjsu4eCtEY`. Inline text: 106 bytes.

```javascript
await tab.scroll(800); await new Promise(r=>setTimeout(r,1200)); var more = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-post')).map((e,i)=>({i,id:e.id,permalink:e.getAttribute('permalink'),text:(e.innerText||'').trim().slice(0,500)}))); console.log(more);
```

Scrolled; 27 unique post IDs loaded; full projection overflowed.

### Cell 9 — 58 ms

Call: `call_dyvqBxMX8Nx7FSsIfC7BmtRB`. Inline text: 106 bytes.

```javascript
var postSummary = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-post')).map((e,i)=>({i,id:e.id,permalink:e.getAttribute('permalink'),text:(e.innerText||'').split('\n').map(s=>s.trim()).filter(Boolean).slice(0,8)}))); console.log(postSummary);
```

Requeried all posts with smaller fields; still overflowed.

### Cell 10 — 41 ms

Call: `call_tcs7lSHcTvA8nCMnrjl4Evza`. Inline text: 4,550 bytes.

```javascript
console.log({count:postSummary.length, first:postSummary.slice(0,10).map(x=>({i:x.i,id:x.id,permalink:x.permalink,text:x.text.slice(0,5)})), last:postSummary.slice(-5).map(x=>({i:x.i,id:x.id,permalink:x.permalink,text:x.text.slice(0,5)}))});
```

Retained subset fit; seventh record identified.

### Cell 11 — 1605 ms

Call: `call_DCKfhEdAn87PfeJybqbPAYBi`. Inline text: 213 bytes.

```javascript
var targetUrl = 'https://www.reddit.com' + postSummary[6].permalink; await tab.goto(targetUrl); await new Promise(r=>setTimeout(r,1400)); console.log({title:await tab.title(),url:await tab.url()});
```

Navigated to seventh observed permalink and waited 1.4 seconds.

### Cell 12 — 67 ms

Call: `call_4GIsHKE1PowTLl1NzH7xqEy4`. Inline text: 106 bytes.

```javascript
var threadData = await tab.evaluate(() => ({post: (()=>{const e=document.querySelector('shreddit-post'); return e?{title:e.getAttribute('post-title')||'',author:e.getAttribute('author'),score:e.getAttribute('score'),text:(e.innerText||'').trim(),permalink:e.getAttribute('permalink')}:null})(), comments:Array.from(document.querySelectorAll('shreddit-comment')).map((e,i)=>({i,author:e.getAttribute('author'),score:e.getAttribute('score'),depth:e.getAttribute('depth'),text:(e.innerText||'').trim()})).filter(x=>x.text)})); console.log({post:threadData.post,commentCount:threadData.comments.length,comments:threadData.comments.slice(0,30)});
```

Post and parent-inclusive comment text overflowed.

### Cell 13 — 34 ms

Call: `call_nFXBhAP6QnWh5HSPINxMpFZs`. Inline text: 106 bytes.

```javascript
console.log({post:{title:threadData.post?.title,author:threadData.post?.author,score:threadData.post?.score,permalink:threadData.post?.permalink,text:threadData.post?.text?.slice(0,1600)},commentCount:threadData.comments.length,comments:threadData.comments.map((c,i)=>({i,author:c.author,score:c.score,depth:c.depth,text:c.text.slice(0,600)}))});
```

Retained previews still overflowed.

### Cell 14 — 49 ms

Call: `call_NYtpcY1EbbmNize5J29anE0r`. Inline text: 5,114 bytes.

```javascript
console.log(JSON.stringify({post:{title:threadData.post?.title,author:threadData.post?.author,score:threadData.post?.score,text:threadData.post?.text?.slice(0,1000)},commentCount:threadData.comments.length,comments:threadData.comments.map((c,i)=>({i,author:c.author,score:c.score,depth:c.depth,text:c.text.replace(/\s+/g,' ').slice(0,220)}))}));
```

Compact previews fit but include descendants and cut bodies.

### Cell 15 — 40 ms

Call: `call_Gr9may3XFDFRWpcCE5hGWBeG`. Inline text: 106 bytes.

```javascript
var commentDom = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-comment')).slice(0,5).map((e,i)=>({i,html:e.innerHTML.slice(0,1800)}))); console.log(commentDom);
```

Five comment HTML fragments overflowed.

### Cell 16 — 49 ms

Call: `call_QZXrtUt3AiLK23gB986EKoqj`. Inline text: 2,845 bytes.

```javascript
var links = await tab.evaluate(() => Array.from(document.querySelectorAll('a')).map(a=>({text:(a.innerText||'').trim(),href:a.href})).filter(x=>x.text||x.href).slice(-30)); console.log(links);
```

Broad page-link dump, mostly footer/navigation.

### Cell 17 — 45 ms

Call: `call_phItglqwGSEndo9v0YRkkZyJ`. Inline text: 1,242 bytes.

```javascript
console.log(await tab.evaluate(() => Array.from(document.querySelectorAll('a')).map(a=>({text:(a.innerText||'').trim().replace(/\s+/g,' '),href:a.href})).filter(x=>x.href.includes('openai.com') && !x.href.includes('reddit'))));
```

Found repeated source URL among other site links; did not navigate.

### Cell 18 — 34 ms

Call: `call_O2lxjMEcQNOdE1dVB6QFy77F`. Inline text: 7,621 bytes.

```javascript
var selInfo = await tab.evaluate(() => {const sels=['p','div[slot]','div[id*="comment"]','span']; return Object.fromEntries(sels.map(sel=>[sel,Array.from(document.querySelectorAll('shreddit-comment '+sel)).slice(0,12).map(e=>({text:(e.innerText||'').trim().replace(/\s+/g,' ').slice(0,260),cls:e.className,slot:e.getAttribute('slot')}))]));}); console.log(selInfo);
```

Structural projections exposed the body slot with considerable duplication.

### Cell 19 — 46 ms

Call: `call_RPZMYYw3quBurPNw2uuevvvM`. Inline text: 5,350 bytes.

```javascript
var directComments = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-comment')).map((e,i)=>{const body=e.querySelector('[slot="comment"]'); const meta=e.querySelector('[slot="commentMeta"]'); return {i,author:e.getAttribute('author'),score:e.getAttribute('score'),depth:e.getAttribute('depth'),meta:meta?.innerText?.trim().replace(/\s+/g,' '),body:body?.innerText?.trim().replace(/\s+/g,' ')};})); console.log(JSON.stringify(directComments));
```

All 19 normalized bodies fit without agent-side character slicing.
