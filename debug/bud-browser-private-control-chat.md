# Debug: private browser control queues chat

Local HTTPS service and managed Chrome, 2026-09-14. Sending “Can you open the 6th
link?” at 23:16:24 saved a pending invocation with attempt=0. The browser was later
interrupted/paused and unclosed. InvocationRepository.claim excludes any thread
with an unclosed non-agent browser, so the request never reached the model.

Fix: remove that global exclusion, retain dispatch/evidence privacy checks, and
release only browser-handoff reservations to allow follow-up conversation. Expose
an explicit paused-browser notice from the existing authorized inventory.
See ../plan/bud-owned-browser/private-control-chat.md.
