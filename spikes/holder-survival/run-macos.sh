#!/usr/bin/env bash
#
# Holder-survival scenario matrix — macOS / launchd (LaunchAgent).
#
# FOR THE HUMAN OPERATOR. Run from a real GUI login session (the gui/$UID launchd
# domain must exist). Do not run as root. Each scenario prints what it is about to
# do, runs `check`, appends a row to findings.md ("Run log" section), and tears
# down after itself. The script is idempotent: re-running cleans up prior state.
#
# Scenarios automated here (x AbandonProcessGroup=true|false):
#   job-exit    launchd job runs `fake-daemon --once`; the job exits naturally.
#               Does launchd reap the detached holder when the job ends?
#   kill9       long-running fake-daemon under launchd is killed with kill -9.
#   kickstart   `launchctl kickstart -k` restarts the job; new daemon must REATTACH
#               (meta.json pid unchanged), not respawn.
#   upgrade     job stopped, binary file replaced (new inode), job restarted;
#               new daemon must reattach to the holder run by the "old" binary.
#
# Manual rows (documented, not automated): user logout/login, machine reboot.
# Instructions are printed at the end.

set -u

SPIKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$SPIKE_DIR/run"
BIN_INSTALL="$RUN_DIR/bin/holder-survival"
SESS_ROOT="$RUN_DIR/sessions"
RENDER_DIR="$RUN_DIR/rendered"
FINDINGS="$SPIKE_DIR/findings.md"
TEMPLATE="$SPIKE_DIR/templates/launchagent.plist.tmpl"
DOMAIN="gui/$(id -u)"
LABEL_PREFIX="com.bud.spike.holder-survival"

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }

record() { # scenario variant result note
  printf '| %s | macOS launchd | %s | %s | %s | %s |\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" >> "$FINDINGS"
  say "RECORDED: $1 [$2] -> $3 ($4)"
}

meta_pid() { # session_dir
  grep -o '"pid": *[0-9]*' "$1/meta.json" 2>/dev/null | grep -o '[0-9]*' || echo ""
}

render_plist() { # label session_dir abandon once(yes|no) out_path
  local label="$1" sessdir="$2" abandon="$3" once="$4" out="$5"
  local once_arg=""
  [ "$once" = "yes" ] && once_arg="<string>--once</string>"
  sed -e "s|@LABEL@|$label|g" \
      -e "s|@BINARY@|$BIN_INSTALL|g" \
      -e "s|@SESSION_DIR@|$sessdir|g" \
      -e "s|@ONCE_ARG@|$once_arg|g" \
      -e "s|@ABANDON@|$abandon|g" \
      -e "s|@LOG@|$sessdir/daemon.log|g" \
      "$TEMPLATE" > "$out"
}

bootout_quiet() { # label
  launchctl bootout "$DOMAIN/$1" >/dev/null 2>&1 || true
}

stop_holder_quiet() { # session_dir
  [ -x "$BIN_INSTALL" ] && "$BIN_INSTALL" stop --dir "$1" >/dev/null 2>&1 || true
}

wait_for_sock() { # session_dir timeout_s -> 0/1
  local sessdir="$1" timeout="$2" i=0
  while [ "$i" -lt $((timeout * 10)) ]; do
    [ -S "$sessdir/holder.sock" ] && return 0
    sleep 0.1; i=$((i + 1))
  done
  return 1
}

run_check() { # session_dir -> sets CHECK_RESULT=PASS|FAIL and prints output
  if "$BIN_INSTALL" check --dir "$1"; then CHECK_RESULT=PASS; else CHECK_RESULT=FAIL; fi
}

scenario_setup() { # label session_dir  — idempotent cleanup + fresh dir
  bootout_quiet "$1"
  stop_holder_quiet "$2"
  rm -rf "$2"
  mkdir -p "$2"
}

scenario_teardown() { # label session_dir
  bootout_quiet "$1"
  stop_holder_quiet "$2"
}

# ---------------------------------------------------------------------------
# Scenarios
# ---------------------------------------------------------------------------

scenario_job_exit() { # abandon
  local abandon="$1"
  local label="$LABEL_PREFIX.jobexit.$abandon"
  local sessdir="$SESS_ROOT/launchd-jobexit-$abandon"
  local plist="$RENDER_DIR/$label.plist"
  say "SCENARIO job-exit (AbandonProcessGroup=$abandon)"
  note "About to: bootstrap a LaunchAgent that runs 'fake-daemon --once' at load."
  note "The job spawns the holder, verifies, and exits. Then check whether the holder survived."
  scenario_setup "$label" "$sessdir"
  render_plist "$label" "$sessdir" "$abandon" yes "$plist"
  launchctl bootstrap "$DOMAIN" "$plist" || { record "job-exit" "AbandonProcessGroup=$abandon" FAIL "bootstrap failed"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "job-exit" "AbandonProcessGroup=$abandon" FAIL "holder socket never appeared"
    scenario_teardown "$label" "$sessdir"; return
  fi
  note "Holder is up; waiting 4s for the --once job to finish and launchd to process the exit..."
  sleep 4
  run_check "$sessdir"
  record "job-exit" "AbandonProcessGroup=$abandon" "$CHECK_RESULT" "holder after natural job exit"
  scenario_teardown "$label" "$sessdir"
}

scenario_kill9() { # abandon
  local abandon="$1"
  local label="$LABEL_PREFIX.kill9.$abandon"
  local sessdir="$SESS_ROOT/launchd-kill9-$abandon"
  local plist="$RENDER_DIR/$label.plist"
  say "SCENARIO kill9 (AbandonProcessGroup=$abandon)"
  note "About to: bootstrap a LaunchAgent running fake-daemon in attach-loop mode,"
  note "then kill -9 the fake-daemon process. Check whether the holder survived."
  scenario_setup "$label" "$sessdir"
  render_plist "$label" "$sessdir" "$abandon" no "$plist"
  launchctl bootstrap "$DOMAIN" "$plist" || { record "kill9" "AbandonProcessGroup=$abandon" FAIL "bootstrap failed"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "kill9" "AbandonProcessGroup=$abandon" FAIL "holder socket never appeared"
    scenario_teardown "$label" "$sessdir"; return
  fi
  sleep 1
  local dpid
  dpid="$(pgrep -f "fake-daemon --dir $sessdir" | head -1 || true)"
  if [ -z "$dpid" ]; then
    record "kill9" "AbandonProcessGroup=$abandon" FAIL "could not find fake-daemon pid"
    scenario_teardown "$label" "$sessdir"; return
  fi
  note "kill -9 $dpid (fake-daemon) — waiting 3s for launchd to react..."
  kill -9 "$dpid"
  sleep 3
  run_check "$sessdir"
  record "kill9" "AbandonProcessGroup=$abandon" "$CHECK_RESULT" "holder after daemon kill -9"
  scenario_teardown "$label" "$sessdir"
}

scenario_kickstart() { # abandon
  local abandon="$1"
  local label="$LABEL_PREFIX.kickstart.$abandon"
  local sessdir="$SESS_ROOT/launchd-kickstart-$abandon"
  local plist="$RENDER_DIR/$label.plist"
  say "SCENARIO kickstart (AbandonProcessGroup=$abandon)"
  note "About to: bootstrap attach-loop LaunchAgent, then 'launchctl kickstart -k' it."
  note "PASS requires check to pass AND meta.json pid unchanged (reattach, not respawn)."
  scenario_setup "$label" "$sessdir"
  render_plist "$label" "$sessdir" "$abandon" no "$plist"
  launchctl bootstrap "$DOMAIN" "$plist" || { record "kickstart" "AbandonProcessGroup=$abandon" FAIL "bootstrap failed"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "kickstart" "AbandonProcessGroup=$abandon" FAIL "holder socket never appeared"
    scenario_teardown "$label" "$sessdir"; return
  fi
  local pid0 pid1
  pid0="$(meta_pid "$sessdir")"
  note "holder pid before kickstart: $pid0"
  launchctl kickstart -k "$DOMAIN/$label" || true
  sleep 4
  run_check "$sessdir"
  pid1="$(meta_pid "$sessdir")"
  note "holder pid after kickstart:  $pid1"
  local verdict="$CHECK_RESULT" detail="service-manager restart"
  if [ "$CHECK_RESULT" = PASS ] && [ "$pid0" != "$pid1" ]; then
    verdict=FAIL; detail="holder respawned (pid $pid0 -> $pid1), survival not proven"
  elif [ "$CHECK_RESULT" = PASS ]; then
    detail="reattached, holder pid unchanged ($pid0)"
  fi
  record "kickstart" "AbandonProcessGroup=$abandon" "$verdict" "$detail"
  scenario_teardown "$label" "$sessdir"
}

scenario_upgrade() { # abandon
  local abandon="$1"
  local label="$LABEL_PREFIX.upgrade.$abandon"
  local sessdir="$SESS_ROOT/launchd-upgrade-$abandon"
  local plist="$RENDER_DIR/$label.plist"
  say "SCENARIO upgrade (AbandonProcessGroup=$abandon)"
  note "About to: start attach-loop LaunchAgent, stop it, REPLACE the installed binary"
  note "(fresh copy, new inode — upgrade simulation), start again. New daemon must reattach."
  scenario_setup "$label" "$sessdir"
  render_plist "$label" "$sessdir" "$abandon" no "$plist"
  launchctl bootstrap "$DOMAIN" "$plist" || { record "upgrade" "AbandonProcessGroup=$abandon" FAIL "bootstrap failed"; return; }
  if ! wait_for_sock "$sessdir" 15; then
    record "upgrade" "AbandonProcessGroup=$abandon" FAIL "holder socket never appeared"
    scenario_teardown "$label" "$sessdir"; return
  fi
  local pid0 pid1
  pid0="$(meta_pid "$sessdir")"
  note "holder pid before upgrade: $pid0 — stopping daemon job (holder should stay up)"
  bootout_quiet "$label"
  sleep 2
  note "replacing installed binary at $BIN_INSTALL (cp to temp + mv = new inode)"
  cp -f "$SPIKE_DIR/target/debug/holder-survival" "$BIN_INSTALL.new"
  mv -f "$BIN_INSTALL.new" "$BIN_INSTALL"
  note "bootstrapping the job again with the replaced binary"
  launchctl bootstrap "$DOMAIN" "$plist" || { record "upgrade" "AbandonProcessGroup=$abandon" FAIL "re-bootstrap failed"; return; }
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
  record "upgrade" "AbandonProcessGroup=$abandon" "$verdict" "$detail"
  scenario_teardown "$label" "$sessdir"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if [ "$(uname -s)" != "Darwin" ]; then
  echo "This script is for macOS. Use run-linux.sh on Linux." >&2
  exit 2
fi
if [ "$(id -u)" = "0" ]; then
  echo "Do not run as root: LaunchAgents live in the gui/\$UID domain." >&2
  exit 2
fi

say "holder-survival matrix — macOS launchd"
note "spike dir:  $SPIKE_DIR"
note "domain:     $DOMAIN"
note "findings:   $FINDINGS"

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

for abandon in true false; do
  scenario_job_exit "$abandon"
  scenario_kill9 "$abandon"
  scenario_kickstart "$abandon"
  scenario_upgrade "$abandon"
done

say "Automated scenarios complete. Results appended to findings.md (Run log)."
say "MANUAL rows still to do:"
note "logout/login: bootstrap an attach-loop plist variant, log out of the macOS GUI"
note "  session, log back in, then: $BIN_INSTALL check --dir <session_dir>"
note "  (document the observed behavior; survival is not strictly required)."
note "reboot: with a holder running, reboot the machine, then run check — expected"
note "  FAIL (sessions die); confirm the stale session dir is detectable via meta.json"
note "  pid being dead, i.e. clean registry GC is possible."
