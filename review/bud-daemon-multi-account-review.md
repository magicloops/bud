# Review: Bud Daemon Non-Global State for Local Multi-Account Testing

## Conclusion

The current codebase already supports running Bud without `~/.bud`, but not by simply starting the daemon from another shell directory. Persistent daemon state is controlled by explicit flags and env vars, not by process cwd.

The workable setup today is:

- use a unique directory per local Bud instance
- point `--identity-file` at `<instance-dir>/identity.json`
- point `--terminal-base-dir` at `<instance-dir>`
- give each instance a distinct `--name`

Example:

```bash
ACCOUNT_ROOT="$PWD/.bud-instances/account-a"

cargo run --manifest-path bud/Cargo.toml -- \
  --server ws://localhost:3000/ws \
  --name account-a-local \
  --terminal-enabled \
  --identity-file "$ACCOUNT_ROOT/identity.json" \
  --terminal-base-dir "$ACCOUNT_ROOT"
```

Use a different `ACCOUNT_ROOT` for each account.

Running a copied Bud binary from another directory is still a good workflow for the team, but the isolation comes from the wrapper script setting `--identity-file` and `--terminal-base-dir` relative to that directory.

## Findings

### 1. Changing the shell cwd does not relocate Bud state

- The daemon defaults `--identity-file` to `~/.bud/identity.json` and `--terminal-base-dir` to `~/.bud`, independent of the directory you launch it from (`bud/src/main.rs:63-80`, `bud/src/main.rs:2299-2310`).
- Startup only consults the current process directory as a fallback for the command execution cwd, not for daemon state storage (`bud/src/main.rs:2301-2303`).

### 2. Current code already has the right knobs

- `--identity-file` / `BUD_IDENTITY_FILE` relocates persisted auth state (`bud/src/main.rs:66-71`).
- `--terminal-base-dir` / `BUD_TERMINAL_BASE_DIR` relocates terminal logs under `<base>/sessions/.../terminal.log` (`bud/src/main.rs:79-80`, `bud/src/main.rs:1515-1517`).
- `bud/.env.example` already exposes both settings (`bud/.env.example:8-10`).

### 3. Separate parent directories are required, not just separate identity filenames

- `installation-id` is not independently configurable. It is always derived as `identity_path.parent()/installation-id` (`bud/src/main.rs:2299-2300`, `bud/src/main.rs:3026-3030`).
- If two daemon instances use different identity filenames in the same directory, they still share the same `installation-id`.
- That matters because the claim flow requires `installation_id` (`service/src/routes/device-auth.ts:15-21`, `service/src/routes/device-auth.ts:84-94`), the Bud table enforces a unique index on `installation_id` (`service/src/db/schema.ts:30-59`), approval reuses or conflicts on the existing `installation_id` (`service/src/routes/device-auth.ts:213-233`), and returning Bud auth rejects mismatched installation IDs (`service/src/ws/gateway.ts:611-624`).
- Practical consequence: use per-account directories like `.bud-instances/account-a/` and `.bud-instances/account-b/`, not two identity files in the same folder.

### 4. Overriding only the identity file is incomplete if the goal is "do not use ~/.bud"

- If you change only `--identity-file`, terminal logs still default to `~/.bud` unless `--terminal-base-dir` is also changed (`bud/src/main.rs:79-80`, `bud/src/main.rs:2307-2310`, `bud/src/main.rs:1515-1517`).
- The current codebase supports non-global state, but it takes two settings instead of a single state-root flag.

### 5. Tmux is still machine-global

- All tmux operations use bare `tmux ...` commands; there is no per-daemon `-L` or `-S` socket selection in the daemon (`bud/src/main.rs:1531-1559`, `bud/src/main.rs:1582-1589`).
- Session names are derived from the service session id and truncated to 32 characters (`bud/src/main.rs:2206-2217`).
- For ordinary local multi-account testing this should generally be workable, but it is not hard isolation at the tmux-server level.

### 6. The code supported this workflow before the docs did

- The daemon behavior has been stable in code: identity state is configurable, terminal log state is separately configurable, and `installation-id` follows the identity file's parent directory.
- This documentation pass adds the missing operational guidance to `bud/README.md`, `bud/bud.spec.md`, and `bud/src/src.spec.md` so new developers can discover the workflow without reading `main.rs`.

## Recommended Current Workflow

1. Create one directory per local test account.
2. Set `BUD_IDENTITY_FILE="$DIR/identity.json"`.
3. Set `BUD_TERMINAL_BASE_DIR="$DIR"`.
4. Set a distinct `BUD_DEVICE_NAME` per instance.
5. Run both daemons in parallel against the same service.

Example env-based launcher:

```bash
ACCOUNT_ROOT="$PWD/.bud-instances/account-a"

export BUD_SERVER_URL=ws://localhost:3000/ws
export BUD_DEVICE_NAME=account-a-local
export BUD_IDENTITY_FILE="$ACCOUNT_ROOT/identity.json"
export BUD_TERMINAL_BASE_DIR="$ACCOUNT_ROOT"
export BUD_TERMINAL_ENABLED=true

cargo run --manifest-path bud/Cargo.toml --
```

Repeat with a different `ACCOUNT_ROOT` and device name for each additional account.

## Build/Copy/Run Workflow

If you want the instance directory itself to be the obvious isolation boundary for new developers, build once, copy the Bud binary into per-account directories, and run it through a wrapper script that anchors all persistent state to `$(dirname "$0")`.

### Build Once

```bash
cd bud
cargo build
```

This produces `target/debug/bud`.

### Example Instance Layout

```text
$HOME/.bud-dev/
  account-a/
    bud
    run.sh
  account-b/
    bud
    run.sh
```

### Copy Binary Into Instance Directories

```bash
cd bud
mkdir -p "$HOME/.bud-dev/account-a" "$HOME/.bud-dev/account-b"
cp target/debug/bud "$HOME/.bud-dev/account-a/bud"
cp target/debug/bud "$HOME/.bud-dev/account-b/bud"
chmod +x "$HOME/.bud-dev/account-a/bud" "$HOME/.bud-dev/account-b/bud"
```

### Example `run.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/bud" \
  --server "${BUD_SERVER_URL:-ws://localhost:3000/ws}" \
  --name "${BUD_DEVICE_NAME:-$(basename "$SCRIPT_DIR")}" \
  --identity-file "$SCRIPT_DIR/identity.json" \
  --terminal-base-dir "$SCRIPT_DIR" \
  --terminal-enabled
```

That wrapper keeps the instance's durable state together:

- credentials at `$SCRIPT_DIR/identity.json`
- installation identity at `$SCRIPT_DIR/installation-id`
- terminal logs under `$SCRIPT_DIR/sessions/`

### Example `make-bud-instance.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail

INSTANCE_NAME="${1:?usage: $0 <instance-name> [dest-root]}"
DEST_ROOT="${2:-$HOME/.bud-dev}"
INSTANCE_DIR="$DEST_ROOT/$INSTANCE_NAME"

cd bud
cargo build

mkdir -p "$INSTANCE_DIR"
cp target/debug/bud "$INSTANCE_DIR/bud"
chmod +x "$INSTANCE_DIR/bud"

cat > "$INSTANCE_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

exec "$SCRIPT_DIR/bud" \
  --server "${BUD_SERVER_URL:-ws://localhost:3000/ws}" \
  --name "${BUD_DEVICE_NAME:-$(basename "$SCRIPT_DIR")}" \
  --identity-file "$SCRIPT_DIR/identity.json" \
  --terminal-base-dir "$SCRIPT_DIR" \
  --terminal-enabled
EOF

chmod +x "$INSTANCE_DIR/run.sh"
echo "Created $INSTANCE_DIR"
```

Example usage:

```bash
./make-bud-instance.sh account-a
./make-bud-instance.sh account-b
```

If you are testing two different human accounts on one machine, approve each Bud from a different browser profile or otherwise separate authenticated browser session.
