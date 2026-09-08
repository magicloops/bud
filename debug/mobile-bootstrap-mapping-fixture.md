# Debug: Mobile bootstrap mapping fixture

## Environment
iOS simulator, combined proposal/model/store tests.

## Repro Steps
Run the selected AutomationProposalTests, AutomationProposalMappingTests and AutomationReviewStoreTests with xcodebuild (log `/tmp/bud-mobile-bootstrap-recovery-tests.log`).

## Observed
Cold bootstrap mapping test returned no pending tool, turn or waiting state. Existing activation/model/store cases passed; compilation succeeded.

## Hypotheses
The test's global `ap_` to `bp_` replacement also changes the suffix of `pending_bootstrap_requests`, so the decoder ignores the misspelled field.

## Proposed Fix
Restrict replacement to the fixture ID prefix rather than any `ap_` substring, then rerun combined tests including explicit empty-array recovery.
