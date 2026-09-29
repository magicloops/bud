# Debug: screencast capture and wheel input in hidden Chrome targets

## Environment

2026-09-28 UTC. macOS 15.6.1 (24G90), Apple M4 Max, Node 22.14.0,
Chrome 154.0.8037.57. Bud main reference `b9400bb`; uncommitted experiment code.
No database, LLM, service, daemon or mobile app participates in this local probe.

## Reproduction and observations

Initial command: `node spikes/browser-streaming/run.mjs --seconds=3`.
The first version always sent wheel input. Selected/restored delivered 97
screencast events in 3.05 seconds, then the inactive-target trial failed with
the exact error `cdp_timeout:Input.dispatchMouseEvent` after five seconds.
Results: OS-temp `bud-screencast-results-Ory1Uh/results.json`.

The revised harness uses an independent input connection, records a failed
condition without losing its capture metrics, and provides `--input=none`,
`bump` and `wheel`. This distinguishes input uncertainty from capture silence.
`bump` explicitly changes the DOM even when RAF is suspended.

`node spikes/browser-streaming/run.mjs --seconds=5 --input=bump` produced no
inactive/minimized frames despite acknowledged DOM changes and advancing fixture
counters. Local minimized screenshot RPCs still succeeded. The wheel-only
matrix reproduced five-second `Input.dispatchMouseEvent` deadlines for hidden
targets. See the [findings and measurements](../plan/browser-streaming/phase-1-findings.md).

## Expected

The candidate must deliver timely pixels from an owned inactive/minimized target
without repeatedly foregrounding Chrome. Input uncertainty must remain explicit.

## Hypotheses and limits

The tested headed Chrome's hidden rendering/input scheduling is a source-side
constraint. There is no WSS relay, network RTT or daemon page mutex in this
reproduction. DOM command replies continue while pixels do not arrive.
This does not prove the cause of the earlier production input failures: their
method, page state and command lifetimes still need correlation.

Early probe runs also showed viewport reset after another CDP attachment
detached. The harness now reapplies its viewport on each source attachment and
records observed dimensions. Frame-identity/input geometry remains a separate
unproven production gate.

## Disposition

Implement the reproducible probe and focused reader tests; stop dependent relay
work as required by Phase 1. Keep passive screenshot behavior and current
ownership/input guards unchanged. Scope a rendering-lifecycle experiment before
selecting a different transport: encoding or TURN cannot supply missing pixels.
Updated specs: spike parent/folder and browser-streaming plan folder.
