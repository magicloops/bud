# Durable invocation context ordering

## Observation

Conversation loading and compaction boundaries include every saved input. Multiple admitted turns can therefore consume queued instructions before their own execution; a checkpoint can also skip an input whose original transcript timestamp precedes the checkpoint but whose execution starts later.

## Fix

Stamp `model_context_at` once on the canonical input message in the fenced first-start transaction. Admission sets it to null, overriding caller metadata. Model loading excludes durable inputs without this stamp and orders visible inputs by it; normal transcript ordering remains unchanged. Checkpoint boundary selection uses the same visibility and ordering expressions. Continuation starts preserve the original stamp. Existing provider-ledger calls remain thread-serialized by the durable reservation. Automation input is replayed at user-message priority, not as a system instruction.

## Validation

Local PostgreSQL fixture: two saved inputs, first invocation starts while second remains excluded; checkpoint advances through the first visible input; after the second starts it appears after that checkpoint despite its older transcript timestamp. Existing loader/checkpoint/continuation tests remain required.

The continuation replay check also identified missing `llm_call_id`/`call_id` metadata on reconstructed answer messages. Added those references so same-provider replay pairs each canonical result with the existing ledger call. The PostgreSQL fixture explicitly verifies ledger provenance and exactly one question call/result after restoration. The complete repository fixture passes, along with 23 loader/checkpoint/budget regression tests.
