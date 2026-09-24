# Spike: Chrome AX versus Bud's Playwright snapshots

Status: spike complete; no production snapshot change, 2026-09-23.

## Question and approach

Is Bud's current observation unnecessarily rich compared with browser-use-pi?
Compare raw Chrome `Accessibility.getFullAXTree`, browser-use-pi's projection,
raw Playwright `ariaSnapshotJSON`, and Bud's actual full compact REPL snapshot
on the same page in disposable Chrome. Include equal-field projections to
distinguish serialization overhead from content duplication and coverage.

Reference: browser-use-pi `src/page.ts` at
`fa838f3298673950923bdaf12bd3c1b6279cd119`. Bud uses
`bud/browser-helper/engine.mjs` and `compact.mjs`; REPL snapshots request
`full:true, compact:true`. No production representation change is proposed yet.

Use fixed nested records, tables, article text, forms/shadow/frame fixtures and
public live pages. Do not attach to the user's running browser or profile.
Record complete captures in private local artifacts, serialized bytes, node/role
counts, repeated text, states/URLs/hierarchy and capture timing. Distinguish
full retained data from Node inspection previews and actual selected tool output.
Bytes are not provider token counts. No model task or cost claim from this spike.

## Safety and contracts

No service routes, database reads, ownership changes, agent catalog changes or
daemon restarts. Disposable fixture/live public pages only. Any future switch
must preserve ownership, private control, reference freshness, URLs and coverage.

## Validation

Run the standalone comparison script with the existing pinned Playwright and
installed Chrome. Inspect complete results and record findings here. Update
the scripts spec for the executable investigation tool. This document is also
the bounded implementation plan for the spike; scope ends at measurement.

## Reproduction and evidence

Script: [compare-browser-accessibility.mjs](../service/scripts/compare-browser-accessibility.mjs).
Run from `service/`, using an installed Chrome executable:

```sh
BUD_BROWSER_EXECUTABLE='/path/to/Google Chrome for Testing' \
  node scripts/compare-browser-accessibility.mjs /tmp/bud-ax-spike
```

Measured with managed Node 24.21.0, Playwright Core 1.63.0 and Chrome for Testing
151.0.7922.34, headless, 1280×900 viewport. Each page has three captures with
alternating operation order. Full private artifacts and metrics:
`/tmp/bud-ax-spike-20260923-final/report.json` and adjacent per-page captures.
Five fixed fixtures plus live Hacker News succeeded. Reddit returned a humanity
challenge: its measurements describe that challenge, **not the feed**. No attempt
was made to bypass it or access the user's profile. Chrome exited after capture.

The script implements the reference `Page.snapshot()` projection exactly for
node filtering/fields, using the same CDP response for raw and projected results.
It calls Bud's actual `Engine.execute` rather than a reimplementation. Raw
Playwright JSON is measured before Bud sanitization. Raw AX includes ignored
nodes, properties and name-computation metadata; the Pi projection omits these.

## Size results

Compact JSON serialization, KiB (1024 bytes), first sample. Captures were size
stable across the three samples within each final-run page. This is the full
locally retained representation, not what a selective REPL cell necessarily
emits. No provider calls or tokenizer estimates were used.

| Page | Raw CDP AX | Pi projection | Raw Playwright | Current Bud REPL |
| --- | ---: | ---: | ---: | ---: |
| Nested records | 99.07 | 9.15 | 8.87 | 9.81 |
| 120-row table | 514.83 | 41.19 | 35.12 | 36.11 |
| 45-section article | 198.88 | 31.66 | 28.53 | 26.89 |
| Mixed inline text | 8.24 | 0.74 | 0.41 | 0.82 |
| States, shadow DOM, iframe | 18.42 | 1.37 | 0.97 | 1.42 |
| Live Hacker News | 607.65 | 51.72 | 40.60 | 36.20 |
| Reddit challenge only | 25.22 | 1.31 | 1.40 | 1.71 |

Bud was 12% smaller on the table, 15% smaller on the article and 30% smaller on
HN than Pi's projection. It was 7% larger on nested records and slightly larger
on the small control/inline fixtures. Raw Playwright JSON was smaller than Pi's
projection on every non-challenge page tested. **Switching to raw AX or the Pi
projection is not supported as a general size optimization by these results.**

This does not establish equal coverage. In particular, some of Bud's apparent
savings below are a correctness bug, not desirable compression.

## What accounts for the difference

- **Chrome duplicates labels as text nodes.** Pi's filter removes ignored nodes
  and nodes without backend DOM IDs but retains separate `StaticText` children
  alongside named headings, links and table cells. On the table it returns 973
  nodes versus Bud's 608; on HN, 1,118 versus 487. Exact repeated name/text bytes
  are 3,636 versus 9 on the table and 3,502 versus 491 on HN. These are descriptive
  counts, not a license to delete every repeated string: equal labels can belong
  to different entities.
- **Bud carries actionable structure.** It includes depth, exact link URLs,
  opaque references, document/observation identity and coverage metadata. Pi's
  projection has integer DOM IDs but no hierarchy or destination URLs. Bud's
  nested-record result has 20 link URLs absent from Pi's projection. Its extra
  fields explain why fewer nodes can still yield a slightly larger result.
- **A common-field comparison still favors fewer Playwright/Bud nodes.** Projecting
  both node sets to `{role,text}` produces 18,146 bytes for Bud versus 33,454 for
  Pi on the table, and 25,697 versus 30,415 on the article. This isolates some
  field overhead, but is not a replacement API and does not prove equal content.
- **Iframe coverage differs.** Pi's default main-frame AX read lists the iframe
  element but omits our fixture's embedded heading/link. Bud's Playwright snapshot
  includes them, and includes the challenge checkbox from Reddit's embedded
  frame. Pi can query frames explicitly; its default snapshot does not do so.
  Both include the fixture's open-shadow-root button and omit hidden text.
- **Neither snapshot included fixture script content.** The prior run's embedded
  script text arose in agent-authored DOM extraction, not either tested snapshot.

## Correctness findings: Bud drops valid evidence

### String children are skipped

Playwright's JSON tree can contain both object nodes and plain string children.
`sanitize()` currently skips non-object nodes. A deterministic fixture returned:

```text
Playwright: paragraph ["Stock:", strong(text="17"), "units remaining."]
Bud:        strong(text="17")
```

The same fixture loses `BEFORE_SENTINEL` and `AFTER_SENTINEL` around a link.
The HN snapshot has 162 raw string children, including meaningful score text
such as `211 points by`, as well as punctuation. They are skipped before
`compactNodes` runs. Some values may also occur elsewhere; not all 162 represent
unique lost facts. Even so, the sentinel fixture proves actual information loss.
The result still says `truncated:false`, because that flag concerns the output
budget rather than preservation of source children.

### Pressed state is dropped

Raw Playwright and CDP both preserve `pressed:true` and `pressed:"mixed"` in the
fixtures. Bud's sanitizer/state serialization omits `pressed`. Chrome also reports
the open details disclosure as expanded; this Playwright snapshot represents its
summary as a generic node without that expanded state. These are different
failure locations: our sanitization versus the upstream representation.

### Field-value policy must remain deliberate

Pi's projection includes textbox values (password masked in this Chrome AX
capture). Raw Playwright includes the fixture's fake password as textbox text.
Bud deliberately removes field text and descendants. Any sanitizer correction
must preserve that policy; simply forwarding all raw children/fields is unsafe.
Raw capture files here contain only disposable fixture values and public pages.

## Timing and output-preview caveats

Median capture times in milliseconds:

| Page | CDP AX call | Raw Playwright | Full Bud engine |
| --- | ---: | ---: | ---: |
| Nested records | 2 | 3 | 8 |
| Table | 10 | 10 | 16 |
| Article | 4 | 3 | 7 |
| HN | 14 | 15 | 21 |

The Bud measurement includes target discovery, document checks and reference
binding. The raw CDP timing excludes Pi's additional info query; neither is
end-to-end tool/provider latency. Three local samples are not a latency benchmark.

The report also records inspection-preview sizes using Bud's Phase 5 options.
Those may be dramatically smaller than JSON because arrays elide after 100
entries and deep objects elide after depth 5. For example, deeply nested raw
Playwright table output can collapse to hundreds of bytes while retaining tens
of KiB locally. That is missing preview content, not successful extraction or
equal-evidence compression. The headline comparison therefore uses full JSON.

## Recommended next step

Keep the accessibility-layer choice open, but do not switch on the expectation
that native AX is intrinsically leaner. First scope a small fidelity correction:

1. Preserve plain string children in order as text nodes while retaining the
   existing exclusion of form values/descendants.
2. Preserve supported action states including pressed/mixed through sanitization
   and compaction, with targeted regressions for state and association.
3. Repeat this same measurement after correction so lost evidence is not counted
   as context savings.
4. Continue the pending selective-extraction scope using these corrected
   observations and the 4462398b findings. Compare actual agent calls/context,
   since representation size alone does not predict output selection.

No production code was changed. The Reddit feed comparison and actual-model
quality/token comparison remain unmeasured. The discovered omissions do not prove
why the earlier agent chose DOM evaluation; that causal link is not established.

## Follow-up correction

The [fidelity fix](browser-snapshot-fidelity.md) now preserves string children and
reported pressed/checked mixed states. The original measurements above are kept
as pre-fix evidence. A repeat at `/tmp/bud-ax-spike-fixed-20260923/report.json`
retains the missing inline text; HN measures 42.43 KiB for Bud versus 51.58 KiB
for Pi (649 versus 1,118 nodes). The larger corrected result still does not
support an AX switch purely for size. Upstream omissions such as Playwright's
unreported false/disclosure state are not synthesized by this fix.
