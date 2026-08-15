//! Mode state machine (design D7): classify the session as Shell / Tui / Repl /
//! Unknown from scanner facts + emulator observations. Pure and synchronous —
//! timers (DamageQuiet) live in [`crate::session`]; REPL prompt policy is
//! injected by the caller (it is Bud product policy, not stem's).

use crate::events::{Integration, Mode};
use crate::semantic::ScanKind;

/// Injected REPL prompt matcher: given the current cursor line's text (outside
/// alt-screen, no OSC 133), does it look like a known REPL prompt?
/// (e.g. `>>> `, `psql=# `, `mysql> ` — registry lives in the Bud daemon.)
pub trait ReplMatcher: Send + Sync {
    /// Returns a stable label (e.g. "python") on match.
    fn matches(&self, cursor_line: &str) -> Option<&'static str>;
}

/// A matcher that never matches (Unknown-only fallback behavior).
pub struct NoRepl;

impl ReplMatcher for NoRepl {
    fn matches(&self, _cursor_line: &str) -> Option<&'static str> {
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeChange {
    pub mode: Mode,
    pub integration: Integration,
    /// Set when mode == Repl.
    pub repl_label: Option<&'static str>,
}

/// Transition rules (see design D7 table):
/// - OSC 133 PromptStart ⇒ Shell (integration Osc133), sticky until alt-screen.
/// - AltScreenEnter ⇒ Tui (from any mode); AltScreenLeave ⇒ back to the prior
///   non-Tui mode (Shell if integrated, else re-classify).
/// - Outside alt-screen with no 133 markers: consult the ReplMatcher on
///   quiet-time cursor lines ⇒ Repl, else Unknown.
/// - Integration downgrades to None only via explicit `mark_no_integration()`
///   (caller's detection window expiring), never inferred here.
///
/// Additional rules chosen here (deterministic, unit-tested):
/// - Integration starts as `None` and upgrades to `Osc133` on the first 133
///   marker. From `Sentinel`, only `A`/`B`/`C` markers upgrade to `Osc133` —
///   a bare `D` is exactly what the caller's own sentinel trailer emits
///   (design D6c), so it keeps `Sentinel` rather than claiming real
///   integration.
/// - Any 133 marker classifies the session as Shell when not in Tui; while in
///   Tui the alt-screen classification stays sticky, but the prior-mode slot
///   is set to Shell so AltScreenLeave restores it.
/// - REPL demotion is hysteretic: `Repl → Unknown` only after **two
///   consecutive** quiet cursor lines that fail the matcher (a single
///   mid-output quiet sample must not flap the mode). Any match resets the
///   miss streak.
/// - `mark_no_integration()` also demotes `Shell → Unknown` (Shell was only
///   ever justified by markers); `mark_sentinel_integration()` never
///   downgrades an established `Osc133`.
/// - Only actual changes to (mode, integration, repl_label) emit a
///   [`ModeChange`].
pub struct ModeMachine {
    mode: Mode,
    integration: Integration,
    /// Mode to restore on AltScreenLeave (last non-Tui classification).
    prior_non_tui: Mode,
    repl_label: Option<&'static str>,
    /// Label paired with `prior_non_tui` when it is `Repl`.
    prior_repl_label: Option<&'static str>,
    /// Consecutive quiet samples that failed the matcher while in Repl.
    repl_miss_streak: u8,
    matcher: Box<dyn ReplMatcher>,
}

impl ModeMachine {
    pub fn new(matcher: Box<dyn ReplMatcher>) -> Self {
        Self {
            mode: Mode::Unknown,
            integration: Integration::None,
            prior_non_tui: Mode::Unknown,
            repl_label: None,
            prior_repl_label: None,
            repl_miss_streak: 0,
            matcher,
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn integration(&self) -> Integration {
        self.integration
    }

    fn snapshot(&self) -> (Mode, Integration, Option<&'static str>) {
        (self.mode, self.integration, self.repl_label)
    }

    fn change_since(
        &self,
        before: (Mode, Integration, Option<&'static str>),
    ) -> Option<ModeChange> {
        if self.snapshot() == before {
            None
        } else {
            Some(ModeChange {
                mode: self.mode,
                integration: self.integration,
                repl_label: self.repl_label,
            })
        }
    }

    /// Feed a scanner fact; returns a change if the classification moved.
    pub fn on_scan(&mut self, kind: &ScanKind) -> Option<ModeChange> {
        let before = self.snapshot();
        match kind {
            ScanKind::PromptStart | ScanKind::CommandInputStart | ScanKind::CommandOutputStart => {
                self.integration = Integration::Osc133;
                self.classify_shell_from_marker();
            }
            ScanKind::CommandEnd { .. } => {
                // A lone D is what the sentinel wrapper itself emits (D6c):
                // it must not claim real integration over a Sentinel override.
                if self.integration == Integration::None {
                    self.integration = Integration::Osc133;
                }
                self.classify_shell_from_marker();
            }
            ScanKind::Cwd { .. } => {}
            ScanKind::AltScreenEnter => {
                if self.mode != Mode::Tui {
                    self.prior_non_tui = self.mode;
                    self.prior_repl_label = self.repl_label;
                    self.mode = Mode::Tui;
                    self.repl_label = None;
                    self.repl_miss_streak = 0;
                }
            }
            ScanKind::AltScreenLeave => {
                if self.mode == Mode::Tui {
                    if self.integration == Integration::Osc133 {
                        self.mode = Mode::Shell;
                        self.repl_label = None;
                    } else {
                        self.mode = self.prior_non_tui;
                        self.repl_label = if self.mode == Mode::Repl {
                            self.prior_repl_label
                        } else {
                            None
                        };
                    }
                    self.repl_miss_streak = 0;
                }
            }
        }
        self.change_since(before)
    }

    /// A 133 marker is direct evidence of a shell command lifecycle: classify
    /// Shell unless the alt screen is active (then only update the mode that
    /// AltScreenLeave will restore).
    fn classify_shell_from_marker(&mut self) {
        if self.mode == Mode::Tui {
            self.prior_non_tui = Mode::Shell;
            self.prior_repl_label = None;
        } else {
            self.mode = Mode::Shell;
            self.repl_label = None;
            self.repl_miss_streak = 0;
        }
    }

    /// Called at quiet points with the emulator's cursor line (REPL detection
    /// samples the settled screen, not every byte).
    pub fn on_quiet_cursor_line(&mut self, line: &str) -> Option<ModeChange> {
        // Alt-screen classification is sticky; real 133 integration outranks
        // prompt-pattern guessing (design D7: Repl requires "no 133").
        if self.mode == Mode::Tui || self.integration == Integration::Osc133 {
            return None;
        }
        let before = self.snapshot();
        match self.matcher.matches(line) {
            Some(label) => {
                self.repl_miss_streak = 0;
                self.mode = Mode::Repl;
                self.repl_label = Some(label);
            }
            None => {
                if self.mode == Mode::Repl {
                    self.repl_miss_streak = self.repl_miss_streak.saturating_add(1);
                    if self.repl_miss_streak >= 2 {
                        self.mode = Mode::Unknown;
                        self.repl_label = None;
                        self.repl_miss_streak = 0;
                    }
                }
            }
        }
        self.change_since(before)
    }

    /// Caller's integration-detection window expired with no markers seen.
    pub fn mark_no_integration(&mut self) -> Option<ModeChange> {
        let before = self.snapshot();
        self.integration = Integration::None;
        // Shell classification was only ever justified by markers.
        if self.mode == Mode::Shell {
            self.mode = Mode::Unknown;
        }
        if self.prior_non_tui == Mode::Shell {
            self.prior_non_tui = Mode::Unknown;
        }
        self.change_since(before)
    }

    /// Caller is using sentinel-wrapped commands (design D6c).
    pub fn mark_sentinel_integration(&mut self) -> Option<ModeChange> {
        let before = self.snapshot();
        // Never downgrade real observed integration.
        if self.integration != Integration::Osc133 {
            self.integration = Integration::Sentinel;
        }
        self.change_since(before)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PythonRepl;
    impl ReplMatcher for PythonRepl {
        fn matches(&self, cursor_line: &str) -> Option<&'static str> {
            if cursor_line.starts_with(">>> ") || cursor_line == ">>>" {
                Some("python")
            } else {
                None
            }
        }
    }

    fn machine(matcher: Box<dyn ReplMatcher>) -> ModeMachine {
        ModeMachine::new(matcher)
    }

    fn change(
        mode: Mode,
        integration: Integration,
        repl_label: Option<&'static str>,
    ) -> ModeChange {
        ModeChange {
            mode,
            integration,
            repl_label,
        }
    }

    #[test]
    fn starts_unknown_no_integration() {
        let m = machine(Box::new(NoRepl));
        assert_eq!(m.mode(), Mode::Unknown);
        assert_eq!(m.integration(), Integration::None);
    }

    #[test]
    fn prompt_start_enters_shell_with_osc133() {
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(
            m.on_scan(&ScanKind::PromptStart),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );
        // Repeat marker: no change emitted.
        assert_eq!(m.on_scan(&ScanKind::PromptStart), None);
        assert_eq!(m.on_scan(&ScanKind::CommandInputStart), None);
        assert_eq!(m.on_scan(&ScanKind::CommandOutputStart), None);
        assert_eq!(
            m.on_scan(&ScanKind::CommandEnd { exit_code: Some(0) }),
            None
        );
        assert_eq!(m.mode(), Mode::Shell);
    }

    #[test]
    fn cwd_never_changes_classification() {
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(
            m.on_scan(&ScanKind::Cwd {
                path: "/tmp".into()
            }),
            None
        );
        assert_eq!(m.mode(), Mode::Unknown);
        assert_eq!(m.integration(), Integration::None);
    }

    #[test]
    fn integrated_shell_enters_and_exits_vim() {
        // The required table case: 133 session enters vim, then exits.
        let mut m = machine(Box::new(NoRepl));
        m.on_scan(&ScanKind::PromptStart);
        assert_eq!(m.mode(), Mode::Shell);
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenEnter),
            Some(change(Mode::Tui, Integration::Osc133, None))
        );
        // Repeat enter: sticky, no change.
        assert_eq!(m.on_scan(&ScanKind::AltScreenEnter), None);
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenLeave),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );
        assert_eq!(m.on_scan(&ScanKind::AltScreenLeave), None);
    }

    #[test]
    fn quiet_line_ignored_while_integrated_or_tui() {
        let mut m = machine(Box::new(PythonRepl));
        m.on_scan(&ScanKind::PromptStart);
        assert_eq!(m.on_quiet_cursor_line(">>> "), None);
        assert_eq!(m.mode(), Mode::Shell);

        let mut m = machine(Box::new(PythonRepl));
        m.on_scan(&ScanKind::AltScreenEnter);
        assert_eq!(m.on_quiet_cursor_line(">>> "), None);
        assert_eq!(m.mode(), Mode::Tui);
    }

    #[test]
    fn non_integrated_python_repl_detected() {
        let mut m = machine(Box::new(PythonRepl));
        assert_eq!(m.on_quiet_cursor_line("$ python3"), None);
        assert_eq!(
            m.on_quiet_cursor_line(">>> "),
            Some(change(Mode::Repl, Integration::None, Some("python")))
        );
        // Same prompt again: no change.
        assert_eq!(m.on_quiet_cursor_line(">>> 1+1"), None);
        assert_eq!(m.mode(), Mode::Repl);
    }

    #[test]
    fn repl_demotes_only_after_two_consecutive_misses() {
        let mut m = machine(Box::new(PythonRepl));
        m.on_quiet_cursor_line(">>> ");
        assert_eq!(m.mode(), Mode::Repl);

        // One mid-output quiet sample: no flap.
        assert_eq!(m.on_quiet_cursor_line("computing..."), None);
        assert_eq!(m.mode(), Mode::Repl);

        // A match resets the miss streak.
        assert_eq!(m.on_quiet_cursor_line(">>> "), None);
        assert_eq!(m.on_quiet_cursor_line("some output"), None);
        assert_eq!(m.mode(), Mode::Repl);

        // Two consecutive misses: back to Unknown (REPL exited to bare shell).
        assert_eq!(
            m.on_quiet_cursor_line("$ "),
            Some(change(Mode::Unknown, Integration::None, None))
        );
        assert_eq!(m.mode(), Mode::Unknown);

        // Further misses while Unknown emit nothing.
        assert_eq!(m.on_quiet_cursor_line("$ "), None);
    }

    #[test]
    fn tui_over_repl_restores_repl_with_label() {
        let mut m = machine(Box::new(PythonRepl));
        m.on_quiet_cursor_line(">>> ");
        assert_eq!(m.mode(), Mode::Repl);
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenEnter),
            Some(change(Mode::Tui, Integration::None, None))
        );
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenLeave),
            Some(change(Mode::Repl, Integration::None, Some("python")))
        );
    }

    #[test]
    fn tui_from_unknown_restores_unknown() {
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenEnter),
            Some(change(Mode::Tui, Integration::None, None))
        );
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenLeave),
            Some(change(Mode::Unknown, Integration::None, None))
        );
    }

    #[test]
    fn alt_screen_leave_without_enter_is_ignored() {
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(m.on_scan(&ScanKind::AltScreenLeave), None);
        assert_eq!(m.mode(), Mode::Unknown);
    }

    #[test]
    fn marker_during_tui_updates_restore_slot_not_mode() {
        let mut m = machine(Box::new(NoRepl));
        m.on_scan(&ScanKind::AltScreenEnter);
        // A shell-in-alt-screen emitting markers: Tui stays sticky but the
        // integration upgrade is visible.
        assert_eq!(
            m.on_scan(&ScanKind::PromptStart),
            Some(change(Mode::Tui, Integration::Osc133, None))
        );
        assert_eq!(m.mode(), Mode::Tui);
        assert_eq!(
            m.on_scan(&ScanKind::AltScreenLeave),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );
    }

    #[test]
    fn sentinel_override_and_upgrade_rules() {
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(
            m.mark_sentinel_integration(),
            Some(change(Mode::Unknown, Integration::Sentinel, None))
        );
        // Repeat: no change.
        assert_eq!(m.mark_sentinel_integration(), None);

        // The sentinel's own D marker does NOT upgrade integration (it still
        // classifies the session as Shell — a command lifecycle was observed).
        assert_eq!(
            m.on_scan(&ScanKind::CommandEnd { exit_code: Some(0) }),
            Some(change(Mode::Shell, Integration::Sentinel, None))
        );
        assert_eq!(m.integration(), Integration::Sentinel);

        // A real marker (A/B/C) upgrades Sentinel → Osc133.
        assert_eq!(
            m.on_scan(&ScanKind::PromptStart),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );

        // Sentinel override never downgrades established Osc133.
        assert_eq!(m.mark_sentinel_integration(), None);
        assert_eq!(m.integration(), Integration::Osc133);
    }

    #[test]
    fn command_end_from_none_upgrades_to_osc133() {
        // With no Sentinel override, a D marker is real evidence of markers.
        let mut m = machine(Box::new(NoRepl));
        assert_eq!(
            m.on_scan(&ScanKind::CommandEnd { exit_code: Some(1) }),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );
    }

    #[test]
    fn mark_no_integration_downgrades_and_declassifies_shell() {
        let mut m = machine(Box::new(NoRepl));
        m.on_scan(&ScanKind::PromptStart);
        assert_eq!(m.mode(), Mode::Shell);
        assert_eq!(
            m.mark_no_integration(),
            Some(change(Mode::Unknown, Integration::None, None))
        );
        // Repeat: no change.
        assert_eq!(m.mark_no_integration(), None);
        // A later real marker re-upgrades None → Osc133.
        assert_eq!(
            m.on_scan(&ScanKind::CommandOutputStart),
            Some(change(Mode::Shell, Integration::Osc133, None))
        );
    }
}
