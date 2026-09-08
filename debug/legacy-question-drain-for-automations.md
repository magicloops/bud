# Local durable-mode enablement

On September 6 the user confirmed the five May 20–22 legacy question forms no
longer matter. Canceled exactly the five reviewed request IDs, conditional on
pending status and their original thread/owner/Bud association. Preserved request
payloads and conversation history; did not fabricate answers or resume agents.
Remaining pending legacy questions: zero.

Restarted the existing service watcher by touching `service/src/server.ts` (no
content change). The watcher reported its five-second shutdown timeout and
force-killed the previous process before starting the replacement. This was not
a verified graceful drain. Brief proxy 502s occurred during restart.

Replacement PID 4743 reported admission mode `durable`, automations enabled,
app data keys disabled, and listening on port 3000. Log:
`/tmp/bud-ngrok-local-https.log`. The startup mode guard passed unchanged.
