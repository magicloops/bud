# Debug: Older publisher can consume staged repair

Distinct raw event types protect a repair uploaded to an older service. They do
not protect repair records already staged by a new service before rollback: the
old publisher selects `pending` scans and may accept an adjacent-generation resync
while ignoring its replacement semantics.

Stage repair scans as `repair_pending`. Only the new publisher recognizes this
status; older publishers leave it untouched. New status counts and clients treat
it as pending work. Verify the actual old selector cannot find a staged repair,
then publish it with the new processor. This requires no schema change because
scan statuses are text. Completed repair state remains compatible with subsequent
ordinary generation publication.
