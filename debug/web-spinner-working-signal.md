# Web spinner: working signal with startup fallback

## Context and observed behavior
Web currently reserves a response row immediately and delays every spinner reveal
by 250 ms, including transitions where normalized output activity already says working.

## Approach
Keep thread-owned, authorized REST/SSE data and existing activity eligibility.
Track whether accepted normalized output activity has begun in the existing gate;
reset on local send/final and recover from active snapshots. Pass that fact through
the timeline to bypass visual grace. Text, completion and approval suppression still
win. Without a working signal, reveal after 500 ms while eligibility persists.
No protocol, authorization, provider-specific inference or new scheduling layer.

## Validation
Cover signal recovery/reset, working/text/tool transitions and timer fallback,
including cancellation before fallback. Browser geometry remains manual validation.
