# Plan: Terminal Envelope Unification (`id`/`ts` across terminal_* frames)

## Context
- Terminal frames currently use `message_id`/`sent_at` (proto v0.2 draft), but Bud deserializes envelopes as `id`/`ts`. This causes parse failures (`missing field id`) and disconnects.
- Run/session frames use `id`/`ts`; the gateway and Bud already expect that shape.

## Objective
- Unify terminal_* envelope fields to match run/session: `proto`, `type`, `id`, `ts`, `ext` (extensions).
- Ensure both service (backend) and Bud produce/accept this envelope for all terminal_* frames (ensure/input/output/ready/status/interrupt/close/resize).
- Update docs/tests to reflect the unified contract.

## Scope / Impact
- **Backend (service)**: change terminal_* emitters to use `id`/`ts`; adjust Zod schemas; adjust SSE payloads and any stored metadata if necessary.
- **Bud**: adjust terminal frame serializers/deserializers to use `id`/`ts`; remove reliance on `message_id`/`sent_at`.
- **Docs**: update terminal proto sections to reflect the envelope (`id`/`ts`).
- **UI/Agent**: no change; they read SSE payloads unaffected by envelope field names (but confirm SSE still carries required fields).

## Design / Steps
- **Backend**
  - Update terminal manager payload builders (`terminal_ensure/input/interrupt/resize/status/output/ready/close`) to use `id` and `ts` fields instead of `message_id`/`sent_at`.
  - Update WS gateway Zod schemas for terminal_* frames to accept `id`/`ts` (and optionally drop `message_id`/`sent_at`).
  - Audit any place we log or store terminal frames (none expected) for field names.
  - Optional: temporarily accept both field sets when parsing (if we want a soft transition), but emit only `id`/`ts`.
- **Bud**
  - Update terminal frame structs to expect `id`/`ts` (`Envelope` reuse), and set these when sending terminal_* frames upstream.
  - Ensure terminal handlers no longer expect `message_id`/`sent_at`; remove aliases or dual naming once unified.
- **Docs**
  - Update `plan/persistent-terminal.md` and any proto references to state envelope keys are `id`/`ts` (no `message_id`/`sent_at`).

## Testing
- Unit-ish: cargo check (Bud), pnpm lint (service).
- Integration manual: start Bud + backend; `POST /api/terminals/:budId/ensure`, send terminal_input, observe terminal_output/ready without disconnects or parse errors.
- Verify gateway logs show frames delivered (no "missing field id") and terminal SSE operates.

## Rollout
- Immediate change (no feature flag); both sides must be updated together.
- If needed, a short-lived dual-parse (accept both) can be added to the gateway while Bud updates, but target state is `id`/`ts` only.
