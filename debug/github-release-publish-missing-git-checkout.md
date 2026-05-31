# Debug: GitHub Release Publish Missing Git Checkout

## Environment

- GitHub Actions workflow: `Bud Release Artifacts`
- Failing job: `publish-github-release`
- Trigger: release test/canary workflow

## Repro Steps

1. Run the release workflow from a `v*` tag.
2. Let build and manifest jobs complete.
3. Observe `Publish GitHub Release`.

## Observed

The publish step failed with:

```text
failed to run git: fatal: not a git repository (or any of the parent directories): .git
```

## Expected

The publish job should create the GitHub Release from downloaded workflow
artifacts and verify the matching tag.

## Hypothesis

`gh release create --verify-tag` shells out to Git to verify the tag. The
publish job only downloaded workflow artifacts and never ran
`actions/checkout`, so the job workspace had no `.git` directory.

## Proposed Fix

Add `actions/checkout@v4` to the publish job before `gh release create`.

Spec files affected:

- `.github/workflows/workflows.spec.md`

