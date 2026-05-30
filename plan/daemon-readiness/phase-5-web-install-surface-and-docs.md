# Phase 5: Web Install Surface And Docs

## Objective

Expose the production install flow to users through the web app and documentation.

The web app should show the right command for the user's context, explain host capabilities honestly, and preserve QR/link fallback.

## User-Facing Surfaces

### Public docs/main page

Show the tokenless install command:

```bash
curl -fsSL https://get.bud.dev/install.sh | sh
```

Explain:

- supported operating systems
- tmux requirement
- how claim approval works through QR/link auth
- install path
- service behavior
- uninstall command

### Authenticated web app

The add-device flow should call the service to create a 10 minute install claim and display the service-generated command.

The web client must not assemble the bearer-bearing command itself.

States to handle:

- creating install claim
- command ready
- claim redeemed
- claim expired
- claim canceled if supported
- daemon already claimed or incompatible local identity
- QR/link fallback
- missing tmux reported by installer/daemon if surfaced later

### Capability disclosure

Before users approve or generate the install flow, disclose:

- Bud can run terminal commands as the local OS user
- terminal support requires tmux
- Bud may expose terminal output to the authenticated Bud service/user
- file viewing can read from the configured workspace/root when enabled
- localhost proxying can expose local web apps through Bud-controlled routes when enabled

Keep this concise and product-facing, not a legal wall.

## Ownership And Authorization

The web install surface must use authenticated APIs that are owner-scoped:

- create claim as current user
- read claim state only for current user
- stream or poll claim state only after auth
- another user's claim is `404`
- unauthenticated access is `401`

If live claim-status streaming is added, authorize before attaching listeners or replaying buffered events.

## Command Generation

The service response should provide:

- `install_command`
- `public_install_command`
- `expires_at`
- `claim_id` only if needed for polling/status
- `status`

The web UI should render exactly the service-provided command, with copy affordances and expiration messaging.

## Docs

Add or update user/operator docs for:

- install
- upgrade
- uninstall
- service status/restart
- missing tmux
- supported platforms
- foreground/dev mode
- local/workspace mode caveat
- Homebrew follow-up status if mentioned publicly

Developer docs should separately document:

- running multiple Buds locally with `--local`
- overriding `--base-dir`
- using staging or localhost service URLs

## Expected Files And Areas

- `web/src/routes/`
- `web/src/components/`
- `web/src/lib/`
- `service/src/routes/` if API response shape needs final polish
- `bud/README.md`
- root README or docs files if present
- product docs source if checked into this repo

## Tests

Service:

- generated command contains the expected host and env variable
- generated command never includes `device_secret`
- expiration state is represented consistently

Web:

- authenticated add-device flow displays generated command
- expired claim state is visible
- QR fallback is reachable
- unauthenticated users are redirected/sign-in gated as appropriate
- copy text matches service response exactly

Manual:

- public docs command path works with QR/link approval
- authenticated command path redeems without second approval
- missing tmux instructions are understandable from the user-facing flow

## Spec Files To Update

- `web/web.spec.md`
- `web/src/src.spec.md`
- relevant `web/src/routes/*.spec.md`
- relevant `web/src/components/*.spec.md`
- `service/src/routes/routes.spec.md`
- `bud/README.md` if changed
- `bud.spec.md`

## Exit Criteria

- [ ] public docs show the tokenless command
- [ ] authenticated web app shows a service-generated claim command
- [ ] users can tell when the claim expires or has redeemed
- [ ] QR/link fallback remains available
- [ ] capability disclosure is present before install/approval
- [ ] install/update/uninstall/status docs exist
- [ ] web/service tests cover command generation and display
