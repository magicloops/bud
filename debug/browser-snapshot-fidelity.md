# Debug: Snapshot text and toggle-state omissions

## Environment and reproduction

Chrome 151.0.7922.34, Playwright Core 1.63.0, managed Node 24.21.0.
The [accessibility spike](browser-accessibility-spike.md) reproduces loss with
mixed inline text and pressed/mixed controls in disposable Chrome.

## Observed and expected

Playwright returns string children alongside object nodes. Bud's sanitizer
skips these, so `Stock: <strong>17</strong> units remaining.` becomes only `17`.
It also excludes `pressed` and string-valued `checked: mixed`; compaction's state
list omits pressed. Preserve source order, depth, text and supported toggle
states without forwarding field values or implementation properties.

## Fix scope

Convert string children to non-actionable text nodes at their existing depth.
Include pressed and allow mixed only for checked/pressed. Preserve these states
in compact text and structural decisions. Keep field text/descendant exclusion,
snapshot limits, references, authorization and wire envelopes unchanged.
No new routes, schema, authority, runtime API or accessibility implementation.
Update helper spec and run sanitizer, compaction and real-Chrome regressions,
then repeat the spike. Rebuild/prepare matching helper and restart the daemon
before live use; no running-process restart is part of this fix.

## Validation investigation

Initial command (from `bud/browser-helper`):
`BUD_BROWSER_EXECUTABLE=<installed Chrome> <managed Node> --test engine.test.mjs compact.test.mjs`.
15/17 passed. New fixture assertion omitted the legitimate `Password` label
now retained as inline text; expected output corrected, field value still excluded.
The existing scrolling test also returned `browser_click_blocked` at its final
click while the separate spike was running Chrome concurrently. Rerun the
suite without the competing spike to distinguish timing sensitivity from a
snapshot regression; no click behavior changed in this patch.

Second run exposed a fixture assumption: Playwright omits `pressed:false` in
this real ARIA snapshot. The sanitizer must not synthesize it; the browser test
now checks absence and the unit test separately proves preservation when the
upstream property is explicitly false. The scroll/click failure persisted without
the concurrent spike and reproduced with `HEAD:bud/browser-helper/engine.mjs`
loaded as a temporary baseline module, using
`node --test --test-name-pattern='bounded scrolling' <baseline test>`.
Temporary baseline files were removed. This is pre-existing and out of scope.

Targeted command `node --test --test-name-pattern='inline|toggle|field values'
engine.test.mjs` with the same Chrome/Node environment passes 4/4, including the
real browser. Compaction's seven tests passed in both full-suite runs.
Final complete engine/compaction run: 16/17 passed, zero skipped; only the
baseline-reproduced `browser_click_blocked` scrolling test remains failing.
Syntax checks and `git diff --check` pass.

Corrected spike: 21 captures completed at
`/tmp/bud-ax-spike-fixed-20260923/report.json`. Mixed inline fixture grows from
835 to 1,048 bytes, retains both surrounding sentinels and pressed:mixed.
Control fixture grows from 1,450 to 1,592 bytes; actual password remains excluded.
HN now retains 649 nodes (was 487); it is 43,449 bytes versus Pi's 52,823 bytes
in this new live capture, approximately 18% smaller. The live content changed
slightly between runs; table/article/nested fixtures retain their previous sizes.
No production helper preparation, deployment or daemon restart performed.
