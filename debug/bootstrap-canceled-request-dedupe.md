# Debug: Canceled bootstrap requests must retain delivered-work exclusion

## Reproduction and observation

A bootstrap group is admitted and may execute actions. Cancel its parent request, then preview another request with default prior-work exclusion. Filtering only parent request status excludes the canceled receipt from dedupe, which can select already-dispatched contacts again.

## Expected

Default exclusion follows individual group admission. Any admitted group remains prior work even if its parent is canceled; unadmitted canceled groups can be selected explicitly later. Repeated work remains available only through the explicit rerun option.

## Fix and validation

Use matching group state (`pending` or `admitted`) in the snapshot selector shared by preview/capture. Keep historical matcher suppression unchanged. Extend the PostgreSQL lifecycle fixture to cancel an admitted bootstrap, then verify default preview excludes its frozen members.
