#!/bin/sh
set -eu

BASE_URL="${BUD_INSTALL_BASE_URL:-https://get.bud.dev}"
SERVER_URL="${BUD_SERVER_URL:-wss://api.bud.dev/ws}"
INSTALL_ROOT="${BUD_INSTALL_ROOT:-$HOME/.bud}"
BIN_DIR="$INSTALL_ROOT/bin"
BUD_BIN="$BIN_DIR/bud"
IDENTITY_FILE="$INSTALL_ROOT/identity.json"
ENV_FILE="$INSTALL_ROOT/bud.env"
MANIFEST_URL="$BASE_URL/releases/stable/manifest.json"

log() {
  printf '%s\n' "$*" >&2
}

fail() {
  log "error: $*"
  exit 1
}

usage_matrix() {
  cat >&2 <<'EOF'
Supported Bud installer targets:
  macOS 13+ arm64      -> aarch64-apple-darwin
  macOS 13+ x86_64     -> x86_64-apple-darwin
  Linux glibc 2.35+ x86_64 -> x86_64-unknown-linux-gnu
EOF
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

download_file() {
  url="$1"
  dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
    return
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
    return
  fi
  fail "missing required command: curl or wget"
}

sha256_file() {
  file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  fail "missing required command: sha256sum or shasum"
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

write_env_file() {
  mkdir -p "$INSTALL_ROOT"
  {
    printf 'BUD_SERVER_URL=%s\n' "$(shell_quote "$SERVER_URL")"
    printf 'BUD_TERMINAL_ENABLED=true\n'
    printf 'BUD_BASE_DIR=%s\n' "$(shell_quote "$INSTALL_ROOT")"
  } > "$ENV_FILE"
}

version_major_minor_at_least() {
  version="$1"
  min_major="$2"
  min_minor="$3"
  major="$(printf '%s' "$version" | awk -F. '{print $1}')"
  minor="$(printf '%s' "$version" | awk -F. '{print $2}')"
  case "$major:$minor" in
    *[!0-9:]* | :* | *:) return 1 ;;
  esac
  [ "$major" -gt "$min_major" ] || { [ "$major" -eq "$min_major" ] && [ "$minor" -ge "$min_minor" ]; }
}

detect_glibc_version() {
  if [ "${BUD_INSTALL_GLIBC_VERSION:-}" ]; then
    printf '%s\n' "$BUD_INSTALL_GLIBC_VERSION"
    return
  fi
  if command -v getconf >/dev/null 2>&1; then
    getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}'
    return
  fi
  if command -v ldd >/dev/null 2>&1; then
    ldd --version 2>&1 | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+\.[0-9]+/) { print $i; exit } }'
  fi
}

detect_target() {
  os="${BUD_INSTALL_OS:-$(uname -s)}"
  arch="${BUD_INSTALL_ARCH:-$(uname -m)}"

  case "$os:$arch" in
    Darwin:arm64 | Darwin:aarch64)
      macos_version="${BUD_INSTALL_MACOS_VERSION:-$(sw_vers -productVersion 2>/dev/null || printf '')}"
      if ! version_major_minor_at_least "$macos_version" 13 0; then
        usage_matrix
        fail "macOS 13+ is required; detected ${macos_version:-unknown}"
      fi
      printf '%s\n' "aarch64-apple-darwin"
      ;;
    Darwin:x86_64 | Darwin:amd64)
      macos_version="${BUD_INSTALL_MACOS_VERSION:-$(sw_vers -productVersion 2>/dev/null || printf '')}"
      if ! version_major_minor_at_least "$macos_version" 13 0; then
        usage_matrix
        fail "macOS 13+ is required; detected ${macos_version:-unknown}"
      fi
      printf '%s\n' "x86_64-apple-darwin"
      ;;
    Linux:x86_64 | Linux:amd64)
      glibc_version="$(detect_glibc_version || true)"
      if ! version_major_minor_at_least "${glibc_version:-}" 2 35; then
        usage_matrix
        fail "glibc 2.35+ is required; detected ${glibc_version:-unknown}"
      fi
      printf '%s\n' "x86_64-unknown-linux-gnu"
      ;;
    *)
      usage_matrix
      fail "unsupported OS/architecture: $os/$arch"
      ;;
  esac
}

manifest_field_for_target() {
  manifest="$1"
  target="$2"
  field="$3"
  awk -v target="$target" -v field="$field" '
    $0 ~ "\"target\"" {
      in_artifact = index($0, "\"" target "\"") > 0
    }
    in_artifact && $0 ~ "\"" field "\"" {
      line = $0
      sub(/^[^:]*:[[:space:]]*/, "", line)
      gsub(/[",]/, "", line)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", line)
      print line
      exit
    }
  ' "$manifest"
}

verify_checksum() {
  archive="$1"
  expected="$2"
  actual="$(sha256_file "$archive")"
  if [ "$actual" != "$expected" ]; then
    rm -f "$archive"
    fail "checksum mismatch for archive: expected $expected, got $actual"
  fi
}

install_archive() {
  archive="$1"
  tmp_extract="$2"
  mkdir -p "$tmp_extract"
  tar -xzf "$archive" -C "$tmp_extract"
  [ -x "$tmp_extract/bud" ] || [ -x "$tmp_extract/./bud" ] || fail "release archive did not contain executable bud"
  mkdir -p "$BIN_DIR"
  cp "$tmp_extract/bud" "$BUD_BIN"
  chmod 0755 "$BUD_BIN"
}

run_doctor() {
  log "Running Bud preflight..."
  if ! (unset BUD_CLAIM_ID; env BUD_SERVER_URL="$SERVER_URL" BUD_TERMINAL_ENABLED=true BUD_BASE_DIR="$INSTALL_ROOT" "$BUD_BIN" doctor); then
    log "Bud preflight reported issues. Review the messages above, then rerun the installer after resolving them."
  fi
}

bootstrap_bud() {
  if [ "${BUD_INSTALL_SKIP_BOOTSTRAP:-}" = "1" ]; then
    log "Skipping Bud bootstrap because BUD_INSTALL_SKIP_BOOTSTRAP=1."
    log "Start Bud manually with: $BUD_BIN --terminal-enabled"
    return
  fi

  log "Starting Bud in the foreground. Press Ctrl+C to stop it."
  if [ "${BUD_CLAIM_ID:-}" ]; then
    exec env BUD_SERVER_URL="$SERVER_URL" BUD_TERMINAL_ENABLED=true BUD_BASE_DIR="$INSTALL_ROOT" BUD_CLAIM_ID="$BUD_CLAIM_ID" "$BUD_BIN" --terminal-enabled
  fi
  exec env BUD_SERVER_URL="$SERVER_URL" BUD_TERMINAL_ENABLED=true BUD_BASE_DIR="$INSTALL_ROOT" "$BUD_BIN" --terminal-enabled
}

main() {
  need_cmd awk
  need_cmd sed
  need_cmd tar
  need_cmd mktemp

  if [ -f "$IDENTITY_FILE" ] && [ "${BUD_CLAIM_ID:-}" ]; then
    fail "existing Bud identity found at $IDENTITY_FILE; refusing to redeem a new install claim over an existing identity"
  fi

  target="$(detect_target)"
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/bud-install.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

  manifest="$tmp_dir/manifest.json"
  archive="$tmp_dir/bud.tar.gz"
  extract_dir="$tmp_dir/extract"

  log "Downloading Bud release manifest..."
  download_file "$MANIFEST_URL" "$manifest"

  artifact_url="$(manifest_field_for_target "$manifest" "$target" "url")"
  artifact_sha="$(manifest_field_for_target "$manifest" "$target" "sha256")"
  [ "$artifact_url" ] || fail "manifest did not contain artifact URL for $target"
  [ "$artifact_sha" ] || fail "manifest did not contain SHA-256 for $target"

  log "Downloading Bud for $target..."
  download_file "$artifact_url" "$archive"

  log "Verifying archive checksum..."
  verify_checksum "$archive" "$artifact_sha"

  log "Installing Bud to $BUD_BIN..."
  install_archive "$archive" "$extract_dir"
  write_env_file
  run_doctor

  log "Bud installed."
  bootstrap_bud
}

main "$@"
