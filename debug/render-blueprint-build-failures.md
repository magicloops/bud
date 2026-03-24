# Debug: render-blueprint-build-failures

## Environment

- Render Blueprint deploy attempted on March 24, 2026
- Blueprint source: `render.yaml` at repo root
- Service root directory: `service`
- Web root directory: `web`
- Shared build command in the Blueprint: `corepack enable && pnpm install --frozen-lockfile && pnpm build`
- Web publish directory in the Blueprint at time of failure: `web/dist`
- Node runtime pinned in the Blueprint: `22.12.0`
- Render's native-runtime docs now list `pnpm` as available in both build and deploy environments

## Repro Steps

1. Create or sync the Render Blueprint from `render.yaml`.
2. Let Render build the `bud-service` web service.
3. Observe the build fail before `pnpm install` completes with a Corepack signature-verification error.
4. Let Render build the `bud-web` static site.
5. Observe the Vite build succeed, then the deploy fail when Render tries to publish `web/dist`.

## Observed

### Service failure

- Render starts the configured build command:

```text
corepack enable && pnpm install --frozen-lockfile && pnpm build
```

- The build fails inside bundled Corepack before project dependencies are installed:

```text
Error: Cannot find matching keyid: {"signatures":[...],"keys":[...]}
```

- The failing stack originates from the Node `22.12.0` Corepack bundle at:

```text
/opt/render/project/nodes/node-22.12.0/lib/node_modules/corepack/dist/lib/corepack.cjs
```

### Web failure

- The same build command runs.
- Vite completes successfully and emits assets into `dist/`.
- Render then fails during the publish step with:

```text
Publish directory web/dist does not exist!
```

- The web log also includes a large-chunk warning from Vite, but the build itself succeeds.

## Expected

- `bud-service` should bootstrap pnpm deterministically and finish its install/build steps.
- `bud-web` should publish the `dist/` directory that Vite just produced.
- The Blueprint should not rely on path assumptions that contradict Render's monorepo/root-directory rules.

## Findings

### 1. The service failure is a Blueprint bootstrap bug, not a Bud app-build failure

- The Blueprint explicitly runs `corepack enable` before every install.
- The failure stack originates from bundled Corepack, not from pnpm itself and not from Bud build tooling.
- Render's current native-runtime docs list `pnpm` as a built-in tool in both build and deploy environments.
- That means Bud does not need Corepack just to invoke `pnpm` on Render.
- The exact error matches the known Corepack key-id mismatch failure mode that occurs when registry signing keys and the bundled Corepack key set drift.

References:

- [Render Native Runtimes](https://render.com/docs/native-runtimes)
- [Node.js Corepack docs](https://nodejs.org/download/release/v20.9.0/docs/api/corepack.html)
- [nodejs/corepack issue #612](https://github.com/nodejs/corepack/issues/612)

Inference:

- The current `bud-service` failure is happening before Bud code or TypeScript compilation becomes relevant.
- On Render, the immediate fix is to stop invoking Corepack in the Blueprint and call `pnpm` directly.
- Package-manager pinning may still be worth adding later for cross-environment repeatability, but it is not required to explain or unblock the current Render failure.

### 2. The web failure is a Blueprint path bug in our current implementation

- `render.yaml` sets `rootDir: web` for `bud-web`.
- The web build log shows Render running inside `/opt/render/project/src/web`.
- Vite writes output to `dist/` under that root directory.
- Render's monorepo support docs state that `buildCommand`, `startCommand`, `preDeployCommand`, and `staticPublishPath` are all relative to the service root directory once `rootDir` is set.
- Our current Blueprint sets `staticPublishPath: web/dist`, which is correct only if paths were still repo-root-relative.
- Given Render's documented behavior and the observed log location, the publish directory should be `dist`, not `web/dist`.

Reference:

- [Render Monorepo Support](https://render.com/docs/monorepo-support)

Inference:

- The `bud-web` failure is a direct config bug in the current Blueprint, not a Vite build failure.

### 3. The Vite chunk warning is not the blocking problem

- The web log shows `vite build` completing successfully.
- The failure happens after artifact generation, during Render's publish-directory lookup.
- The large-chunk warning should be tracked separately as optimization debt, but it is not the reason the current deploy is failing.

## Hypotheses

- Primary hypothesis for `bud-service`: removing `corepack enable` from the Render build command will bypass the failing Corepack path and let Render's native `pnpm` installation handle the build.
- Secondary hypothesis for `bud-service`: package-manager pinning can remain follow-up hardening rather than part of the immediate Render unblock.
- Primary hypothesis for `bud-web`: changing `staticPublishPath` to `dist` will unblock the publish step immediately.
- Secondary hypothesis: once both services use direct `pnpm` commands and root-relative paths, the Blueprint should match Render's documented monorepo behavior without provider-specific workarounds.

## Proposed Fix

- Update `render.yaml` for both services so the build command calls `pnpm` directly instead of invoking Corepack first.
- Update `render.yaml` for `bud-web` so `staticPublishPath` is relative to `rootDir`, not repo root.
- Retry the Blueprint sync after those two config fixes.

Follow-up hardening to evaluate separately:

- add explicit package-manager pinning to repo metadata for local/CI consistency if we want stricter cross-environment reproducibility

Do not treat the web publish-path failure and the service Corepack failure as the same bug. They are separate issues that happen to appear in the same Blueprint rollout.

## Open Questions

- Which pnpm version do we want to standardize on across local development, CI, and any future non-Render deploy target?
- Do we want package-manager metadata duplicated per package, or introduced in a repo-level wrapper if the monorepo grows?
- Do we want to treat Render's native `pnpm` path as staging-only, or make it the baseline deploy assumption across environments?

## Spec Files Affected

- `bud.spec.md`
- `service/service.spec.md` if the service build bootstrap changes
- `web/web.spec.md` if the static-site publish contract changes
