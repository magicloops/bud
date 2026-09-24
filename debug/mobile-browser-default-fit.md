# Debug: Mobile browser requires takeover before fitting

## Environment and reproduction

Physical iPhone using the hosted mobile viewer through ngrok. Open a page through
Bud, then open Browser without taking private control.

## Observed

The page retains its desktop viewport. Fit only works after Take control and an
explicit toggle. Mobile initializes fit=false, blocks passive fitting in the
effect, and disables the checkbox for non-owners.

## Expected and fix

Default Fit on and reuse the existing authorized agent viewport-fit route, as on
desktop. No private acquisition is needed. The scoped mobile principal remains
bound to the owned workspace/viewer; the service retains viewport ownership and
private-control checks. No new API or daemon behavior is needed. Keep surface-only
measurement, coalescing, lifecycle cancellation and private input geometry fences.

## Validation

Mounted mobile regression: first frame triggers a phone-sized viewport request
without control acquisition, subsequent surface resize updates it, suspension
stops fitting, and a failed fit preserves passive media without retrying.
Run shared viewer, mobile, touch and fitter tests plus the web build. Real-phone
acceptance remains a follow-up.
