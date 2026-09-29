//! Browser control authority, independent of the serial CDP operation lock.
//! A takeover fences old reads immediately; private input waits for CDP drain.
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlCommand {
    Pause,
    Acquire {
        controller_id: String,
        lease_expires_at_ms: u64,
    },
    Renew {
        controller_id: String,
        lease_expires_at_ms: u64,
    },
    End,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Agent,
    Paused,
    HumanPrivate,
}

#[derive(Clone)]
pub struct Authority {
    pub epoch: u64,
    pub mode: Mode,
    controller: Option<String>,
    expires: Option<Instant>,
    private: bool,
    workspace: Option<String>,
    // Remembers privacy transitions even if media misses takeover and return.
    // Advancing only the agent command epoch does not invalidate passive media.
    media_fence: u64,
    pub end_pending: bool,
}

impl Default for Authority {
    fn default() -> Self {
        Self {
            epoch: 0,
            mode: Mode::Agent,
            controller: None,
            expires: None,
            private: false,
            workspace: None,
            media_fence: 0,
            end_pending: false,
        }
    }
}

impl Authority {
    pub(super) fn private_content(&self) -> bool {
        self.private
    }

    pub fn restore(&mut self, private: bool, paused: bool) {
        self.private = private;
        if private || paused {
            self.request_end();
        }
    }

    pub fn resume_after_stop(&mut self, epoch: u64) {
        self.mode = Mode::Agent;
        self.private = false;
        self.epoch = epoch;
        self.controller = None;
        self.workspace = None;
        self.expires = None;
        self.media_fence += 1;
        self.end_pending = false;
    }

    pub fn set_workspace(&mut self, workspace: String) {
        self.workspace = Some(workspace);
    }
    pub fn workspace_allowed(&self, workspace: &str) -> bool {
        self.workspace.as_deref() == Some(workspace)
    }

    pub fn expire(&mut self) {
        if self.expires.is_some_and(|time| time <= Instant::now()) {
            self.request_end();
        }
    }

    pub fn request_end(&mut self) {
        self.pause();
        self.end_pending = true;
    }

    pub fn pause(&mut self) {
        self.media_fence += 1;
        self.mode = Mode::Paused;
        if self.controller.is_some() {
            self.end_pending = true;
            self.controller = None;
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
                self.end_pending = false;
            }
            ControlCommand::Acquire {
                controller_id,
                lease_expires_at_ms,
            } => {
                if controller_id.is_empty() || controller_id.len() > 128 {
                    return Err("browser_invalid_controller");
                }
                if epoch <= self.epoch || self.mode != Mode::Paused {
                    return Err("browser_control_conflict");
                }
                let deadline = lease_deadline(*lease_expires_at_ms)?;
                self.end_pending = false;
                self.controller = Some(controller_id.clone());
                self.expires = Some(deadline);
                self.mode = Mode::HumanPrivate;
                self.private = true;
            }
            ControlCommand::Renew {
                controller_id,
                lease_expires_at_ms,
            } => {
                if !self.human_allowed(epoch, controller_id) {
                    return Err("browser_control_expired");
                }
                let deadline = lease_deadline(*lease_expires_at_ms)?;
                self.expires = Some(self.expires.map_or(deadline, |old| old.max(deadline)));
            }
            ControlCommand::End => {
                if epoch <= self.epoch {
                    return Err("browser_stale_control");
                }
                self.request_end();
            }
        }
        if !matches!(command, ControlCommand::Renew { .. }) {
            self.media_fence += 1;
        }
        self.epoch = epoch;
        Ok(())
    }
}

fn lease_deadline(expires: u64) -> Result<Instant, &'static str> {
    let now = crate::util::now_millis();
    if expires <= now || expires > now + 6000 {
        return Err("browser_control_expired");
    }
    Ok(Instant::now() + Duration::from_millis(expires - now))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn acquired() -> Authority {
        let mut state = Authority::default();
        state.transition(1, &ControlCommand::Pause).unwrap();
        state
            .transition(
                2,
                &ControlCommand::Acquire {
                    controller_id: "one".into(),
                    lease_expires_at_ms: crate::util::now_millis() + 6000,
                },
            )
            .unwrap();
        state
    }
    #[test]
    fn expiry_retires_human_input_before_drain_and_cannot_be_renewed() {
        let mut state = acquired();
        state.expires = Some(Instant::now());
        assert!(!state.human_allowed(2, "one"));
        assert!(state.end_pending);
        assert!(!state.agent_allowed(2));
        assert!(state
            .transition(
                2,
                &ControlCommand::Renew {
                    controller_id: "one".into(),
                    lease_expires_at_ms: crate::util::now_millis() + 6000
                }
            )
            .is_err());
        state.resume_after_stop(2);
        assert!(state.agent_allowed(2));
        assert!(!state.human_allowed(2, "one"));
        assert!(!state.end_pending);
    }
    #[test]
    fn end_fences_old_media_and_rejects_late_control() {
        let mut state = acquired();
        let old = state.media_fence();
        state.transition(3, &ControlCommand::End).unwrap();
        assert!(!state.human_allowed(2, "one"));
        assert!(!state.agent_allowed(3));
        state.resume_after_stop(3);
        assert!(!state.media_allowed(2, None, Some(old)));
        assert!(state.media_allowed(3, None, Some(state.media_fence())));
        state.transition(4, &ControlCommand::Pause).unwrap();
        state
            .transition(
                5,
                &ControlCommand::Acquire {
                    controller_id: "two".into(),
                    lease_expires_at_ms: crate::util::now_millis() + 6000,
                },
            )
            .unwrap();
        assert!(state.transition(3, &ControlCommand::End).is_err());
        assert!(state.human_allowed(5, "two"));
    }
    #[test]
    fn restored_and_disconnected_private_authority_schedules_automatic_end() {
        let mut state = Authority::default();
        state.restore(true, true);
        assert!(state.end_pending);
        state.resume_after_stop(1);
        assert!(state.agent_allowed(1));
        let mut state = acquired();
        state.request_end();
        assert!(state.end_pending);
        assert!(!state.human_allowed(2, "one"));
    }
    #[test]
    fn delayed_deadlines_never_gain_a_fresh_six_seconds() {
        assert!(lease_deadline(crate::util::now_millis() - 1).is_err());
        assert!(lease_deadline(crate::util::now_millis() + 7000).is_err());
        let deadline = lease_deadline(crate::util::now_millis() + 1000).unwrap();
        assert!(deadline.duration_since(Instant::now()) <= Duration::from_millis(1000));
    }
}
