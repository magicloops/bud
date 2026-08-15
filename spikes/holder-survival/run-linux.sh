#!/usr/bin/env bash
#
# Holder-survival scenario matrix — Linux / systemd user units.
#
# FOR THE HUMAN OPERATOR. Requires a real systemd user session (`systemctl --user`
# must work; if running over ssh you may need `loginctl enable-linger $USER` for the
# user manager to exist). Do not run as root. Each scenario prints what it is about
# to do, runs `check`, appends a row to findings.md ("Run log"), and tears down.
# Idempotent: re-running cleans up prior state.
#
# NOTE: this script was written on macOS and is UNTESTED on Linux. Read it before
# running; expect to fix small distro-specific issues.
#
# Scenarios automated here (x KillMode=control-group|process):
#   job-exit    oneshot unit runs `fake-daemon --once` and exits. Does systemd's
#               cgroup cleanup kill the detached holder when the unit finishes?
#   kill9       long-running fake-daemon unit; kill -9 its MainPID.
#   restart     `systemctl --user restart`; new daemon must REATTACH (meta pid unchanged).
#   upgrade     stop unit, replace binary file (new inode), start; must reattach.
# Plus one KillMode-independent scenario:
#   scope-escape  holder pre-launched via `systemd-run --user --scope` (own cgroup),
#                 daemon unit (hostile KillMode=control-group) restarts around it.
#
# Manual rows: user logout/login (loginctl terminate-user semantics vary with
# lingering), machine reboot. Instructions printed at the end.

set -u

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$SPIKE_DIR/run"
BIN_INSTALL="$RUN_DIR/bin/holder-survival"
SESS_ROOT="$RUN_DIR/sessions"
RENDER_DIR="$RUN_DIR/rendered"
FINDINGS="$SPIKE_DIR/findings.md"
TEMPLATE="$SPIKE_DIR/templates/bud-spike-holder-survival.service.tmpl"
UNIT_PREFIX="bud-spike-hs"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

record() { # scenario variant result note
  printf '| %s | Linux systemd | %s | %s | %s | %s |\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >> "$FINDINGS"
  say "RECORDED: $1 [$2] -> $3 ($4)"
}

meta_pid() { # session_dir
  grep -o '"pid": *[0-9]*' "$1/meta.json" 2>/dev/null | grep -o '[0-9]*' || echo ""
}

render_unit() { # unit_name session_dir killmode once(yes|no) out_path
  local unit="$1" sessdir="$2" killmode="$3" once="$4" out="$5"
  local extra="" type="simple"
  if [ "$once" = "yes" ]; then extra="--once"; type="oneshot"; fi
  sed -e "s|@UNIT_DESC@|$unit|g" \
      -e "s|@BINARY@|$BIN_INSTALL|g" \
      -e "s|@SESSION_DIR@|$sessdir|g" \
      -e "s|@EXTRA_ARGS@|$extra|g" \
      -e "s|@TYPE@|$type|g" \
      -e "s|@KILLMODE@|$killmode|g" \
      "$TEMPLATE" > "$out"
}

remove_unit_quiet() { # unit_name (without .service)
  systemctl --user stop "$1.service" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$1.service" >/dev/null 2>&1 || true
  systemctl --user disable "$1.service" >/dev/null 2>&1 || true
  rm -f "$HOME/.config/systemd/user/$1.service"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
}

install_unit() { # unit_name rendered_path
  systemctl --user link "$2" >/dev/null || return 1
  systemctl --user daemon-reload
}

stop_holder_quiet() { # session_dir
  [ -x "$BIN_INSTALL" ] && "$BIN_INSTALL" stop --dir "$1" >/dev/null 2>&1 || true
  systemctl --user stop "$UNIT_PREFIX-holder-scope.scope" >/dev/null 2>&1 || true
}

wait_for_sock() { # session_dir timeout_s
  local sessdir="$1" timeout="$2" i=0
  while [ "$i" -lt $((timeout * 10)) ]; do
    [ -S "$sessdir/holder.sock" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

run_check() { # session_dir -> CHECK_RESULT=PASS|FAIL
  if "$BIN_INSTALL" check --dir "$1"; then CHECK_RESULT=PASS; else CHECK_RESULT=FAIL; fi
}

scenario_setup() { # unit_name session_dir
  remove_unit_quiet "$1"
  stop_holder_quiet "$2"
  rm -rf "$2"
  mkdir -p "$2"
}

scenario_teardown() { # unit_name session_dir
  stop_holder_quiet "$2"
  remove_unit_quiet "$1"
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

scenario_job_exit() { # killmode
  local km="$1" unit="$UNIT_PREFIX-jobexit-$km"
  local sessdir="$SESS_ROOT/systemd-jobexit-$km"
  local rendered="$RENDER_DIR/$unit.service"
  say "SCENARIO job-exit (KillMode=$km)"
  note "About to: start a oneshot user unit running 'fake-daemon --once'; the unit"
  note "finishes immediately. Check whether the detached holder survived cgroup cleanup."
  scenario_setup "$unit" "$sessdir"
  render_unit "$unit" "$sessdir" "$km" yes "$rendered"
  install_unit "$unit" "$rendered" || { record "job-exit" "KillMode=$km" FAIL "unit link failed"; return; }
  systemctl --user start "$unit.service" || note "start returned nonzero (oneshot may report holder-spawn result)"
  sleep 3
  run_check "$sessdir"
  record "job-exit" "KillMode=$km" "$CHECK_RESULT" "holder after oneshot unit finished"
  scenario_teardown "$unit" "$sessdir"
}

scenario_kill9() { # killmode
  local km="$1" unit="$UNIT_PREFIX-kill9-$km"
  local sessdir="$SESS_ROOT/systemd-kill9-$km"
  local rendered="$RENDER_DIR/$unit.service"
  say "SCENARIO kill9 (KillMode=$km)"
  note "About to: start attach-loop unit, kill -9 its MainPID, then check the holder."
  scenario_setup "$unit" "$sessdir"
  render_unit "$unit" "$sessdir" "$km" no "$rendered"
  install_unit "$unit" "$rendered" || { record "kill9" "KillMode=$km" FAIL "unit link failed"; return; }
  systemctl --user start "$unit.service" || { record "kill9" "KillMode=$km" FAIL "unit start failed"; scenario_teardown "$unit" "$sessdir"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "kill9" "KillMode=$km" FAIL "holder socket never appeared"
    scenario_teardown "$unit" "$sessdir"; return
  fi
  local dpid
  dpid="$(systemctl --user show -p MainPID --value "$unit.service")"
  if [ -z "$dpid" ] || [ "$dpid" = "0" ]; then
    record "kill9" "KillMode=$km" FAIL "could not resolve MainPID"
    scenario_teardown "$unit" "$sessdir"; return
  fi
  note "kill -9 $dpid (fake-daemon MainPID) — waiting 3s for systemd to react..."
  kill -9 "$dpid"
  sleep 3
  run_check "$sessdir"
  record "kill9" "KillMode=$km" "$CHECK_RESULT" "holder after daemon kill -9"
  scenario_teardown "$unit" "$sessdir"
}

scenario_restart() { # killmode
  local km="$1" unit="$UNIT_PREFIX-restart-$km"
  local sessdir="$SESS_ROOT/systemd-restart-$km"
  local rendered="$RENDER_DIR/$unit.service"
  say "SCENARIO restart (KillMode=$km)"
  note "About to: start attach-loop unit, 'systemctl --user restart' it."
  note "PASS requires check pass AND meta.json pid unchanged (reattach, not respawn)."
  scenario_setup "$unit" "$sessdir"
  render_unit "$unit" "$sessdir" "$km" no "$rendered"
  install_unit "$unit" "$rendered" || { record "restart" "KillMode=$km" FAIL "unit link failed"; return; }
  systemctl --user start "$unit.service" || { record "restart" "KillMode=$km" FAIL "unit start failed"; scenario_teardown "$unit" "$sessdir"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "restart" "KillMode=$km" FAIL "holder socket never appeared"
    scenario_teardown "$unit" "$sessdir"; return
  fi
  local pid0 pid1
  pid0="$(meta_pid "$sessdir")"
  note "holder pid before restart: $pid0"
  systemctl --user restart "$unit.service" || true
  sleep 4
  run_check "$sessdir"
  pid1="$(meta_pid "$sessdir")"
  note "holder pid after restart:  $pid1"
  local verdict="$CHECK_RESULT" detail="service-manager restart"
  if [ "$CHECK_RESULT" = PASS ] && [ "$pid0" != "$pid1" ]; then
    verdict=FAIL; detail="holder respawned (pid $pid0 -> $pid1), survival not proven"
  elif [ "$CHECK_RESULT" = PASS ]; then
    detail="reattached, holder pid unchanged ($pid0)"
  fi
  record "restart" "KillMode=$km" "$verdict" "$detail"
  scenario_teardown "$unit" "$sessdir"
}

scenario_upgrade() { # killmode
  local km="$1" unit="$UNIT_PREFIX-upgrade-$km"
  local sessdir="$SESS_ROOT/systemd-upgrade-$km"
  local rendered="$RENDER_DIR/$unit.service"
  say "SCENARIO upgrade (KillMode=$km)"
  note "About to: start attach-loop unit, stop it, replace the installed binary"
  note "(new inode), start again. New daemon must reattach to the old holder."
  scenario_setup "$unit" "$sessdir"
  render_unit "$unit" "$sessdir" "$km" no "$rendered"
  install_unit "$unit" "$rendered" || { record "upgrade" "KillMode=$km" FAIL "unit link failed"; return; }
  systemctl --user start "$unit.service" || { record "upgrade" "KillMode=$km" FAIL "unit start failed"; scenario_teardown "$unit" "$sessdir"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "upgrade" "KillMode=$km" FAIL "holder socket never appeared"
    scenario_teardown "$unit" "$sessdir"; return
  fi
  local pid0 pid1
  pid0="$(meta_pid "$sessdir")"
  note "holder pid before upgrade: $pid0 — stopping daemon unit (holder should stay up)"
  systemctl --user stop "$unit.service" || true
  sleep 2
  note "replacing installed binary at $BIN_INSTALL (cp to temp + mv = new inode)"
  cp -f "$SPIKE_DIR/target/debug/holder-survival" "$BIN_INSTALL.new"
  mv -f "$BIN_INSTALL.new" "$BIN_INSTALL"
  systemctl --user start "$unit.service" || { record "upgrade" "KillMode=$km" FAIL "restart after replace failed"; scenario_teardown "$unit" "$sessdir"; return; }
  sleep 3
  run_check "$sessdir"
  pid1="$(meta_pid "$sessdir")"
  note "holder pid after upgrade:  $pid1"
  local verdict="$CHECK_RESULT" detail="binary-replace upgrade simulation"
  if [ "$CHECK_RESULT" = PASS ] && [ "$pid0" != "$pid1" ]; then
    verdict=FAIL; detail="holder respawned (pid $pid0 -> $pid1), survival not proven"
  elif [ "$CHECK_RESULT" = PASS ]; then
    detail="reattached across binary replacement, holder pid unchanged ($pid0)"
  fi
  record "upgrade" "KillMode=$km" "$verdict" "$detail"
  scenario_teardown "$unit" "$sessdir"
}

scenario_scope_escape() {
  local unit="$UNIT_PREFIX-scope-escape"
  local sessdir="$SESS_ROOT/systemd-scope-escape"
  local rendered="$RENDER_DIR/$unit.service"
  say "SCENARIO scope-escape (holder in its own transient scope; daemon unit uses hostile KillMode=control-group)"
  note "About to: pre-launch the HOLDER via 'systemd-run --user --scope' so it lives in"
  note "its own cgroup, then start/restart the daemon unit around it. If this passes,"
  note "scope-escape is a viable detach recipe even where KillMode tweaks are not."
  scenario_setup "$unit" "$sessdir"
  systemctl --user stop "$UNIT_PREFIX-holder-scope.scope" >/dev/null 2>&1 || true
  systemctl --user reset-failed "$UNIT_PREFIX-holder-scope.scope" >/dev/null 2>&1 || true
  note "launching holder in transient scope..."
  systemd-run --user --scope --unit="$UNIT_PREFIX-holder-scope" \
    "$BIN_INSTALL" holder --dir "$sessdir" || { record "scope-escape" "systemd-run --user --scope" FAIL "systemd-run failed"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "scope-escape" "systemd-run --user --scope" FAIL "holder socket never appeared"
    scenario_teardown "$unit" "$sessdir"; return
  fi
  local pid0 pid1
  pid0="$(meta_pid "$sessdir")"
  render_unit "$unit" "$sessdir" "control-group" no "$rendered"
  install_unit "$unit" "$rendered" || { record "scope-escape" "systemd-run --user --scope" FAIL "unit link failed"; return; }
  systemctl --user start "$unit.service" || { record "scope-escape" "systemd-run --user --scope" FAIL "unit start failed"; scenario_teardown "$unit" "$sessdir"; return; }
  sleep 2
  note "restarting the daemon unit (control-group kill must not reach the scope's cgroup)"
  systemctl --user restart "$unit.service" || true
  sleep 3
  run_check "$sessdir"
  pid1="$(meta_pid "$sessdir")"
  local verdict="$CHECK_RESULT" detail="holder in own scope, daemon KillMode=control-group restart"
  if [ "$CHECK_RESULT" = PASS ] && [ "$pid0" != "$pid1" ]; then
    verdict=FAIL; detail="holder respawned (pid $pid0 -> $pid1)"
  fi
  record "scope-escape" "systemd-run --user --scope" "$verdict" "$detail"
  scenario_teardown "$unit" "$sessdir"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ "$(uname -s)" != "Linux" ]; then
  echo "This script is for Linux. Use run-macos.sh on macOS." >&2
  exit 2
fi
if [ "$(id -u)" = "0" ]; then
  echo "Do not run as root: this exercises the systemd *user* manager." >&2
  exit 2
fi
if ! systemctl --user is-system-running >/dev/null 2>&1; then
  echo "systemctl --user is not reachable. Need a user session (try: loginctl enable-linger $USER)." >&2
  exit 2
fi

say "holder-survival matrix — Linux systemd user units (UNTESTED script — review before trusting)"
note "spike dir: $SPIKE_DIR"
note "findings:  $FINDINGS"

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  say "building harness (cargo build) — set SKIP_BUILD=1 to skip"
  (cd "$SPIKE_DIR" && cargo build) || { echo "build failed" >&2; exit 1; }
fi
mkdir -p "$RUN_DIR/bin" "$SESS_ROOT" "$RENDER_DIR"
cp -f "$SPIKE_DIR/target/debug/holder-survival" "$BIN_INSTALL"

if ! grep -q "^## Run log" "$FINDINGS" 2>/dev/null; then
  echo "findings.md missing its '## Run log' section — refusing to append blindly." >&2
  exit 1
fi

for km in control-group process; do
  scenario_job_exit "$km"
  scenario_kill9 "$km"
  scenario_restart "$km"
  scenario_upgrade "$km"
done
scenario_scope_escape

say "Automated scenarios complete. Results appended to findings.md (Run log)."
say "MANUAL rows still to do:"
note "logout/login: with a holder running and NO lingering, log out and back in;"
note "  then: $BIN_INSTALL check --dir <session_dir>. Repeat with"
note "  'loginctl enable-linger \$USER'. Document both (survival not strictly required)."
note "reboot: with a holder running, reboot, then run check — expected FAIL; confirm"
note "  the stale session dir is detectable (meta.json pid dead) for clean registry GC."
