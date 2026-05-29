# Debug: Streamdown Paragraph Animation Lag

## Environment
- Repo: `/Users/adam/bud`
- Area: Web UI message timeline and Streamdown-backed assistant renderer
- Date: 2026-05-28
- OS: macOS Darwin 24.6.0 arm64
- Node: v22.14.0
- Web dependencies reviewed: `streamdown@2.5.0`, `@streamdown/code@1.1.1`, `@streamdown/mermaid@1.0.2`, `@streamdown/math@1.0.2`
- DB connection style: not involved
- LLM mode: live streaming behavior suspected; investigation was code/docs/package-source review only
- Dev server: already running, not restarted for this investigation

## Repro Steps
1. Open an active thread in the web client.
2. Send a prompt that produces multiple short paragraphs quickly.
3. Watch the newest assistant draft while it streams.
4. Notice whether an earlier paragraph is still fading/animating after a later paragraph has already appeared or started streaming.

## Observed
- Paragraphs can visibly animate in after subsequent paragraph content is already present.
- The response reads as staggered by animation timing rather than as a natural text stream.
- The effect is most obvious when the model emits a large text delta, or when several text deltas arrive faster than the animation cadence.

## Expected
- Streaming assistant text should feel continuous and current.
- Previously emitted paragraphs should not keep performing delayed reveal animations once the reader is already seeing later content.
- Markdown streaming should preserve layout stability and incomplete-markdown handling without making the content feel out of sync with the actual stream.

## Current Implementation Trace
- `web/src/components/workbench/chat-timeline.tsx`
  - Draft assistant rows are identified with `message.metadata?.draft === true`.
  - Draft assistant content is routed through the shared role renderer with `isStreaming={isDraftAssistant}`.
  - The timeline scroll key tracks message count, last item identity/content length, and the activity footer state; it does not pace or buffer streaming content for animation.
- `web/src/components/message-renderers/roles/markdown-content.tsx`
  - `MarkdownContent` renders both streaming and final messages through `Streamdown`.
  - At the time of the investigation, streaming drafts passed `animated={isStreaming}`, `isAnimating={isStreaming}`, `mode={isStreaming ? 'streaming' : 'static'}`, and a block caret.
  - Because `animated` received the boolean `true`, Streamdown used its default animation options.
  - Bud's file-open behavior is limited to `inlineCode` and `a` component overrides, so it does not appear to be the cause of the delayed paragraph effect.

## Streamdown Animation Mechanics
- Streamdown's docs distinguish the two relevant props:
  - `isAnimating` indicates that content is streaming and disables controls.
  - `animated` enables the built-in text reveal animation for streaming content.
- The docs also note that animation is excluded from the processing pipeline when `isAnimating` is false.
- Local inspection of `streamdown@2.5.0` shows the default `animated={true}` options:
  - `animation: "fadeIn"`
  - `duration: 150`
  - `easing: "ease"`
  - `sep: "word"`
  - `stagger: 40`
- The local Streamdown animation CSS applies the per-token animation using CSS variables on `[data-sd-animate]` spans:
  - duration defaults to `150ms`
  - delay is assigned per newly rendered animated token
  - fill mode is `both`, so delayed tokens can remain visually hidden until their delay starts
- Streamdown tracks a previous rendered character count so already-seen text is not given a normal duration on later renders. That avoids reanimating old text on re-render, but it does not cancel CSS animations that were already scheduled on spans created in the previous render.

## Findings
- The strongest hypothesis is not that Markdown parsing itself is wrong. The issue is the default word-level animation timing.
- A single streamed paragraph with 30 newly seen words can schedule roughly `29 * 40ms + 150ms`, or about 1.3 seconds, of reveal work.
- If the backend sends the next paragraph within that window, React and Streamdown correctly render the newer paragraph, but the older paragraph's already-scheduled word fades may still be running.
- If one SSE `agent.message_delta` contains a large paragraph, Streamdown can create the whole paragraph in the DOM immediately with staggered delays. The visual reveal then lags behind the data stream.
- Streamdown's streaming block mode can make this more visible:
  - Paragraphs are parsed into streaming blocks.
  - A new paragraph can appear as a later block while prior-block word spans are still mid-animation.
  - The result looks like disconnected paragraph animation instead of ordinary token streaming.
- Bud currently has no client-side throttle or buffer that coordinates SSE delta arrival with Streamdown's animation duration. Adding that coupling would be a larger frontend behavior change and would risk making the UI feel slower.

## Hypotheses
- Primary: `animated={true}` opts into Streamdown's default `150ms` fade plus `40ms` word stagger, and that animation schedule is slower than many model/provider text deltas.
- Secondary: larger provider deltas amplify the issue because many words are considered newly rendered in the same React render, producing a long delayed reveal queue.
- Secondary: block parsing makes the lag easier to perceive because later paragraph blocks can be present while earlier block spans are still revealing.
- Unlikely: Bud's file-open overrides are causing this; they only affect inline code and links.
- Unlikely: Tailwind scanning or missing Streamdown CSS is the root cause; the observed problem sounds like animation CSS is present and doing too much, not absent.

## Proposed Validation
- Ask the model for a fast multi-paragraph answer and compare three local experiments:
  - Previous default: `animated={isStreaming}`.
  - Streaming parser and caret only: keep `mode="streaming"` and `isAnimating={isStreaming}`, but disable `animated`.
  - Reduced animation: pass explicit options such as `blurIn`, a short duration, and zero or near-zero stagger.
- Record whether the second paragraph can become visible before the first paragraph finishes animating.
- Repeat with:
  - short paragraphs
  - long paragraphs
  - lists
  - fenced code
  - tool-call gaps where the activity footer starts and stops

## Possible Fix Directions
- Preferred small v1 at investigation time: keep Streamdown for streaming/static Markdown and keep the caret, but disable word reveal animation for assistant drafts. The LLM stream itself already provides the motion.
- If some motion is still desired, configure animation explicitly with no meaningful queue, for example `blurIn` with `stagger: 0`.
- Avoid solving this by slowing the backend stream or encoding frontend animation state into backend SSE semantics.
- Keep `isAnimating={isStreaming}` unless validation shows it causes a separate issue, because it also communicates streaming state to Streamdown controls.

## Spec Files Affected If Fixed
- `web/src/components/message-renderers/roles/roles.spec.md`
- `web/src/components/message-renderers/message-renderers.spec.md`
- `web/src/components/workbench/workbench.spec.md` only if timeline scroll/activity behavior changes
- `plan/streamdown/validation-checklist.md` if the accepted behavior changes the manual animation/caret validation expectations

## Status
- Investigation documented.
- First fixed in the follow-up implementation by removing the `animated` prop from Bud's Streamdown renderer while keeping streaming mode, `isAnimating`, and the caret for draft assistant rows.
- Re-enabled after reviewing `reference/streamdown/animation.md` with explicit no-stagger `blurIn` options: `duration: 200`, `easing: "ease-out"`, and `stagger: 0`.
