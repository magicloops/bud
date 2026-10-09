# Source from the repo root or bud/: source ../dev/daemon-env.sh https
# Compute everything before changing the calling shell; failure preserves it.
bud_dev_environment() {
  local bud_dev_settings bud_dev_script
  if [ -f dev/daemon-env.mjs ]; then
    bud_dev_script=dev/daemon-env.mjs
  elif [ -f ../dev/daemon-env.mjs ]; then
    bud_dev_script=../dev/daemon-env.mjs
  else
    printf '%s\n' 'Source daemon-env.sh from the repository root or bud/.' >&2
    return 1
  fi
  bud_dev_settings=$(node "$bud_dev_script" "${1:-https}") || return 1
  eval "$bud_dev_settings"
}
bud_dev_environment "$@"
