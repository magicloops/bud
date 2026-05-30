# Phase 5: Validation, Rollout, And Fallbacks

## Objective

Validate the GitHub Releases + `get.bud.dev` installer path on real supported
hosts, then define rollout gates and fallback behavior before public exposure.

## Clean-Machine Matrix

- macOS 13+ arm64
- macOS 13+ x86_64
- Ubuntu 22.04 x86_64
- Ubuntu 24.04 x86_64

Each host must validate:

- public tokenless command
- authenticated `BUD_CLAIM_ID` command
- manifest fetch
- archive redirect to GitHub Release asset
- SHA-256 verification
- install path `~/.bud/bin/bud`
- `bud --version`
- `bud doctor`
- missing tmux flow where applicable
- daemon claim and reconnect
- terminal send/observe with real tmux

## Failure Modes To Exercise

### GitHub Unavailable

Expected v1 behavior:

- `get.bud.dev/install.sh` and stable manifest can still respond from
  Cloudflare.
- archive download fails while following the versioned artifact redirect.
- installer prints that artifact download failed and points to retry guidance.
- no partial binary is installed as current.

Follow-up if this is unacceptable:

- add R2/S3 mirror URLs to the manifest
- teach installer to retry mirrors
- preserve SHA-256 verification across every mirror

### Bad Checksum

Expected behavior:

- installer deletes the downloaded archive
- installer refuses to extract or replace `~/.bud/bin/bud`
- output names the target and expected/actual checksum

### Bad Stable Manifest

Expected behavior:

- installer fails closed on malformed JSON, missing target, or missing SHA
- rollback repoints stable to a previous known-good version

### Cloudflare Worker Unavailable

Expected behavior:

- install command fails before downloading artifacts
- existing installed Buds keep running
- rollback uses Cloudflare Worker deployment history or CI redeploy

## Rollout Stages

1. Internal canary channel with manual workflow dispatch.
2. Stable channel hidden behind internal docs.
3. Authenticated web-generated command uses `get.bud.dev/install.sh`.
4. Public docs expose tokenless install.
5. Optional mirror work if GitHub-origin reliability is not acceptable.

## Observability

Track:

- Worker request count by route family
- stable manifest status and latency
- artifact redirect count by version/target
- installer failure reports by stage
- GitHub download failures reported by installer output/support

Avoid logging:

- raw `BUD_CLAIM_ID`
- device secrets
- user identifiers in public Worker logs

## Fallback/Mirror Decision Gate

Add R2/S3 mirror support before public launch if any of these happen during
internal/beta validation:

- GitHub Release downloads are unavailable during multiple install windows
- corporate or customer environments commonly block GitHub downloads
- redirect latency or throttling materially affects install success
- we need first-party download logs or WAF controls for artifacts

If mirror support is added, keep GitHub Releases as canonical immutable archive
and use R2/S3 as a promoted mirror derived from the same CI artifacts.

## Exit Criteria

- [ ] clean-machine matrix passes
- [ ] GitHub-unavailable behavior is validated
- [ ] checksum mismatch fails closed
- [ ] bad manifest fails closed
- [ ] stable rollback is validated
- [ ] install docs match real command behavior
- [ ] support/debug output is clear enough for user reports
- [ ] mirror decision is made before public launch
