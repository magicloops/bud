# Debug: Browser control outlives the viewer

## Environment
Web and hosted iOS viewer, service/PostgreSQL, managed Rust daemon. Existing
working tree includes the dedicated screencast experiment and keyboard fixes.

## Reproduction and observations
Take control, dismiss the viewer, then ask the agent to use the browser. Release
removes the memory-only controller but persists private pause. Help requests also
pause before the user acts. Recovery proofs can reacquire after media failure.

## Expected
Agent authority is the default. Only an explicit takeover creates a six-second
human override. Close/background/failure ends it; reopening is view-only. Help
prompts reserve no browser authority. In-flight input must drain before agent
execution, and ambiguous input must never be replayed.

## Approach
Implement [the phased plan](../plan/browser-agent-default/README.md): persist
exact override identity/deadline and retirement reason, independently fence daemon
input, reconcile execution automatically, remove recovery acquisition, and connect
web/native lifecycle endings. Keep ownership and frame/focus authorization.

## Validation
Record focused race, migration, service/daemon and mounted viewer checks as they
run. Physical phone/background and network-loss acceptance remain separate from
automated evidence.

## Implementation and validation — 2026-09-28

Implemented across both repositories. Exact six-second overrides expire locally
and in service admission; close/background/failure retires authority and automatic
End reconciliation drains execution. Help prompts park tasks without a browser lock;
new chat supersedes unanswered tasks. Removed tickets and old return commands.
Specs and protocol now distinguish ownership from execution readiness.

Commands/results (run from the owning package directory):
- service: `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/browser/*.test.ts src/agent/browser-tools.test.ts`: 71 pass, 1 skip.
- service: `BUD_DATA_DB_TEST=1 pnpm exec node --import tsx --test src/browser/control.test.ts src/browser/repository.test.ts src/browser/state-events.test.ts src/agent/browser-tools.test.ts`: 36 pass after final cleanup.
- service: `pnpm exec tsc --noEmit`: pass.
- web: `pnpm exec tsx --tsconfig tsconfig.app.json --test src/features/browser/*.test.tsx src/components/message-renderers/tools/browser-handoff.test.tsx`: 26 pass.
- web: `pnpm exec tsc -b`: pass.
- daemon: browser test run recorded in `/tmp/browser-authority-rust.log`: 98 pass, 11 live-Chrome tests ignored.
- mobile: `xcodebuild -project Bud.xcodeproj -scheme Bud -destination 'platform=iOS Simulator,id=BC8F97A1-47D7-416C-8682-4E4D7D342B9E' -only-testing:BudTests/BrowserVisitTests test`: 13 pass. Simulator build also succeeded.
- Both repositories: `git diff --check`: pass.

Failures encountered and fixed:
- Running package test globs from the repository root produced `zsh: no matches found`; reran in service/web package directories. Root cargo invocation similarly had no Cargo.toml; used bud/.
- Rust removed-control-variant fixtures failed E0599; converted them to End.
- Service `pnpm exec tsc --noEmit`: TS2698 on spreading an unknown capability fixture; replaced with an explicit object. Removed `returned` test helper reference also produced TS2339; replaced it with acknowledgeEnd fixture behavior.
- Old DB fixture lacked override columns (`42703 column r.override_id does not exist`); applied new migrations and exercised the new End handshake.
- Old prompt assertion expected manual Return; updated to automatic return guidance.
- Hidden-view tests expected renewal while hidden and lacked window.location/textarea.blur; fixed browser mocks and asserted one release, no hidden polling/renewal, passive foreground.
- `pnpm db:push` proposed unrelated constraint recreation. Canceled that proposal, generated/reviewed 0044–0047 SQL and applied exact local changes transactionally. No deployed DB changed.

Physical iPhone/local/ngrok and real-Chrome close/background/lock/window cleanup
remain acceptance checks. They are not established by simulator or mocked media.

Final daemon validation: `cargo clippy --bin bud` passed without warnings; changed control/idle modules were rustfmt-formatted.
