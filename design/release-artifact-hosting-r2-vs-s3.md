# Release Artifact Hosting: Cloudflare R2 vs AWS S3

**Status**: Recommendation
**Created**: 2026-05-30
**Context**: `https://get.bud.dev` installer and Bud daemon release artifacts

## Recommendation

Use **Cloudflare R2 behind a dedicated Cloudflare Worker on
`https://get.bud.dev`** for v1 Bud daemon release artifacts.

Keep AWS S3 + CloudFront as the fallback if we later need AWS-native release
governance, deeper IAM/OIDC controls, multi-region replication policy, or a
broader AWS artifact pipeline. Do not serve release binaries from Render except
as an emergency/manual fallback.

This fits Bud's current infrastructure shape:

- `bud.dev` DNS already lives in Cloudflare.
- We already operate Cloudflare Workers for front-door routing.
- The release files are immutable, public, and potentially bandwidth-heavy.
- The installer needs a simple stable origin, not app-server behavior.
- Render should keep serving the application/API, not binary download traffic.

## Target Shape

```text
get.bud.dev
  Worker: get-bud-dev
    /install.sh                         -> Worker static asset or generated response
    /releases/stable/manifest.json      -> R2 object, short cache / revalidate
    /releases/vX.Y.Z/*.tar.gz           -> R2 object, immutable cache
    /releases/vX.Y.Z/*.json             -> R2 object, immutable cache

R2 bucket:
  bud-releases-prod
```

Prefer a Worker in front of a private R2 bucket over direct public `r2.dev`
access. Cloudflare documents `r2.dev` public buckets as non-production and
rate-limited, while custom domains/Workers let us use cache, WAF, access
controls, bot management, redirects/rewrites, and analytics.

The Worker should:

- allow only `GET` and `HEAD`
- serve only known release path prefixes
- set `Cache-Control: public, max-age=31536000, immutable` on versioned archives
- set short TTL or revalidation headers on `/releases/stable/manifest.json`
- set a shell content type for `/install.sh`
- preserve range requests for archive downloads if Cloudflare/R2 support is
  acceptable in validation
- return `404` for unknown paths instead of listing objects
- log version, target, status, and cache/origin result

## Why R2 First

### Pros

- **Lowest expected bandwidth risk**: R2 charges storage and operations, with no
  egress bandwidth charge for standard object downloads. For public release
  binaries, egress is the risk dimension that can grow unexpectedly.
- **Operational fit**: We already use Cloudflare DNS and Workers. `get.bud.dev`
  can live in the same control plane as the current `bud.dev` edge routing.
- **Simple domain story**: `get.bud.dev` is a Cloudflare-managed subdomain;
  Worker routing plus R2 binding avoids a second CDN/DNS control plane.
- **Good cache/security knobs at the edge**: WAF, bot controls, cache rules,
  access controls for non-public future channels, redirects, rewrites, and
  analytics are available when R2 is accessed through Cloudflare-controlled
  domains.
- **S3-compatible publishing path**: CI can upload via Wrangler, rclone, or
  S3-compatible tooling. Our Phase 3 workflow already emits the exact files to
  upload.
- **Clear separation from Render**: Release downloads do not consume Render
  outbound bandwidth or affect app/API capacity.

### Cons / Risks

- **Cloudflare becomes more critical**: DNS, existing Workers, and release
  hosting would share one provider. A Cloudflare outage or account incident can
  affect installs and app routing at the same time.
- **Credential model is less ideal than AWS OIDC**: Cloudflare's GitHub Actions
  path normally uses a scoped API token/account id. AWS has a mature GitHub OIDC
  story for avoiding long-lived CI secrets.
- **R2 is not S3**: It is S3-compatible for common object operations, but the
  ecosystem, lifecycle controls, replication patterns, and compliance tooling
  are not as deep as AWS S3.
- **Need validation for binary-serving details**: Verify range requests,
  content headers, cache behavior for stable vs immutable paths, and large-file
  behavior before public launch.
- **Public bucket foot-guns**: Do not rely on `r2.dev` or accidentally leave it
  enabled for production buckets.

## AWS S3 + CloudFront Option

S3 + CloudFront is the conservative enterprise object-storage answer.

### Pros

- **Mature object storage**: S3 has deep durability, lifecycle, replication,
  inventory, IAM, CloudTrail, and ecosystem support.
- **Excellent CI auth story**: GitHub Actions can assume AWS roles through OIDC
  without storing long-lived AWS credentials.
- **CloudFront is a full CDN/security edge**: It gives TLS, caching, WAF/DDoS
  integrations, logs, origin access controls, and origin shielding patterns.
- **Good fit if release infra moves AWS-native**: If we later run production API
  services, signing, provenance, artifact promotion, or audit pipelines in AWS,
  S3 becomes more compelling.
- **Render adjacency can help upload paths**: Render currently runs on AWS, and
  Render documents same-region traffic to S3/GCS differently from ordinary
  public outbound bandwidth. This mostly matters if Render ever becomes an
  artifact publisher, not for GitHub Actions release publishing.

### Cons / Risks

- **More moving parts for `get.bud.dev`**: S3 alone does not provide HTTPS for
  website endpoints; the HTTPS path means CloudFront, ACM certificate handling,
  bucket policy/origin access controls, and DNS validation.
- **Cost model is more dimensional**: S3 has storage, request, retrieval, and
  data transfer components. CloudFront has its own request/data transfer plan or
  pay-as-you-go model. It can be cheap, but it is less obvious than R2 for
  public binary downloads.
- **Cloudflare + CloudFront can be awkward**: Since DNS is in Cloudflare, a
  proxied Cloudflare DNS record in front of CloudFront creates a CDN-on-CDN
  setup. We can use DNS-only CNAME to CloudFront, but then `get.bud.dev` leaves
  the Cloudflare edge/security model we already operate.
- **Cross-provider debugging**: Cache invalidation, TLS, redirects, and headers
  split across Cloudflare DNS and AWS CDN/origin resources.

## Render Option

Render should not be the primary release artifact host.

### Pros

- Very simple operationally because we already use Render.
- Render static sites provide a CDN, custom domains, HTTPS redirects, custom
  headers, immediate cache invalidation, DDoS protection, Brotli, and HTTP/2.
- Could host a small static landing page or emergency fallback `install.sh`.

### Cons / Risks

- Render outbound bandwidth is metered beyond included workspace amounts. Binary
  release traffic can spike independently of app traffic.
- Render static sites are deploy-oriented, not an object-store/release-channel
  primitive with immutable artifact promotion.
- Serving binaries through the app/API path risks coupling install availability
  to web/service deploys and Render capacity.
- No S3-compatible artifact publication contract for our Phase 3 outputs.

## Other Options Considered

### Cloudflare Pages / Workers Static Assets

Good for `/install.sh` and a simple human landing page. Not ideal for versioned
multi-platform binary archives. Use R2 for artifacts and optionally Workers
Static Assets for the installer shell script.

### GitHub Releases

Useful as an internal backup/download source, but not the canonical installer
origin. It adds GitHub availability/rate-limit/product-UX constraints and makes
`get.bud.dev` a redirect layer rather than a controlled artifact channel.

### Multi-Origin Redundancy

Worth considering later:

- primary: R2
- mirror: S3 or GitHub Releases
- manifest includes primary and mirror URLs
- installer retries mirror only after checksum verification failure or transport
  failure

Do not add this to v1 unless validation shows meaningful install reliability
risk. It increases manifest semantics and support complexity.

## Concrete V1 Plan

1. Create `bud-releases-prod` R2 bucket.
2. Bind it to a `get-bud-dev` Worker.
3. Route `get.bud.dev/*` to that Worker.
4. Keep the bucket private; do not use `r2.dev` for production.
5. Publish Phase 3 workflow outputs into R2:
   - `/releases/vX.Y.Z/bud-aarch64-apple-darwin.tar.gz`
   - `/releases/vX.Y.Z/bud-x86_64-apple-darwin.tar.gz`
   - `/releases/vX.Y.Z/bud-x86_64-unknown-linux-gnu.tar.gz`
   - `/releases/vX.Y.Z/*.json`
   - `/releases/stable/manifest.json`
6. Add `/install.sh` in Phase 4 as a Worker static asset or generated Worker
   response.
7. Use a narrow Cloudflare API token in GitHub Actions for publishing until a
   better short-lived credential path is available.
8. Add validation:
   - `curl -I https://get.bud.dev/releases/stable/manifest.json`
   - checksum verified archive download
   - cache headers match stable vs immutable paths
   - invalid path cannot list bucket contents
   - `r2.dev` access disabled
   - large archive download and resume/range behavior checked

## Decision Table

| Criterion | R2 + Worker | S3 + CloudFront | Render |
|-----------|-------------|-----------------|--------|
| Fits current DNS/edge setup | Strong | Medium | Medium |
| Public binary egress cost risk | Low | Medium | High |
| CI credential hygiene | Medium | Strong | Medium |
| Object-storage maturity | Medium | Strong | Weak |
| Setup complexity for `get.bud.dev` | Low | Medium/High | Low |
| Cache/security controls | Strong | Strong | Medium |
| Keeps app/API isolated from downloads | Strong | Strong | Weak/Medium |
| Good long-term artifact channel | Strong | Strong | Weak |

## Open Questions

- Which Cloudflare account/project should own `get.bud.dev` and the release
  bucket?
- Do we want production releases published automatically on `v*` tags, or should
  CI produce artifacts and require manual promotion to R2?
- Should the stable manifest be mutable by CI directly, or should promotion copy
  a tested manifest into `/releases/stable/manifest.json`?
- Do we need a separate `canary` manifest before public launch?
- What is the exact cache purge/promotion procedure if a manifest is published
  incorrectly?
- Do we want S3 or GitHub Releases as a disaster-recovery mirror before public
  launch?

## Sources Checked

- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 public buckets and custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2 platform limits](https://developers.cloudflare.com/r2/platform/limits/)
- [Cloudflare R2 object uploads](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [AWS S3 pricing](https://aws.amazon.com/s3/pricing/)
- [AWS S3 static website custom domain docs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/website-hosting-custom-domain-walkthrough.html)
- [AWS CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)
- [GitHub Actions OIDC for AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [Render static sites](https://render.com/docs/static-sites)
- [Render outbound bandwidth](https://render.com/docs/outbound-bandwidth)
