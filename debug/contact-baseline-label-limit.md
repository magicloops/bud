# Debug: Contacts baseline blocked by labeled-value limit

## Observed

Physical iPhone upload through ngrok persisted 1,155 baseline contact records.
One processing job was `invalid_contact_payload`; generation 1 and subsequent
scans remained pending and no current contacts or automation deliveries existed.
Shape-only inspection found 235 phone entries, while `contacts.ts` allowed 200.
Replacing only the contact fields in an in-memory diagnostic made validation pass.
No personal field values were printed or copied into fixtures.

## Fix

Increase the processing bound to 1,000 entries per phone/email array. Retain the
4,096-character field limit, approved-field validation and 256 KiB raw line cap.
Add synthetic coverage for 235 entries and rejection over the new bound.
After validation, requeue only preserved invalid contact jobs that now pass the
production parser, under their owner locks. Do not alter raw events, event IDs,
scan manifests or baseline suppression. Verify publication and zero domain work.

## Results

Six Contacts/shared-wire tests passed; service build passed. Logs:
`/tmp/bud-contact-label-tests.log`, `/tmp/bud-contact-label-build.log`.
Requeued exactly one preserved job after the updated parser accepted it, using
an owner lock and conditional invalid-status update. Normal service processing
then published generations 1–5: 1,160 processed raw jobs, 1,155 current contacts,
zero contact domain events and zero automation deliveries. No mobile re-upload
or raw-data rewrite was required. The live `bud-dev` owner matches the upload owner.
