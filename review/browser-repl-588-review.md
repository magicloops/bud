# Browser REPL review: 58834701

Thread: `58834701-ef35-488a-83e7-16fcc58b0670`.
Run: September 24, 2026, 19:21–19:31 UTC. Model: gpt-5.6-luna/high.
Related: [ed1 baseline](browser-repl-ed1-review.md), [Phase 7c](../plan/bud-owned-browser/repl-phase-7c-observation-use.md), [Phase 7d](../plan/bud-owned-browser/repl-phase-7d-startup-helper-upgrade.md).

## Outcome and evidence

Reviewed all seven browser cells, their persisted results, nine provider usage
records, two invocations and seven matching local traces. All seven cells succeeded.
Every trace daemon result exactly matches persisted tool data; no trace stages
were omitted and no trace values were truncated. This verifies daemon-to-transcript
fidelity, not the exact final provider HTTP payload. Database reads were scoped to
the thread and established owner. Private exports: `/tmp/bud-repl-588-review.json`
and `/tmp/bud-repl-588-traces/` (0600 files).

The agent opened r/Anthropic, selected “Never Gonna Give You Up” (`1woxxse`), read
four comments and drafted an unsent skeptical reply. The summary accurately
reflects the four returned comments and the post text. There were no element
clicks, scrolls, screenshots, JSON endpoint fallbacks, artifact reads or explicit
budget increases. One REPL generation persisted across the nine-minute gap between
user turns. There was one collector overflow and two marked snapshot previews.

## Comparison

Main task only; opening turns excluded. The user requested the same seventh-post,
comment-summary and skeptical-draft task, but on a different community/page.
This is not a controlled benchmark or proof of a code-change effect.

| Metric | Earlier ed1 | This run |
| --- | ---: | ---: |
| Recorded work time | 49.232 s | 37.601 s |
| Browser cells | 8 | 6 |
| Provider calls | 9 | 7 |
| Tool duration total | 3.629 s | 0.915 s |
| Inline browser text bytes | 36,439 | 32,453 |
| Collector overflows | 1 | 1 |
| First → final provider input | 17,028 → 33,202 | 13,717 → 27,475 |
| Input growth | 16,174 | 13,758 |
| Cumulative provider input | 229,720 | 151,110 |
| Cached input (included above) | 213,444 | 137,251 |
| Provider output tokens | 2,333 | 1,881 |
| Loaded comment records | 20 | 4 |

Work time fell 24%, cumulative input 34%, final input 17%, input growth 15%, and
inline bytes 11%. The lower starting context and much smaller discussion explain
part of the difference. There were no explicit sleeps or failed recovery cells.
Cumulative input counts history again on each provider call; it is not simultaneous
context size. Cached input is a subset, and output includes reasoning tokens.

Opening used one cell, two provider calls, 196 inline bytes and 6.859 s recorded
work. Whole-thread totals: 177,994 input tokens, 150,495 cached input tokens,
2,011 output tokens, 32,649 inline browser bytes. Provider input by main-task
step: 13,717; 16,402; 19,808; 23,226; 23,697; 26,785; 27,475.

## Findings

### 1. Ordinal selection remains ambiguous, not a demonstrated formatter bug

The first broad DOM extraction included a community card before the post records.
The follow-up scoped query removed that card, but returned the same post URL at
zero-based indices 1 and 3 (“Look at that”, `1woixv5`). The upstream snapshot also
contains two separate article nodes, refs `e492` and `e698`, with that URL. Thus the
duplication predates Bud's compact representation; it was not introduced by aliasing.

The selected post is index 6: seventh feed occurrence, sixth unique permalink.
If deduplicated by permalink, the seventh is the next record, the Opus announcement.
The traces do not contain the visibility/geometry evidence needed to distinguish
intentional repeated cards from hidden/cloned markup. We cannot label the selection
wrong solely because URLs repeat, or silently redefine the request as unique posts.
There was also a separate community-highlights list, excluded from the feed query.

The agent noticed duplication but did not verify it before claiming “7th non-ad
post.” Its ad check was a text regex; every returned record was false. This does
not prove universal ad exclusion or visible order. A generic follow-up should
resolve record identity, eligibility and rendered ordering when duplicates affect
an ordinal, using a focused inspection or screenshot if needed. Do not globally
strip duplicate links or add a site-specific ad filter.

### 2. Broad output still dominates context

The main task emitted 32,453 bytes. The two feed evaluations alone emitted 16,263
bytes (50%): the first requested text plus up to six links for fifteen articles,
including duplicate titles, author links and flair links. Its complete formatted
output was 15,108 bytes; the collector returned an explicitly incomplete 8,192-byte
excerpt and retained an artifact. The agent recovered with a smaller projection,
not a whole-artifact reprint. That projection still emitted twenty records and
repeated much of the first extraction, totaling 8,071 bytes.

Both snapshot cells requested `maxBytes:20000` without raising the shared cell
budget. The feed view showed 150/1469 retained nodes (7,658 bytes); the post view
showed 126/205 (7,638 bytes). Both explicitly marked PREVIEW, with
`source_truncated:false`. The latter describes retained source coverage, not
completeness of emitted text. The post preview ended inside an advertisement before
the comments; the four comment articles were already present in the retained full
snapshot. A scoped retained-node view could have supplied them without another
page query. No retained-node selection was attempted.

The budget held and recovery was productive. The remaining opportunity is bounded
projection and reuse of retained evidence, not increasing the default budget or
removing ad URLs. Keep 8 KiB pending a controlled comparison of these strategies.

### 3. Comment extraction succeeded, but did not validate general semantic reuse

A direct `shreddit-comment` query returned four short records with author/depth/text,
657 bytes total. None reached the agent's 1,000-character per-record slice. The
upstream snapshot independently contains the same four named comment articles;
the page's displayed count is four. The final summary covers each accurately.
The requested draft was not posted. No screenshot or video inspection occurred,
so the draft's opinion about a polished video is not evidence of visual inspection.

Unlike ed1, there were no empty literal-article probes or body-text fallback.
However, the agent used a site-specific custom-element selector without a preceding
DOM-tag discovery call; this does not establish that the generic role-versus-tag
guidance or retained-snapshot reuse was followed. A successful local selector is
not justification for adding a dedicated comment-extraction API.

## Acceptance and next steps

This is a successful text-read and draft run with lower measured cost, subject to
the unresolved ordinal interpretation. It does not exercise the Phase 7c scroll
fix, actionability/click safeguards, private takeover, media recovery or workspace
cleanup. Successful startup alone does not prove Phase 7d upgraded a stale helper:
these transcripts contain no startup upgrade/version evidence. Keep those checks
open rather than attributing all improvements to the latest implementation.

The highest-value follow-up is generic record identity/visible-order verification
when an ordinal is ambiguous. Continue evaluating focused output and retained
snapshot reuse; repeated broad emissions remain measurable. No runtime changes,
restarts, browser actions or posting were performed during this review.

## All browser calls

Cell 1 is the opening turn; cells 2–7 are the main task. Sizes count inline text
only, excluding arguments/envelopes. Durations are service-recorded tool wall time.

### Cell 1

Request: `01M3ADTM92124PNJXQD2THEYE0`. Duration: 2347 ms. Inline text: 196 bytes.

```javascript
var tab = await browser.tabs.open('https://www.reddit.com/r/Anthropic/'); await tab.info();
```

Open community and return page info.

### Cell 2

Request: `01M3AEBX9EB91Y4H9YW4WXNEZB`. Duration: 339 ms. Inline text: 7,658 bytes.

```javascript
var snap = await tab.snapshot(); console.log(snap.format({maxBytes:20000}));
```

Feed snapshot preview: 150/1469 nodes.

### Cell 3

Request: `01M3AEC1QGTFV70SN58F2T61W9`. Duration: 55 ms. Inline text: 8,192 bytes.

```javascript
var posts = await tab.evaluate(() => [...document.querySelectorAll('article')].slice(0,15).map((a,i)=>({i:i+1, text:(a.innerText||'').replace(/\s+/g,' ').slice(0,500), links:[...a.querySelectorAll('a')].map(x=>({text:(x.innerText||'').trim(),href:x.href})).filter(x=>x.text||x.href).slice(0,6)}))); console.log(JSON.stringify(posts,null,2));
```

Broad article extraction; 15,108-byte full output, 8,192-byte incomplete excerpt.

### Cell 4

Request: `01M3AEC8Y8K57NRJ1278ZBDRZ7`. Duration: 37 ms. Inline text: 8,071 bytes.

```javascript
var feed = await tab.evaluate(() => [...document.querySelectorAll('main article')].map((a,i)=>{let ls=[...a.querySelectorAll('a[href*="/comments/"]')]; let href=ls[0]?.href||null; let title=ls.find(x=>x.innerText.trim())?.innerText.trim()||''; let txt=(a.innerText||'').replace(/\s+/g,' '); return {i,href,title:title.slice(0,120),promoted:/promoted|sponsored|advertisement|\bad\b/i.test(txt),excerpt:txt.slice(0,240)}}).filter(x=>x.href||x.excerpt)); console.log(JSON.stringify(feed.slice(0,20),null,2));
```

Scoped main/article extraction; twenty records, including duplicate permalink at indices 1 and 3.

### Cell 5

Request: `01M3AECDE6Q9S0Y5RQ6WDB6KGH`. Duration: 315 ms. Inline text: 237 bytes.

```javascript
await tab.goto('https://www.reddit.com/r/Anthropic/comments/1woxxse/never_gonna_give_you_up/'); await tab.info();
```

Navigate to the observed selected permalink and return page info.

### Cell 6

Request: `01M3AECH6WMYVEAD08G580AGHK`. Duration: 123 ms. Inline text: 7,638 bytes.

```javascript
var postSnap = await tab.snapshot(); console.log(postSnap.format({maxBytes:20000}));
```

Post snapshot preview: 126/205 nodes; comments remain outside the printed prefix.

### Cell 7

Request: `01M3AECN8CV54H7XMH21EN2V97`. Duration: 46 ms. Inline text: 657 bytes.

```javascript
var comments = await tab.evaluate(() => [...document.querySelectorAll('shreddit-comment')].map((c,i)=>({i,author:c.getAttribute('author'),depth:c.getAttribute('depth'),text:(c.innerText||'').replace(/\s+/g,' ').trim().slice(0,1000)}))); console.log(JSON.stringify(comments,null,2));
```

Extract four loaded comment records; all summarized in final answer.
