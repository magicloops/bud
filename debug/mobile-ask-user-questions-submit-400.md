# Debug: mobile-ask-user-questions-submit-400

## Environment
- Workspace: `/Users/adam/bud`
- Service route: `POST /api/threads/:threadId/agent/question-requests/:requestId/responses`
- Client: mobile/native
- Observed at: 2026-05-20 15:32 local service log time

## Repro Steps
1. Mobile submits a response to:
   ```text
   /api/threads/a196e037-8994-4d8a-962e-f26b5de22da7/agent/question-requests/qr_01KS3R5TCA8PCFNCYZFJ91B0EE/responses
   ```
2. Service returns `400`.

## Observed
```text
[service] [15:32:30.573] INFO (62549): incoming request
[service]     reqId: "req-15o"
[service]     req: {
[service]       "method": "POST",
[service]       "url": "/api/threads/a196e037-8994-4d8a-962e-f26b5de22da7/agent/question-requests/qr_01KS3R5TCA8PCFNCYZFJ91B0EE/responses",
[service]       "hostname": "localhost:3443",
[service]       "remoteAddress": "127.0.0.1",
[service]       "remotePort": 55051
[service]     }
[service] [15:32:30.579] INFO (62549): request completed
[service]     reqId: "req-15o"
[service]     res: {
[service]       "statusCode": 400
[service]     }
[service]     responseTime: 5.8132500648498535
```

## Expected
- The service should log enough redacted context to distinguish malformed response shape, unknown question id, answer kind mismatch, unknown choice id, duplicate answer, or stale request state.

## Hypotheses
- Mobile may be sending `id`/`choiceId` instead of `question_id`/`choice_id`.
- Mobile may be omitting `schema: "ask_user_questions_response_v1"` or `client_response_id`.
- Mobile may be sending a text/number value with the wrong JSON type.
- Mobile may be submitting a question id that does not match the stored request.

## Proposed Fix
- Add route-level warning logs for known question-response failures.
- Include thread id, question request id, viewer id, error code/message, and a redacted body summary.
- Do not log raw text answers or freeform answer values.
- Spec files affected: `service/src/routes/threads/threads.spec.md`.
