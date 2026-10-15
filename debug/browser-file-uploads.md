# Debug: Chat files and browser upload validation

## Environment
- macOS local development; branch `browserfileupload`, based on `browserview`.
- Local service, PostgreSQL, web and Rust daemon; existing browser profiles kept.

## Build observations
- `pnpm add @aws-sdk/client-s3 mammoth pdfjs-dist` in `service/` installed the
  requested dependencies but exited 1 with `ERR_PNPM_IGNORED_BUILDS`:
  `Ignored build scripts: esbuild@0.18.20, esbuild@0.25.12, protobufjs@7.5.5`.
  Package manifests/lockfile were written. Existing executables and the new PDF
  reader are checked before allowing any additional build scripts.
- Direct import of `pdfjs-dist/legacy/build/pdf.mjs` succeeds locally. Version
  6.4.299 requires Node >=22.13.0 or >=24; the deployment runtime must be updated
  from its current 22.12.0 pin as part of this change.

## Validation
- Local implementation is ready for user testing; production storage is not
  provisioned or tested. The user has requested the two stacked PRs; deployment
  remains pending.
- Service and web builds pass. The focused service suite passed 49/49 tests;
  the final upload suite, including the added DOCX fixture, passed 5/5 tests.
  Tests cover ownership, library search/pagination, original byte integrity,
  document reading, one-use transfer grants and context accounting.
- The real Chrome helper fixture passed: hidden and iframe file inputs retain
  exact original bytes, reject stale targets, and do not submit the form.
  The Rust live transfer test also passed against Chrome; the daemon was rebuilt
  and restarted without clearing its browser profile.
- Signed-in acceptance in `Local Resume Upload Test` succeeded. A synthetic
  library PDF was selected through the composer, read by Bud, and attached to
  the local form at `http://127.0.0.1:8765`. Bud filled Alex Example and
  alex@example.test. The page reported the original filename, 628 bytes and
  SHA-256 `710414b62e23bb2c0320a1eaf0633a856c893616954c7a53a07d81b48d438c8a`.
  Nothing was submitted and no external application website was used.
- The acceptance file was seeded through the backend. Automated selection in
  the chat's native file picker was blocked by the testing extension's file
  access permission, so a fresh upload through that picker remains a manual
  user acceptance step. HTTP uploads were exercised by the integration suite.
- Production follow-up: provision the declared Render persistent disk, apply
  migrations 0053/0054 and verify persistence after restart. The Blueprint now
  pins the service to Node 22.23.2.

## Plan
- [Upload and reusable library](../plan/browser-file-library.md).

- `pnpm db:generate` and `pnpm db:push` initially reported `Cannot find module
  ../uploads/schema.js`: Drizzle's CommonJS schema loader does not map ESM `.js`
  imports to `.ts`. Kept the table declaration in the existing single-file schema.

- `pnpm db:push` proposed an unrelated unique-constraint replacement on a table with 15 rows. Canceled at the confirmation prompt; no rows truncated. Reviewed and applied only generated `0053_fancy_sersi.sql` transactionally to the local database.
- `pnpm --dir web build` found TS2322 on optional attachment blocking state. Coerced the optional value to boolean.
- Service compilation exposed a file-tool discriminated-union narrowing issue;
  separate literal directives for files_read and files_search resolved it.
- PDF.js 6 exposes the document through the loading task's promise; the worker
  now awaits that promise and destroys the loading task during cleanup.

## Persistent disk follow-up

The user selected Render disk storage instead of an external bucket. Current
production rejects all local storage; merely pointing at a normal Render folder
would lose files on restart. The existing copy operation also publishes directly
to the final pathname and has no volume-capacity reservation.

Proposed fix: explicit verified persistent mount, private atomic disk writes,
bounded free-space reservation, stale staging cleanup, and the matching Render
disk declaration. Keep existing authorization and immutable file IDs. Validate
locally without provisioning paid resources or deploying the branch.

Implemented and validated locally:
- `pnpm build` in service/: passed with Node 22.23.2.
- `BUD_UPLOAD_DB_TEST=1 pnpm exec node --import tsx --test src/uploads/objects.test.ts src/uploads/uploads.test.ts`:
  12/12 passed, none skipped. Includes real local Postgres/HTTP owner checks,
  document reading and browser transfer, plus atomic filesystem publication,
  persisted bytes after reopening, permissions, canceled/failed writes, staging
  expiry, mount rejection and concurrent capacity reservations.
- Render YAML parses; disk/mount/directory, one instance, runtime and migration
  settings agree. No Render API validation or provisioning was performed.
- Local running service `/readyz` remains healthy after the storage update.
- Removed @aws-sdk/client-s3 and 26 dependency packages. Existing local file IDs
  and their storage directory remain usable.
- Linux mount evidence is covered by fixtures and absent-mount rejection; actual
  Render mount verification and restart acceptance remain deployment checks.

The code and Blueprint are ready for user review/testing. No disk was provisioned,
and no external storage credentials were created. The user subsequently requested
two stacked PRs; production deployment remains pending.

`pnpm exec eslint src/uploads/objects.ts src/uploads/objects.test.ts src/uploads/routes.ts`
initially found `routes.ts:57:96 'reply' is defined but never used` and missing
public return-type warnings. Removed the unused argument and added return types.

## PR split validation

The uploads-only checkout is validated separately from the library extension.
`pnpm --dir /tmp/bud-pr-upload-20261015/service build` and the initial web
`pnpm run build` triggered pnpm 12 dependency verification and stopped with
`ERR_PNPM_IGNORED_BUILDS` for already-installed esbuild/protobufjs scripts.
No build-script approvals were changed; run the installed TypeScript/Vite
executables directly for the isolated checkout.

The first uploads-only HTTP fixture failed inserting a user message because the
fixture omitted required `message.client_id`; add a random client ID to the test
message. This fixture attaches the file before exercising reads/transfers; the
library branch additionally covers access without a current-chat attachment.

The isolated service TypeScript check passed after the fixture correction. An
extra `node scripts/copy-proto.mjs` command failed with `MODULE_NOT_FOUND` because
this project has no such script; running the package.json postbuild command
correctly copied prompt/worker assets. The web TypeScript/Vite build passed
(with the existing chunk-size warning), and the uploads-only storage/upload/model
suite passed 27/27 with the local database enabled and no skipped tests.
