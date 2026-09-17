//! Browser control authority, independent of the serial CDP operation lock.
//! A takeover fences old reads immediately; private input waits for CDP drain.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlCommand {
    Pause,
    Acquire { controller_id: String },
    Renew { controller_id: String },
    Release { controller_id: String },
    PrepareReturn { controller_id: String },
    FinishReturn,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Agent,
    Paused,
    HumanPrivate,
    ResumePending,
}

pub struct Authority {
    pub epoch: u64,
    pub mode: Mode,
    controller: Option<String>,
    paused_controller: Option<String>,
    expires: Option<Instant>,
    private: bool,
    // Remembers privacy transitions even if media misses takeover and return.
    // Advancing only the agent command epoch does not invalidate passive media.
    media_fence: u64,
}

impl Default for Authority {
    fn default() -> Self {
        Self {
            epoch: 0,
            mode: Mode::Agent,
            controller: None,
            paused_controller: None,
            expires: None,
            private: false,
            media_fence: 0,
        }
    }
}

impl Authority {
    pub fn expire(&mut self) {
        if self.expires.is_some_and(|time| time <= Instant::now()) {
            self.pause();
        }
    }

    pub fn pause(&mut self) {
        self.media_fence += 1;
        self.mode = Mode::Paused;
        if self.controller.is_some() {
            self.paused_controller = self.controller.take();
        }
        self.expires = None;
    }

    pub fn agent_allowed(&mut self, epoch: u64) -> bool {
        self.expire();
        self.mode == Mode::Agent && epoch >= self.epoch
    }

    pub fn human_allowed(&mut self, epoch: u64, controller: &str) -> bool {
        self.expire();
        self.mode == Mode::HumanPrivate
            && self.epoch == epoch
            && self.controller.as_deref() == Some(controller)
    }

    pub fn viewer_allowed(&mut self, epoch: u64, controller: Option<&str>) -> bool {
        self.expire();
        if epoch != self.epoch {
            return false;
        }
        match controller {
            Some(id) => self.human_allowed(epoch, id),
            None => !self.private && matches!(self.mode, Mode::Agent | Mode::Paused),
        }
    }

    pub fn media_fence(&self) -> u64 {
        self.media_fence
    }

    pub fn media_allowed(
        &mut self,
        epoch: u64,
        controller: Option<&str>,
        fence: Option<u64>,
    ) -> bool {
        match fence {
            Some(fence) if controller.is_none() => {
                self.expire();
                fence == self.media_fence
                    && !self.private
                    && matches!(self.mode, Mode::Agent | Mode::Paused)
            }
            Some(_) => false,
            None => self.viewer_allowed(epoch, controller),
        }
    }

    pub fn transition(&mut self, epoch: u64, command: &ControlCommand) -> Result<(), &'static str> {
        self.expire();
        if epoch < self.epoch {
            return Err("browser_stale_control");
        }
        match command {
            ControlCommand::Pause => {
                if epoch <= self.epoch {
                    return Err("browser_stale_control");
                }
                self.pause();
            }
            ControlCommand::Acquire { controller_id } => {
                if controller_id.is_empty() || controller_id.len() > 128 {
                    return Err("browser_invalid_controller");
                }
                if epoch <= self.epoch || self.mode != Mode::Paused {
                    return Err("browser_control_conflict");
                }
                self.controller = Some(controller_id.clone());
                self.paused_controller = None;
                self.expires = Some(Instant::now() + Duration::from_secs(15));
                self.mode = Mode::HumanPrivate;
                self.private = true;
            }
            ControlCommand::Renew { controller_id } => {
                if !self.human_allowed(epoch, controller_id) {
                    return Err("browser_control_expired");
                }
                self.expires = Some(Instant::now() + Duration::from_secs(15));
            }
            ControlCommand::Release { controller_id }
            | ControlCommand::PrepareReturn { controller_id } => {
                let active = self.mode == Mode::HumanPrivate
                    && self.controller.as_deref() == Some(controller_id);
                let media_lost = matches!(command, ControlCommand::PrepareReturn { .. })
                    && self.mode == Mode::Paused
                    && self.paused_controller.as_deref() == Some(controller_id);
                if epoch <= self.epoch || !(active || media_lost) {
                    return Err("browser_control_conflict");
                }
                self.pause();
                if matches!(command, ControlCommand::PrepareReturn { .. }) {
                    self.mode = Mode::ResumePending;
                }
            }
            ControlCommand::FinishReturn => {
                if epoch <= self.epoch || self.mode != Mode::ResumePending {
                    return Err("browser_control_conflict");
                }
                self.mode = Mode::Agent;
                self.private = false;
                self.paused_controller = None;
            }
        }
        if !matches!(command, ControlCommand::Renew { .. }) {
            self.media_fence += 1;
        }
        self.epoch = epoch;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passive_continuity_survives_only_agent_epoch_changes() {
        let mut state = Authority::default();
        let fence = state.media_fence();
        state.epoch = 2;
        assert!(state.media_allowed(0, None, Some(fence)));
        assert!(!state.agent_allowed(1));
        state.transition(3, &ControlCommand::Pause).unwrap();
        assert!(!state.media_allowed(0, None, Some(fence)));
        let paused_fence = state.media_fence();
        state
            .transition(
                4,
                &ControlCommand::Acquire {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        assert!(!state.media_allowed(4, None, Some(paused_fence)));
        assert!(state.media_allowed(4, Some("one"), None));
        state
            .transition(
                4,
                &ControlCommand::Renew {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        assert!(state.media_allowed(4, Some("one"), None));
        state
            .transition(
                5,
                &ControlCommand::PrepareReturn {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        state.transition(6, &ControlCommand::FinishReturn).unwrap();
        // Even a viewer that missed the entire private interval stays revoked.
        assert!(!state.media_allowed(0, None, Some(fence)));
        assert!(!state.media_allowed(3, None, Some(paused_fence)));
        assert!(state.media_allowed(6, None, Some(state.media_fence())));
        assert!(!state.media_allowed(4, Some("one"), None));
        let returned_fence = state.media_fence();
        state.pause();
        assert!(!state.media_allowed(6, None, Some(returned_fence)));
    }

    #[test]
    fn private_control_fences_reads_and_requires_explicit_return() {
        let mut state = Authority::default();
        assert!(state.agent_allowed(1));
        state.transition(2, &ControlCommand::Pause).unwrap();
        assert!(!state.agent_allowed(999));
        state
            .transition(
                3,
                &ControlCommand::Acquire {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        assert!(!state.human_allowed(3, "two"));
        assert!(state.human_allowed(3, "one"));
        assert!(state
            .transition(
                4,
                &ControlCommand::Acquire {
                    controller_id: "two".into()
                }
            )
            .is_err());
        state
            .transition(
                4,
                &ControlCommand::PrepareReturn {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        assert!(!state.human_allowed(3, "one"));
        assert!(!state.agent_allowed(4));
        state.transition(5, &ControlCommand::FinishReturn).unwrap();
        assert!(state.agent_allowed(5));
        assert!(!state.agent_allowed(1));
    }
    #[test]
    fn lease_expiry_and_disconnect_leave_automation_paused() {
        let mut state = Authority::default();
        state.transition(1, &ControlCommand::Pause).unwrap();
        state
            .transition(
                2,
                &ControlCommand::Acquire {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        state.expires = Some(Instant::now());
        assert!(!state.human_allowed(2, "one"));
        assert!(!state.agent_allowed(3));
        assert!(state
            .transition(
                2,
                &ControlCommand::Renew {
                    controller_id: "one".into()
                }
            )
            .is_err());
        state
            .transition(
                3,
                &ControlCommand::Acquire {
                    controller_id: "two".into(),
                },
            )
            .unwrap();
        state.pause();
        assert!(!state.agent_allowed(100));
        assert!(!state.viewer_allowed(3, None));
    }

    #[test]
    fn private_media_loss_retains_only_explicit_return_authority() {
        let mut state = Authority::default();
        state.transition(1, &ControlCommand::Pause).unwrap();
        assert!(state.viewer_allowed(1, None));
        state
            .transition(
                2,
                &ControlCommand::Acquire {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        state.pause();
        assert!(!state.viewer_allowed(2, None));
        assert!(!state.human_allowed(2, "one"));
        assert!(state
            .transition(
                3,
                &ControlCommand::PrepareReturn {
                    controller_id: "other".into()
                }
            )
            .is_err());
        state
            .transition(
                3,
                &ControlCommand::PrepareReturn {
                    controller_id: "one".into(),
                },
            )
            .unwrap();
        state.transition(4, &ControlCommand::FinishReturn).unwrap();
        assert!(state.viewer_allowed(4, None));
    }
}
