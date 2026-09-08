# Debug: Web review release control

## Context
The durable status banner reports `needs_review`, and the server supports audited
owner abandonment, but the web view has no way to submit that decision.

## Approach
Show an inline review explanation, terminal access, explicit acknowledgement and
abandon action for the reserved reviewed invocation. Bind acknowledgement to the
thread, invocation and observed timestamp. Guard duplicate submits and obsolete
thread visits; refresh canonical state after success or state conflict. The owner
is resolved by the existing authenticated thread endpoint, never form data.
