//! REPL prompt registry (product policy, injected into `stem::ModeMachine`).
//!
//! Conservative by design: a false `repl` classification changes how the agent
//! settles input, so only unmistakable prompts match. Plain `> ` and `% ` are
//! deliberately excluded (shell continuation prompts / zsh default look alike).

use stem::modes::ReplMatcher;

pub struct BudReplRegistry;

impl ReplMatcher for BudReplRegistry {
    fn matches(&self, cursor_line: &str) -> Option<&'static str> {
        let line = cursor_line.trim_end();

        // python / ipython-classic continuation
        if line == ">>>" || cursor_line.starts_with(">>> ") {
            return Some("python");
        }
        if line == "..." || cursor_line.starts_with("... ") {
            // Only meaningful once python matched at least once; ModeMachine
            // hysteresis keeps this from misfiring on stray ellipses because a
            // single sample never demotes/promotes on its own.
            return Some("python");
        }

        // ruby irb: `irb(main):001:0>` and variants
        if line.starts_with("irb(") && line.ends_with('>') {
            return Some("ruby");
        }

        // node: `node > ` is not emitted by node itself; its bare `> ` is too
        // generic to claim (see module docs) — intentionally unmatched.

        // psql: `dbname=#` / `dbname=>` (single prompt token, no spaces)
        if (line.ends_with("=#") || line.ends_with("=>"))
            && !line.is_empty()
            && !line.contains(' ')
            && line
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        {
            return Some("psql");
        }

        // mysql / mariadb
        if line == "mysql>" || cursor_line.starts_with("mysql> ") {
            return Some("mysql");
        }
        if line.starts_with("MariaDB [") && line.ends_with("]>") {
            return Some("mysql");
        }

        // sqlite
        if line == "sqlite>" || cursor_line.starts_with("sqlite> ") {
            return Some("sqlite");
        }

        // debuggers
        if line == "(gdb)" || cursor_line.starts_with("(gdb) ") {
            return Some("gdb");
        }
        if line == "(lldb)" || cursor_line.starts_with("(lldb) ") {
            return Some("lldb");
        }
        if line == "(Pdb)" || cursor_line.starts_with("(Pdb) ") {
            return Some("pdb");
        }

        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(line: &str) -> Option<&'static str> {
        BudReplRegistry.matches(line)
    }

    #[test]
    fn matches_common_repl_prompts() {
        assert_eq!(matches(">>> "), Some("python"));
        assert_eq!(matches(">>> 1 + 1"), Some("python"));
        assert_eq!(matches("... "), Some("python"));
        assert_eq!(matches("irb(main):001:0> "), Some("ruby"));
        assert_eq!(matches("postgres=# "), Some("psql"));
        assert_eq!(matches("mydb=> "), Some("psql"));
        assert_eq!(matches("mysql> "), Some("mysql"));
        assert_eq!(matches("sqlite> "), Some("sqlite"));
        assert_eq!(matches("(gdb) "), Some("gdb"));
        assert_eq!(matches("(lldb) "), Some("lldb"));
        assert_eq!(matches("(Pdb) "), Some("pdb"));
    }

    #[test]
    fn does_not_match_shell_prompts_or_generic_output() {
        assert_eq!(matches("$ "), None);
        assert_eq!(matches("% "), None);
        assert_eq!(matches("> "), None); // too generic (node/zsh continuation)
        assert_eq!(matches("adam@mac bud % "), None);
        assert_eq!(matches("sh-3.2$ "), None);
        assert_eq!(matches("computing..."), None);
        assert_eq!(matches(""), None);
    }

    #[test]
    fn psql_prompt_requires_single_token() {
        // Ruby hash-rocket output lines must not classify as psql.
        assert_eq!(matches("{:a => 1} =>"), None);
        assert_eq!(matches("value =>"), None);
        assert_eq!(matches("=>"), None);
    }
}
