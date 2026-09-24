# Debug: browser workspace lifecycle (REPL Phase 8)

Current policy: automatic 24-hour idle expiry, no fixed workspace count cap. The
initial policy/results below are historical; the revision and final validation at
the end supersede manual capacity management.

## Environment and observations
macOS development checkout after Phase 7g. Admission counts every non-closed
Slot, including unsuccessful launch/ensure allocations. Close signals active
cells but does not reset an idle worker immediately. Service cleanup already
handles explicit close, deleted threads and changed ownership.

## Policy and ownership
The ten-workspace cap bounds resident or in-flight thread workspaces. An allocated
identity with no browser handle, REPL worker or in-flight consumer does not consume
resident capacity. Admission/re-admission reserves capacity under the existing map
mutex. Identity/sequence fences remain until their request deadlines expire.
Live browser handles count even with zero tabs: neither that nor viewer dismissal
proves that the REPL, recovery hints or private work can be discarded. No eviction,
idle scheduler, new route or database model.

Explicit workspace close stops the REPL and removes its temporary artifacts as
well as closing its tabs and forgetting that workspace's URL hints. Profile/sign-ins
and other threads survive. Existing viewer resolution and owner-authorized close
route remain unchanged. Capacity guidance points to that existing control in an
unused conversation, explaining loss of tabs and REPL memory.

## Validation plan
Failed/unstarted allocation pressure, atomic final-slot competition, re-admission
at capacity, retained empty REPL state, immediate worker release, scope rejection,
existing service deletion/close/recovery tests and mounted viewer controls.
Physical cross-device gates remain explicitly separate from automated checks.

Initial validation corrections: the first cargo command used the repository root
(no Cargo.toml); commands now use --manifest-path bud/Cargo.toml. Compilation then
reported E0063 for retain_until in a second test-only Slot constructor; updated
that fixture with the same retention field as the primary constructor.

## Results

- `cargo test --manifest-path bud/Cargo.toml browser:: --lib -- --test-threads=1`:
  **87 passed, six manual tests ignored** after final edits. Covers fifteen failed
  allocations, retained sequence fences and expiry, re-admission under reserved
  capacity, immediate idle-worker close and active-cell cancellation/late-output
  withholding without a page-lock deadlock.
- With `BUD_BROWSER_EXECUTABLE=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  `BUD_BROWSER_HELPER=/Users/adam/bud/bud/browser-helper/main.mjs` and the managed
  `BUD_BROWSER_NODE=/Users/adam/.bud/browser/node/v24.21.0/node-v24.21.0-darwin-arm64/bin/node`:
  `cargo test --manifest-path bud/Cargo.toml browser:: --lib -- --test-threads=1 --skip browser::addon::`:
  **66 passed, six manual tests ignored**, including concurrent last-slot admission
  and admission after close, Chrome isolation/recovery and real REPL interactions.
  This run preceded the final resource-free re-admission and active-close unit
  regressions and the distinction between identity burst pressure and resident limit.
- `pnpm --dir service build`: passed.
- `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/browser/broker.test.ts src/browser/control.test.ts src/browser/repl.test.ts src/browser/continuation.test.ts src/agent/browser-observation-budget.test.ts`:
  **25 passed**, no skips, using isolated PostgreSQL test schemas.
- Re-ran `BUD_DATA_DB_TEST=1 pnpm --dir service exec node --import tsx --test src/browser/repl.test.ts`
  after adding deleted-thread cleanup assertions: **one passed**. Cleanup retains
  the original owner/thread dispatch bindings and removes active evidence.
- `pnpm --dir web build` and browser feature tests: build passed, **29 tests passed**.
- `git diff --check`: passed.

No running development service/daemon was restarted. Physical web/iPhone capacity,
idle traffic, interruption and matching-stack agent smoke checks remain open in
Phase 8; mobile workspace release still uses desktop web. The user separately
accepted exercised desktop/agent scrolling and deferred mobile scrolling.

Initial exact command failures were `cargo test browser:: --lib -- --test-threads=1`
from the repository root (`could not find Cargo.toml`) and the subsequent
manifest-qualified build (`error[E0063]: missing field retain_until in initializer
of manager::Slot`). Corrected command location and the second test fixture; the
final command above passes. No runtime fallback or compatibility path was added.

## Policy revision: automatic idle expiry

The user rejected manual workspace management. Replace retention-until-explicit-close
with daemon-owned expiry after 24 hours without use. A minute-scale local sweep
must reclaim workers/artifacts and owned tabs even with no new admission. Admitted
operations and active cells/viewers count as use; metadata reads/checkpoint events
must not keep unused workspaces alive. Protect live private control and never
checkpoint private URLs or auto-return authority. Preserve eligible public recovery
URLs and profile/sign-ins; normal ensure restores pages and the next cell gets a
fresh runtime. Idle disposal differs from explicit close (which forgets hints).
Retain request fences and immutable scope checks. Validate expiration boundaries,
active-use exclusion, fresh heap/URL restoration and private checkpoint preservation.

Idle-expiry validation corrections: `cargo test --manifest-path bud/Cargo.toml
idle_expiry --lib` first found the second Slot fixture missing last_used (E0063),
then a test expected quoted text while REPL string results are unquoted. Corrected
both fixtures. Live `live_idle_expiry` initially observed an unsettled URL after
Page.navigate acknowledgement (unavailable/empty rather than the fixture URL).
The regression now waits for explicit target-URL settlement before checkpointing
and after restoration, instead of assuming navigation acknowledgement means load
completion. No production sleep or navigation replay was added.

Also removed the separate 32-workspace hint count: it would otherwise become the
next count limit after removing the resident cap. The existing 256 KiB total and
16 pages/workspace limits remain. Hint persistence failure retains old checkpoints
and permits resource expiry, avoiding permanent idle-process leaks.

## Final automatic-expiry validation

The user explicitly confirmed removal of the fixed cap in favor of 24-hour idle
expiry. Active browser operations/cells/viewers and live private control prevent
expiry; admitted operation completion refreshes the monotonic last-use timestamp.
The local sweep runs every minute, so idle resources become eligible at 24 hours
and are released on the next unblocked sweep. Public URL recovery is best-effort;
profile/sign-ins remain untouched. REPL memory is recreated rather than restored.

- `cargo test --manifest-path bud/Cargo.toml browser:: --lib -- --test-threads=1`:
  **91 passed, six manual tests ignored**.
- `cargo check --manifest-path bud/Cargo.toml`: passed.
- `pnpm --dir service build`: passed.
- `pnpm --dir service exec node --import tsx --test src/agent/browser-observation-budget.test.ts`:
  one passed. Removed the now-obsolete manual-capacity guidance test.
- `pnpm --dir web build`: passed (existing large-chunk advisory).
- `pnpm --dir web exec tsx --tsconfig tsconfig.app.json --test src/features/browser/*.test.tsx`:
  19 mounted tests passed.
- `git diff --check`: passed.

New coverage includes the expiry boundary, renewed lifetime for active holders,
fresh heap/reset metadata, preserved request fences, complete restored URLs,
private checkpoint isolation, more than ten admitted workspaces, and forty saved
workspace checkpoints with byte-bound rollback. No daemon/service restart, commit
or deployment was performed. A rebuilt daemon restart enables the new lifecycle.
Physical/device final-merge checks remain open.

Final live Chrome rerun with the executable/helper/managed-Node environment above:
`cargo test --manifest-path bud/Cargo.toml browser:: --lib -- --test-threads=1 --skip browser::addon::`:
**71 passed, six manual tests ignored**. The complete rerun includes the corrected
navigation-settlement fixture and all final production changes.
