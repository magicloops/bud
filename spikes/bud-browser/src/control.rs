//! Host-side admission, independent of browser transport. Serialized by the
//! browser owner; neither a viewer nor an agent can choose its own epoch.
use anyhow::{bail, Result};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Controller {
    Agent,
    Human(String),
    Paused,
    ResumePending,
}

pub struct Control {
    pub epoch: u64,
    pub controller: Controller,
    deadline: Option<Instant>,
}

impl Default for Control {
    fn default() -> Self {
        Self {
            epoch: 1,
            controller: Controller::Agent,
            deadline: None,
        }
    }
}

impl Control {
    pub fn expire(&mut self, now: Instant) {
        if self.deadline.is_some_and(|deadline| now >= deadline) {
            self.pause();
        }
    }

    pub fn admit(&mut self, epoch: u64, human: Option<&str>, now: Instant) -> Result<()> {
        self.expire(now);
        if epoch != self.epoch {
            bail!("stale_control_epoch");
        }
        match (&self.controller, human) {
            (Controller::Agent, None) => Ok(()),
            (Controller::Human(controller), Some(viewer)) if controller == viewer => Ok(()),
            _ => bail!("browser_control_denied"),
        }
    }

    pub fn takeover(&mut self, epoch: u64, viewer: &str, now: Instant) -> Result<u64> {
        self.expire(now);
        if epoch != self.epoch {
            bail!("stale_control_epoch");
        }
        if !matches!(self.controller, Controller::Agent | Controller::Paused) {
            bail!("browser_controller_busy");
        }
        self.epoch += 1;
        self.controller = Controller::Human(viewer.into());
        self.deadline = Some(now + Duration::from_secs(15));
        Ok(self.epoch)
    }

    pub fn heartbeat(&mut self, epoch: u64, viewer: &str, now: Instant) -> Result<()> {
        self.admit(epoch, Some(viewer), now)?;
        self.deadline = Some(now + Duration::from_secs(15));
        Ok(())
    }

    pub fn pause(&mut self) {
        self.epoch += 1;
        self.controller = Controller::Paused;
        self.deadline = None;
    }

    pub fn begin_return(&mut self, epoch: u64, viewer: &str, now: Instant) -> Result<()> {
        self.admit(epoch, Some(viewer), now)?;
        self.epoch += 1;
        self.controller = Controller::ResumePending;
        self.deadline = None;
        Ok(())
    }

    pub fn complete_return(&mut self) -> Result<u64> {
        if self.controller != Controller::ResumePending {
            bail!("browser_not_resuming");
        }
        self.controller = Controller::Agent;
        Ok(self.epoch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handoff_fences_observers_and_old_inputs() {
        let now = Instant::now();
        let mut state = Control::default();
        let human_epoch = state.takeover(1, "phone", now).unwrap();
        assert!(state.admit(1, None, now).is_err());
        assert!(state.admit(human_epoch, None, now).is_err());
        assert!(state.admit(human_epoch, Some("web"), now).is_err());
        assert!(state.takeover(human_epoch, "web", now).is_err());
        state.begin_return(human_epoch, "phone", now).unwrap();
        assert!(state.admit(state.epoch, None, now).is_err());
        let agent_epoch = state.complete_return().unwrap();
        assert!(state.admit(human_epoch, Some("phone"), now).is_err());
        state.admit(agent_epoch, None, now).unwrap();
    }

    #[test]
    fn expired_lease_never_resumes_agent_or_accepts_late_heartbeat() {
        let now = Instant::now();
        let mut state = Control::default();
        let epoch = state.takeover(1, "phone", now).unwrap();
        assert!(state
            .heartbeat(epoch, "phone", now + Duration::from_secs(15))
            .is_err());
        assert_eq!(state.controller, Controller::Paused);
        assert!(state.admit(state.epoch, None, now).is_err());
        assert!(state.begin_return(epoch, "phone", now).is_err());
        state.takeover(state.epoch, "web", now).unwrap();
    }
}
