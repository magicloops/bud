# Investigation: hidden rendering and input

Status: **Investigation complete; promising candidate identified, production gates remain.**
2026-09-28. Follows [Phase 1 findings](phase-1-findings.md).

Follow-up: [scoped lifetime implementation and results](scoped-rendering-lifetime.md)
now cover native click/text/Enter, navigation, resize, detach and source loss.
Keeping geometry on the command attachment avoided the earlier viewport reset
in these repeated tests. Remaining items below describe the original findings;
the follow-up identifies which have since been tested.

## Scope

Use disposable synthetic Chrome profiles to compare the current headed setup,
headless Chrome, target-scoped CDP focus emulation, and supported background
settings if still needed. Keep native wheel input, independent source ACKs and
440×816 geometry fixed. No production/runtime or authority changes.

The candidate must produce changing pixels and actual wheel displacement while
the target is hidden, preserve minimized window state, and avoid OS focus changes
during hidden trials. Repeat a promising candidate and disable it again to check
lifecycle cleanup. Source frame rate is not phone presentation performance.

`Emulation.setFocusEmulationEnabled` is a promising targeted candidate: Chromium's
handler increments a capture count as well as emulating focus. Verify against the
installed schema and actual runtime, rather than treating tip-of-tree source as
a guarantee. This changes page-visible focus/visibility semantics, so assess
scope, cleanup, other workspaces and local takeover explicitly.

References:
- [CDP Emulation](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/)
- [Chromium emulation handler](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/protocol/emulation_handler.cc)

## Checks and deliverables

- [x] Compare headless with the same hidden-target matrix.
- [x] Test focus emulation independently of process-wide background flags.
- [x] Confirm actual scrolling, continuing frames, window state and OS focus.
- [x] Repeat and check disable/detach behavior; distinguish remaining gaps.
- [x] Record reproducible commands/results and recommend the smallest next step.

Update the spike's spec/README and this folder's spec. Frame provenance, relay,
phone measurements and production rollout remain separate subsequent work.

## Results

Same macOS 15.6.1/M4 Max/Chrome 154.0.8037.57 setup as the original probe.
Installed protocol confirms `Emulation.setFocusEmulationEnabled`. New options
exist only in the [local spike](../../spikes/browser-streaming/README.md).
[Measurement summaries](rendering-measurements.json) include all comparisons.

| Configuration | Result |
|---|---|
| Headless alone, same internal selection/minimization matrix | Hidden frames stop and native wheel calls time out; removing physical windows alone is insufficient |
| Headed + target focus emulation, idle selected | Background A/B stream and scroll even when the native window is minimized |
| Headed + focus emulation, captured tab itself selected then minimized | Only an initial frame, wheel ACKs around 0.9 seconds; not usable |
| Focus emulation + three background switches | No improvement to selected/minimized failure; around 1.9-second wheel ACKs there. Do not adopt the switches |
| Fresh headed background tabs + focus emulation | Both stream and scroll without first being selected or screenshot-captured |
| Same, using macOS `open -g -n` launch | Repeated success; foreground monitor never observes this Chrome becoming foreground |
| Headless + focus emulation, fresh internally hidden tabs | Both stream and scroll; possible alternative if direct native-window takeover is not required |

The three tested switches were `--disable-backgrounding-occluded-windows`,
`--disable-renderer-backgrounding`, and `--disable-background-timer-throttling`.
Their definitions were checked in [Chromium source](https://github.com/chromium/chromium/blob/main/content/public/common/content_switches.cc).
This is a bundled comparison, not evidence that each switch independently has
no effect. They are unnecessary for the working idle-selected candidate.

## Cold-start, no-foreground candidate

```sh
node spikes/browser-streaming/run.mjs --focus --hidden-only --background-launch --seconds=10 --input=wheel
```

This creates a fresh owned profile, keeps the Bud idle page selected and the
window minimized, then enables focus emulation only on the target being captured.
It does not activate A/B or prime them with screenshot calls. Wheel direction
reverses every second; the fixture records actual absolute scroll travel so
returning near the start is not misclassified as missing input.

| Run / target | Source events/sec | Wheel commands / observed wheel events | Actual scroll travel | Command ACK p95 |
|---|---:|---:|---:|---:|
| `4DkXcT` A | 51.76 | 86 / 86 | 2,905.5 CSS px | 20.07 ms |
| `4DkXcT` B | 29.43 | 86 / 86 | 2,905.5 CSS px | 20.10 ms |
| `ruUmcb` A | 47.58 | 86 / 86 | 2,941.5 CSS px | 18.55 ms |
| `ruUmcb` B | 28.39 | 86 / 86 | 2,941.5 CSS px | 18.26 ms |

All four trials preserve 440×816 CSS geometry while running and native window
bounds remain minimized. No input command timed out. These are source arrival
rates and command ACKs, **not displayed fps or end-to-end input latency**.

A final matched cold-hidden/background-launch control without `--focus`
(`RRAryA`) returns zero frames and five-second native wheel timeouts on both
targets. Its `hasFocus()` is false. This isolates the positive result from the
background launcher alone and makes the post-disable focus state a real follow-up.

The first background-launch run's 100 ms AppKit monitor recorded no foreground
changes. During the repeat, the foreground PID changed between two other apps;
neither was the probe's Chrome PID (`38414`). The probe cannot establish why that
external change happened, but it never observed Chrome becoming foreground.
Sampling cannot exclude transitions shorter than 100 ms.

By comparison, the direct-launch run switched from the original app to the probe
Chrome at startup and back at exit. `open -g -n` avoids that observed behavior.
This is evidence for a macOS launcher requirement; it is not a production process
supervision design. The daemon must retain owned-process discovery, timeouts,
shutdown and profile safety when implementing an equivalent nonactivating launch.

## Why focus emulation helps

Chromium's emulation handler both overrides widget focus and holds a WebContents
capture reference while enabled. That gives a concrete reason to test it for
background rendering. Runtime evidence is narrower than a universal browser
guarantee: with the idle tab selected it restores updates and native wheel input,
but it does not fix every selected/minimized state on this Chrome/macOS version.

It also makes the page report `visibilityState: visible` and `hasFocus(): true`
while the native window remains minimized. This is a deliberate page-semantics
change. Websites may run animations, play media or change focus-driven behavior;
limit it to the currently admitted interactive target instead of enabling it on
every workspace. It must not become a substitute for Bud's ownership/lease checks.

## Cleanup and remaining constraints

- Explicit disable returns page visibility to hidden; counters stop advancing
  over the subsequent 200 ms detach observation in the repeated test. B remains
  unanimated until its own trial starts. This supports basic scoped lifecycle,
  not simultaneous-workspace or cross-user isolation acceptance.
- `document.hasFocus()` still reads true after disable/detach in this setup.
  Do not use it as proof of native focus or complete focus-event restoration.
  Test focus/blur events and actual keyboard destination before production use.
- CDP detach resets emulation to the native 1024×681 viewport. Production needs
  explicit viewport ownership and reapplication/generation handling; stale
  frame geometry must never authorize input after this transition.
- The selected-and-minimized case still fails. Preserve the idle-tab invariant
  for remote capture; test what happens when someone manually selects a workspace
  tab or minimizes it during direct local takeover. Do not repeatedly foreground
  or silently fight the user's tab selection to repair this state.
- Headless plus focus emulation works in a short source-only test (26–38 events/sec,
  wheel ACK p95 35–36 ms). It removes the ordinary visible Chrome window used for
  direct local interaction; app-based remote takeover remains conceptually
  possible. Switching a running headed session to headless is not implemented or
  assumed to preserve live page state. Prefer headed here to minimize product change.
- Keyboard, native click effects, dialogs, navigation/renderer swaps, source
  disconnect without explicit disable, crash/restart, sustained CPU/memory and
  production REPL co-attachment remain untested. No physical-phone result yet.

## Recommendation and next implementation gate

Keep the existing headed browser and idle tab. For the next source experiment,
add a **scoped focus-emulation lifetime on the admitted private capture target**
and a nonactivating macOS launch. Avoid global background flags and a headless
product migration for now.

Before WSS integration, extend the same fixture to verify click/keyboard and
navigation/resize provenance, source cancellation/crash cleanup, and local
takeover transitions. Use one clear owner for viewport and focus-emulation state;
disable on Return, loss of private authority, viewer disappearance and source
retirement. Recheck the production helper's simultaneous CDP attachments because
this probe has already exposed cross-attachment viewport reset.

The capture-only no-go is now a **conditional go for further source/provenance
work** with this configuration. Phase 1 as a whole is not complete; Phase 2 and
phone acceptance remain pending. No daemon, service, mobile or deployed behavior
was changed by this investigation.
