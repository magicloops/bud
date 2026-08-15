//! Shell-integration shims (design D6b): Bud spawns the session shell, so it
//! bootstraps OSC 133 (command lifecycle) + OSC 7 (cwd) emission without
//! touching user dotfiles.
//!
//! - zsh: `ZDOTDIR` shim whose `.zshrc` sources the user's real zshrc
//!   (respecting the original `ZDOTDIR`/`HOME`) then installs precmd/preexec
//!   emitters. The user's `.zshenv` is still read from the real `ZDOTDIR`
//!   only when zsh falls back to `$HOME` — a known, accepted approximation.
//! - bash: `--rcfile` shim sourcing `~/.bashrc` then installing a
//!   `PROMPT_COMMAND` + DEBUG-trap emitter pair (bash-preexec technique).
//! - fish: no shim (native OSC 133 since 3.6).
//! - anything else, or `BUD_NO_SHELL_INTEGRATION=1` in the daemon env: no
//!   shim; the session runs marker-less and the manager's detection window
//!   downgrades it to `integration: none` (sentinel fallback covers
//!   `terminal.run`).

use std::path::Path;

use anyhow::Result;

/// How to launch the shell so integration markers are emitted.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShimSpawn {
    /// Extra argv after the shell binary.
    pub args: Vec<String>,
    /// Extra environment entries.
    pub env: Vec<(String, String)>,
}

pub const NO_SHELL_INTEGRATION_ENV: &str = "BUD_NO_SHELL_INTEGRATION";

/// Write shim files for `shell` under `shim_dir` and describe how to spawn it.
/// Returns `None` when the shell needs (or gets) no shim.
pub fn prepare_shim(shell: &str, shim_dir: &Path) -> Result<Option<ShimSpawn>> {
    if std::env::var(NO_SHELL_INTEGRATION_ENV).is_ok_and(|v| v == "1") {
        return Ok(None);
    }
    let base = Path::new(shell)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();

    match base {
        "zsh" => {
            std::fs::create_dir_all(shim_dir)?;
            std::fs::write(shim_dir.join(".zshrc"), zsh_shim_rc())?;
            let mut env = vec![(
                "ZDOTDIR".to_string(),
                shim_dir.to_string_lossy().into_owned(),
            )];
            if let Ok(orig) = std::env::var("ZDOTDIR") {
                env.push(("BUD_ORIG_ZDOTDIR".to_string(), orig));
            }
            Ok(Some(ShimSpawn { args: vec![], env }))
        }
        "bash" => {
            std::fs::create_dir_all(shim_dir)?;
            let rc_path = shim_dir.join("bashrc");
            std::fs::write(&rc_path, bash_shim_rc())?;
            Ok(Some(ShimSpawn {
                args: vec![
                    "--rcfile".to_string(),
                    rc_path.to_string_lossy().into_owned(),
                ],
                env: vec![],
            }))
        }
        // fish emits OSC 133 natively (>= 3.6).
        "fish" => Ok(None),
        _ => Ok(None),
    }
}

pub fn zsh_shim_rc() -> String {
    r#"# bud shell-integration shim (zsh) — generated; do not edit.
if [[ -n "${BUD_ORIG_ZDOTDIR}" ]]; then
  [[ -f "${BUD_ORIG_ZDOTDIR}/.zshrc" ]] && ZDOTDIR="${BUD_ORIG_ZDOTDIR}" source "${BUD_ORIG_ZDOTDIR}/.zshrc"
else
  [[ -f "${HOME}/.zshrc" ]] && source "${HOME}/.zshrc"
fi

__bud_cmd_ran=""
__bud_osc7() { printf '\033]7;file://%s%s\033\\' "${HOST:-localhost}" "${PWD}"; }
__bud_precmd() {
  local __bud_status=$?
  if [[ -n "${__bud_cmd_ran}" ]]; then
    printf '\033]133;D;%s\007' "${__bud_status}"
    __bud_cmd_ran=""
  fi
  __bud_osc7
  printf '\033]133;A\007'
}
__bud_preexec() {
  __bud_cmd_ran=1
  printf '\033]133;C\007'
}
if autoload -Uz add-zsh-hook 2>/dev/null; then
  add-zsh-hook precmd __bud_precmd
  add-zsh-hook preexec __bud_preexec
else
  precmd_functions+=(__bud_precmd)
  preexec_functions+=(__bud_preexec)
fi
"#
    .to_string()
}

pub fn bash_shim_rc() -> String {
    r#"# bud shell-integration shim (bash) — generated; do not edit.
[ -f "${HOME}/.bashrc" ] && source "${HOME}/.bashrc"

__bud_last_status=0
__bud_cmd_ran=""
__bud_at_prompt=""
__bud_debug() {
  __bud_last_status=$?
  [ -n "${COMP_LINE}" ] && return 0
  case "${BASH_COMMAND}" in __bud_precmd*) return 0;; esac
  [ -z "${__bud_at_prompt}" ] && return 0
  __bud_at_prompt=""
  __bud_cmd_ran=1
  printf '\033]133;C\007'
  return 0
}
trap '__bud_debug' DEBUG
__bud_precmd() {
  if [ -n "${__bud_cmd_ran}" ]; then
    printf '\033]133;D;%s\007' "${__bud_last_status}"
    __bud_cmd_ran=""
  fi
  printf '\033]7;file://%s%s\033\\' "${HOSTNAME:-localhost}" "${PWD}"
  printf '\033]133;A\007'
  __bud_at_prompt=1
}
PROMPT_COMMAND="__bud_precmd${PROMPT_COMMAND:+;${PROMPT_COMMAND}}"
"#
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zsh_shim_writes_zdotdir_rc_with_emitters() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = prepare_shim("/bin/zsh", tmp.path()).unwrap().unwrap();
        assert!(shim.args.is_empty());
        assert!(shim
            .env
            .iter()
            .any(|(k, v)| k == "ZDOTDIR" && v == &tmp.path().to_string_lossy()));

        let rc = std::fs::read_to_string(tmp.path().join(".zshrc")).unwrap();
        assert!(rc.contains("133;A"));
        assert!(rc.contains("133;C"));
        assert!(rc.contains("133;D;%s"));
        assert!(rc.contains("]7;file://"));
        assert!(rc.contains(".zshrc")); // sources the user's real rc
                                        // D only fires after a command ran (no phantom finish at first prompt).
        assert!(rc.contains("__bud_cmd_ran"));
    }

    #[test]
    fn bash_shim_writes_rcfile_with_prompt_command_and_debug_trap() {
        let tmp = tempfile::tempdir().unwrap();
        let shim = prepare_shim("/opt/homebrew/bin/bash", tmp.path())
            .unwrap()
            .unwrap();
        assert_eq!(shim.args[0], "--rcfile");
        assert!(shim.args[1].ends_with("bashrc"));
        assert!(shim.env.is_empty());

        let rc = std::fs::read_to_string(tmp.path().join("bashrc")).unwrap();
        assert!(rc.contains("trap '__bud_debug' DEBUG"));
        assert!(rc.contains("PROMPT_COMMAND=\"__bud_precmd"));
        assert!(rc.contains("133;D;%s"));
        assert!(rc.contains("$HOME/.bashrc") || rc.contains("${HOME}/.bashrc"));
    }

    #[test]
    fn fish_and_unknown_shells_get_no_shim() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(prepare_shim("/usr/bin/fish", tmp.path()).unwrap().is_none());
        assert!(prepare_shim("/bin/sh", tmp.path()).unwrap().is_none());
        assert!(prepare_shim("/bin/dash", tmp.path()).unwrap().is_none());
    }
}
