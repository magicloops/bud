# Debug: GitHub Actions Node 20 Deprecation Warning

## Environment

- GitHub Actions workflow: `Bud Release Artifacts`
- Warning date: 2026-05-31
- Affected action observed in logs: `actions/checkout@v4`

## Repro Steps

1. Run the release workflow from a canary tag.
2. Open the `Prepare release metadata` job.
3. Observe the deprecation warning emitted by GitHub Actions.

## Observed

GitHub warns that JavaScript actions running on Node.js 20 are deprecated and
will default to Node.js 24 starting June 16, 2026.

## Expected

Release and promotion workflows should use action versions that declare a
Node.js 24 runtime where available.

## Hypotheses

- `actions/checkout@v4` still targets Node.js 20.
- `actions/upload-artifact@v4` and `actions/download-artifact@v4` should be
  upgraded at the same time to avoid the same warning in later jobs.
- `cloudflare/wrangler-action@v3` may still warn separately during promotion;
  keep that as a follow-up if the promotion workflow reports it, since it is
  maintained outside the official `actions/*` family.

## Proposed Fix

- Upgrade `actions/checkout@v4` to `actions/checkout@v5`.
- Upgrade `actions/upload-artifact@v4` to `actions/upload-artifact@v7`.
- Upgrade `actions/download-artifact@v4` to `actions/download-artifact@v7`.

Spec files affected:

- `.github/workflows/workflows.spec.md`

