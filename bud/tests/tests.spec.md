# Daemon executable tests

- `doctor.rs`: real CLI preflight and holder smoke against temporary state.
- `instance.rs`: selected configuration defaults/precedence, preserved identity
  on backend mismatch, and isolated lifecycle actions using fake platform
  managers and temporary HOME; never edits the developer's real services.
- `term_hold.rs`: hidden single-binary holder entrypoint tests.
- `terminal_stem.rs`: daemon/holder terminal integration and persistence checks.

Parent: [daemon spec](../bud.spec.md).
