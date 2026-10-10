# Phase 7a: manual Cloudflare setup and mirror validation

Status: mirror tooling and local validation implemented; manual bucket/token
setup reported complete. Real R2 mirror validation is pending. This runbook uses the dashboard, not `cf`.

Parent: [Phase 7: R2 release delivery](phase-7-r2-release-delivery.md).

## 1. Create or confirm the private bucket

In the Cloudflare account that owns `get.bud.dev`, open **R2 Object Storage**.
Enable R2 if necessary, then check whether `bud-releases-prod` already exists.
Create it if absent, with Standard storage. Keep public access disabled:
no `r2.dev` access and no bucket custom domain. Do not add an object-expiration
rule. Record the account ID and bucket name; do not record credentials here.

The existing Worker will eventually serve these objects through its binding.
The bucket itself stays private.

## 2. Create bucket-scoped publisher credentials

Under R2 API token management, create an **Object Read & Write** token scoped
only to `bud-releases-prod`. Save its S3 Access Key ID and Secret Access Key
securely. These are different from the API token used to deploy Workers.
See [Cloudflare R2 credentials](https://developers.cloudflare.com/r2/api/tokens/).

In `magicloops/bud`, open **Settings → Secrets and variables → Actions**:

| Repository secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Account containing the bucket; confirm the existing secret points to this account |
| `R2_ACCESS_KEY_ID` | R2 S3 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key |

The mirror workflow fixes `R2_BUCKET=bud-releases-prod`. Existing
`CLOUDFLARE_API_TOKEN` remains the Worker deployment credential; the mirror
does not use it. Never paste keys into this document, chat, generated assets,
or command history.

## 3. Mirror one explicit release

After the workflow is merged, open **Actions → Mirror Bud release to R2 →
Run workflow**, and enter `v0.1.25`. This is a mirror-only operation: it does
not deploy the Worker or change stable.

To validate before merge, use the local tool with those credentials supplied
through your secure environment and an authenticated `gh` CLI:

```sh
npm ci --ignore-scripts --prefix scripts
npm test --prefix scripts
node scripts/bud-release-mirror.mjs v0.1.25
```

The tool downloads the exact manifest and four fixed archive names from the
GitHub release. All source SHA-256 values and byte sizes must match before
upload begins. Each object uses conditional creation (`If-None-Match: *`),
then its actual R2 bytes are read back and verified. The version manifest is
written last. See [R2 S3 API support](https://developers.cloudflare.com/r2/api/s3/api/).

Expected objects:

```text
releases/v0.1.25/bud-aarch64-apple-darwin.tar.gz
releases/v0.1.25/bud-x86_64-apple-darwin.tar.gz
releases/v0.1.25/bud-aarch64-unknown-linux-gnu.tar.gz
releases/v0.1.25/bud-x86_64-unknown-linux-gnu.tar.gz
releases/v0.1.25/manifest.json
```

Run the same version again: all five objects should report verification of
existing bytes, with no replacements. An interrupted run can be resumed.
A conflicting object fails verification; investigate its origin rather than
deleting or overwriting it to force success. Failed runs never change stable.

## 4. Worker binding at Phase 7b cutover

When Phase 7b's Worker/config changes are ready, manually confirm the Worker
has an R2 binding named **`RELEASES`** pointing to **`bud-releases-prod`** in
**Workers & Pages → get-bud-dev → Settings → Bindings**. The checked-in
Wrangler configuration must declare the same binding so subsequent CI deploys
preserve it. Phase 7a does not change or deploy that configuration; adding a
binding alone does not switch existing redirects to R2 byte delivery.

## Acceptance record

- [x] Local integrity, conflict, interruption, resumption and conditional-write tests.
- [x] Actual AWS SDK HTTP transport tested against a local S3 fixture, including file streaming and conditional rejection.
- [x] Private bucket and scoped credentials configured manually (user reported complete).
  GitHub secret names verified on 2026-10-10; permissions and values await the real mirror test.
- [ ] `v0.1.25` mirrored and all five R2 objects verified by the tool.
- [ ] Same-version rerun verifies existing bytes without replacement.
- [ ] Current deployed stable manifest unchanged by mirroring.
- [ ] `RELEASES` binding configured with the Phase 7b Worker deployment.

Record the successful workflow run URL or local validation date here once
performed. Production remains on GitHub redirects until Phases 7b/7c.
