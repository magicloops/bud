# Browser REPL review: 1af16148 — 16 KiB live experiment

Thread: `1af16148-c135-4192-b595-da191be7c9aa`.
September 24, 2026, 19:42–19:44 UTC; gpt-5.6-luna/high.
Baseline: [58834701, 8 KiB](browser-repl-588-review.md).
Budget change: [Phase 7b experiment update](../plan/bud-owned-browser/repl-phase-7b-output-compaction.md).

## Evidence and result

Reviewed 36 persisted messages, 18 provider calls, two invocations and all 16
browser cells with matching local observation traces. All trace daemon results
exactly equal persisted tool data. All formatted-output traces report
`text_limit:16384`, confirming the new runtime budget was active. No trace stages
were omitted; inspected operation values were not truncated. This verifies the
recorded daemon-to-transcript path, not exact provider HTTP payload reconstruction.
Queries were scoped to thread and its established owner. Private evidence copies:
`/tmp/bud-repl-1af-review.json` and `/tmp/bud-repl-1af-traces/` (0600 files).

The agent navigated to r/Anthropic, selected the Opus announcement (`1wnecjb`),
summarized the loaded discussion and drafted an unsent response. Fifteen cells
succeeded; one element click failed with `browser_stale_reference`. No screenshots,
JSON-endpoint fallback, artifact reads, explicit budget changes or runtime resets.

## Actual usage comparison

Main task only, excluding the opening turn:

| Metric | 588: 8 KiB | 1af: 16 KiB |
| --- | ---: | ---: |
| Recorded work | 37.601 s | 74.669 s |
| Browser cells | 6 | 15 |
| Provider calls | 7 | 16 |
| Tool wall-time total | 0.915 s | 3.558 s |
| Inline browser text | 32,453 bytes | 143,307 bytes |
| First provider input | 13,717 | 13,693 |
| Final provider input | 27,475 | 70,610 |
| Input growth | 13,758 | 56,917 |
| Cumulative provider input | 151,110 | 687,002 |
| Cached input, included above | 137,251 | 629,973 |
| Provider output, including reasoning | 1,881 | 4,004 |
| Reported page comment count | 4 | 212 |
| Nonempty extracted comment records | 4 | 96 |

Final provider input rose 157% (2.57×), and cumulative input rose 4.55×.
Cumulative input sums history repeatedly across model calls; it is not the
simultaneous context-window size. Cache hits do not remove that history from
context. Starting context was nearly identical. The opening turn used one cell,
two provider calls, 162 output bytes and 6.434 s work. Whole-thread usage was
713,878 input / 643,217 cached input / 4,115 output tokens.

This is not a matched budget experiment: the feed changed, the selected page was
different, and the discussion was much larger. It cannot establish that doubling
the budget alone caused the extra calls or all of the token growth.

## Where the extra content went

| Output group | Cells | Inline bytes |
| --- | --- | ---: |
| Broad snapshots | 2, 4, 7, 9, 16 | 74,052 |
| Comment structure probes | 10, 11, 12 | 30,116 |
| Comment body extraction and tail recovery | 13, 14 | 17,394 |
| Feed DOM/geometry extraction | 3, 5, 6 | 21,674 |
| Failed click and scroll counters | 8, 15 | 71 + 11 |

Snapshot prefixes plus structure probes account for approximately 73% of browser
text. Some discovery was useful, but this is not 143 KB of unique comment evidence.

The five snapshots showed 276/327, 280/335, 214/214, 141/1426 and 213/1519 nodes.
The first two emitted roughly 16 KB each, including repeated navigation and
sidebar content. The first post snapshot was fully printed but captured no comment
article roles yet. The next capture retained 100 comment article roles, but its
12,000-byte requested view ended before them. The agent used three DOM probes
instead of selecting those retained nodes. The first probe also printed STYLE
content and nested comment-related wrappers; later probes printed child structures
and repeated descendant text.

After extracting comment bodies and scrolling, the final snapshot still printed
the document prefix, reaching only the first comment header. A document snapshot
is not a viewport snapshot: scrolling did not make the printed prefix a useful
sample of the lower discussion. No retained-node selection was used. Larger output
allowances let these broad emissions accumulate without ensuring better selection.

The final feed query returned 27 post records, despite needing the seventh. Its
first seven permalinks were distinct and the chosen announcement was seventh in
that sequence. The earlier run's duplicate-permalink ambiguity was not present
among these seven. However, choosing article records with community comment links
is not a general proof that every advertisement was excluded or every record was
visually eligible. Do not infer a universal classifier from this result.

## Reliability and coverage findings

### Scrolls succeeded; one element click was stale

Both page scroll operations succeeded, including the second after intervening
DOM evaluation. The second measured scrollY changing from 0 to 6000. That is useful
live evidence for the page-scroll path, but does not cover every Phase 7c
invalidation fixture.

The one click targeted the actually observed `e103`, the “212 Go to comments”
button. It failed stale in 36 ms, before its subsequent sleep/snapshot statements.
The refresh returned the same document ID with a much larger tree (214 → 1426
nodes) and 100 comment article roles. That supports dynamic page loading as
context, but does not identify the exact invalidation trigger; do not claim TTL,
child-frame navigation or successful click without further evidence. The agent
refreshed and continued reading rather than blindly replaying the click.

### Overflow recovery left one partial body

Cell 13 retained 96 nonempty records from 100 loaded `shreddit-comment` elements.
The complete formatted output was 17,671 bytes; the 16,384-byte collector excerpt
cut array position 89 (original DOM index 93, Effective_Olive6153) mid-body. Cell 14
printed `allComments.slice(90)`, covering the last six records but not the missing
remainder of position 89. The omitted text concerned restrictions/distillation;
its full body was retained locally. Recovery should overlap the last incomplete
record or use explicit record boundaries rather than infer a start from counts.
This is an agent selection gap, not lost source data or an execution failure.

The initial direct-child probes also contained nested descendants. The final
query used `el.querySelector('[slot="comment"]')`, which is not ownership-bounded
against nested comments. This trace does not prove a resulting misattribution,
but generic record extraction should verify body ownership when nesting exists.
Do not treat 96 nonempty records as proof of 96 fully emitted, independently
verified bodies. The comment-element count stayed 100 after scrolling; no new
loaded comments were established. The page reported 212.

The final answer correctly qualified its summary as loaded comments and did not
claim all 212 were read. Its major usability/verbosity, speed, reset-policy and
future-release themes are supported by the emitted discussion; these are page
claims, not independent validation of model capabilities. The draft was not posted.

## Conclusion and next comparison

16 KiB did not demonstrate a context or call-count advantage here. It was active,
and the broader repeated outputs clearly consumed more context, but changed page
content and agent behavior prevent a causal 8-versus-16 conclusion. Keep the
current configuration unchanged during this review; no revert was requested.

For a useful next comparison, use the same fixed post URL, task scope and starting
history, ideally a frozen fixture and repeated runs. Measure retained evidence,
actual emissions, coverage and provider input together. Generic improvements worth
considering are scoped retained-node output, avoiding duplicate structural probes,
and record-aware overflow recovery. Raising the default alone does not solve these.

No runtime code, prompt, service/daemon state or budget was changed in this review.

## All browser cells

Cell 1 opens the community; 2–16 perform the main task. Durations are service wall
clock; byte counts are inline text only, excluding code and result envelopes.

### Cell 1

Request `01M3AF2FCEHY6G3TM7V2GY7JK2`; 1551 ms; 162 bytes; completed.

```javascript
var tab = await browser.tabs.open('https://www.reddit.com/r/Anthropic/'); await tab.info();
```

### Cell 2

Request `01M3AF332CJH4QR6CA18S4TR8Y`; 130 ms; 16,300 bytes; completed.

```javascript
var snap = await tab.snapshot(); console.log(snap.format({maxBytes:24000}));
```

### Cell 3

Request `01M3AF368G17N0Q63PYMQQG7EH`; 33 ms; 3,782 bytes; completed.

```javascript
var posts = await tab.evaluate(() => Array.from(document.querySelectorAll('article')).map((a,i)=>({i, text:(a.innerText||'').slice(0,500), links:Array.from(a.querySelectorAll('a')).map(x=>({text:(x.innerText||'').trim().slice(0,160),href:x.href})).filter(x=>x.text||x.href)}))); console.log(posts);
```

### Cell 4

Request `01M3AF39TX6AFHY6ZBH8J2HG5B`; 634 ms; 16,375 bytes; completed.

```javascript
await tab.scroll(1250); await new Promise(r=>setTimeout(r,500)); var snap2=await tab.snapshot(); console.log(snap2.format({maxBytes:24000}));
```

### Cell 5

Request `01M3AF3E1YDTJN62AQT62YKV5X`; 43 ms; 6,567 bytes; completed.

```javascript
console.log(await tab.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight,ih:innerHeight,body:document.body.scrollHeight,articles:Array.from(document.querySelectorAll('article')).map(a=>({text:(a.innerText||'').trim().slice(0,100),top:a.getBoundingClientRect().top,bottom:a.getBoundingClientRect().bottom}))})));
```

### Cell 6

Request `01M3AF3HW6MD4MQ905X2FT0CGA`; 49 ms; 11,314 bytes; completed.

```javascript
var feed = await tab.evaluate(() => Array.from(document.querySelectorAll('article')).flatMap((a,idx)=>{let x=Array.from(a.querySelectorAll('a[href*="/r/Anthropic/comments/"]')); let u=x[0]?.href; if(!u)return []; return [{idx,href:u,title:(x.find(z=>z.innerText.trim())?.innerText||'').trim(),text:(a.innerText||'').replace(/\s+/g,' ').trim().slice(0,260)}]})); console.log(feed);
```

### Cell 7

Request `01M3AF3MM5NKY8XF98DW8ZXBYX`; 1013 ms; 13,060 bytes; completed.

```javascript
await tab.goto(feed[6].href); await new Promise(r=>setTimeout(r,700)); var threadSnap=await tab.snapshot(); console.log(threadSnap.format({maxBytes:30000}));
```

### Cell 8

Request `01M3AF3RSND32NPWZZJ1JVFSWE`; 36 ms; 11 bytes; failed: browser_stale_reference.

```javascript
await threadSnap.getByReference('e103').click(); await new Promise(r=>setTimeout(r,700)); var commentsSnap=await tab.snapshot(); console.log(commentsSnap.format({maxBytes:32768}));
```

### Cell 9

Request `01M3AF3V95QA1GNXCWZYFKQP55`; 266 ms; 11,993 bytes; completed.

```javascript
var freshThread=await tab.snapshot(); console.log(freshThread.format({maxBytes:12000}));
```

### Cell 10

Request `01M3AF3ZG53GA8G7D28HBRSMXR`; 60 ms; 15,736 bytes; completed.

```javascript
var commentEls = await tab.evaluate(() => Array.from(document.querySelectorAll('*')).filter(el=>/comment/i.test(el.tagName) || /comment/i.test(el.getAttribute('data-testid')||'')).slice(0,80).map((el,i)=>({i,tag:el.tagName,testid:el.getAttribute('data-testid'),text:(el.innerText||'').replace(/\s+/g,' ').trim().slice(0,500)}))); console.log(commentEls);
```

### Cell 11

Request `01M3AF43M8FJG37D5CZKJG1MB2`; 54 ms; 10,362 bytes; completed.

```javascript
var commentData = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-comment')).slice(0,25).map((el,i)=>({i,attrs:{author:el.getAttribute('author'),score:el.getAttribute('score'),depth:el.getAttribute('depth'),thing:el.getAttribute('thingid')},direct:Array.from(el.children).map(c=>({tag:c.tagName,slot:c.getAttribute('slot'),text:(c.innerText||'').replace(/\s+/g,' ').trim().slice(0,600)})).filter(x=>x.text||x.slot)}))); console.log(commentData);
```

### Cell 12

Request `01M3AF473S7J1RRMVY3YTB34ES`; 35 ms; 4,018 bytes; completed.

```javascript
var one = await tab.evaluate(() => {let el=document.querySelector('shreddit-comment'); return Array.from(el.querySelectorAll('[slot],p,[data-testid]')).slice(0,30).map(x=>({tag:x.tagName,slot:x.getAttribute('slot'),test:x.getAttribute('data-testid'),text:(x.innerText||'').replace(/\s+/g,' ').trim().slice(0,300)}))}); console.log(one);
```

### Cell 13

Request `01M3AF4DN97FCTSRDNH66KJE7J`; 41 ms; 16,384 bytes; completed.

```javascript
var allComments = await tab.evaluate(() => Array.from(document.querySelectorAll('shreddit-comment')).map((el,i)=>({i,author:el.getAttribute('author'),score:el.getAttribute('score'),depth:el.getAttribute('depth'),text:(el.querySelector('[slot="comment"]')?.innerText||'').replace(/\s+/g,' ').trim()})).filter(x=>x.text)); console.log({count:allComments.length,comments:allComments.slice(0,120)});
```

### Cell 14

Request `01M3AF4H6CRH456CEJ85RQF24X`; 28 ms; 1,010 bytes; completed.

```javascript
console.log(allComments.slice(90));
```

### Cell 15

Request `01M3AF4N78Z6F1J2JWF8HW02QJ`; 864 ms; 71 bytes; completed.

```javascript
console.log(await tab.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight,comments:document.querySelectorAll('shreddit-comment').length}))); await tab.scroll(6000); await new Promise(r=>setTimeout(r,800)); console.log(await tab.evaluate(()=>({y:scrollY,h:document.documentElement.scrollHeight,comments:document.querySelectorAll('shreddit-comment').length})));
```

### Cell 16

Request `01M3AF4S3ZYVHS803NHYPDFWJT`; 272 ms; 16,324 bytes; completed.

```javascript
var lower=await tab.snapshot(); console.log(lower.format({maxBytes:24000}));
```
