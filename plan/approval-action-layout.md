# Approval action layout

Web and mobile inline automation/app-permission reviews arrange decisions as
red Deny on the left, blue borderless View details in the middle, and green
Enable/Allow/Process contacts on the right. Existing-contact wording stays
explicit. Details remain read-only; existing owner/version checks, capability
gates and identical-decision retries stay unchanged.

Related specs: `web/src/components/components.spec.md`; mobile
`plan/inline-personal-data-decisions.md`. Validate web lint/build and iOS device
build; inspect on device for tap targets and layout. No new API, schema or grants.
