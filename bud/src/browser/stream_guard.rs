//! Input evidence for one immutable private screencast generation.
use serde_json::Value;
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub(super) const FRAME_AGE: Duration = Duration::from_secs(3);
const MAX_FRAMES: usize = 96;

/// Compositor frame offsets and layout metrics can disagree by a subpixel.
/// Only scroll positions get this bound; even a one-pixel resize must fence input.
pub(super) fn metric_matches(field: &str, expected: &Value, current: &Value) -> bool {
    let (Some(expected), Some(current)) = (expected.as_f64(), current.as_f64()) else {
        return false;
    };
    if !expected.is_finite() || !current.is_finite() {
        return false;
    }
    if matches!(field, "pageX" | "pageY") {
        (expected - current).abs() <= 0.5
    } else {
        expected == current
    }
}

pub(super) struct Evidence {
    pub token: String,
    pub metrics: Value,
    pub captured: Instant,
}

pub(super) struct StreamGuard {
    pub generation: String,
    pub target: String,
    pub document: String,
    pub width: f64,
    pub height: f64,
    pub live: Arc<AtomicBool>,
    frames: VecDeque<Evidence>,
}

impl StreamGuard {
    pub fn new(target: String, document: String, width: f64, height: f64) -> Self {
        Self {
            generation: ulid::Ulid::new().to_string(),
            target,
            document,
            width,
            height,
            live: Arc::new(AtomicBool::new(true)),
            frames: VecDeque::new(),
        }
    }
    pub fn invalidate(&self) {
        self.live.store(false, Ordering::SeqCst);
    }
    pub fn record(&mut self, metrics: Value, captured: Instant) -> Option<String> {
        if !self.live.load(Ordering::SeqCst)
            || captured.elapsed() >= FRAME_AGE
            || metrics["clientWidth"].as_f64() != Some(self.width)
            || metrics["clientHeight"].as_f64() != Some(self.height)
        {
            return None;
        }
        while self
            .frames
            .front()
            .is_some_and(|f| f.captured.elapsed() >= FRAME_AGE)
        {
            self.frames.pop_front();
        }
        if self.frames.len() >= MAX_FRAMES {
            self.frames.pop_front();
        }
        let token = format!("{}:{}", self.generation, ulid::Ulid::new());
        self.frames.push_back(Evidence {
            token: token.clone(),
            metrics,
            captured,
        });
        Some(token)
    }
    pub fn resolve(
        &self,
        target: &str,
        document: &str,
        token: &str,
        scroll: bool,
    ) -> Option<&Evidence> {
        let receipt = self.frames.iter().find(|f| f.token == token);
        let context_matches = token.split_once(':').is_some_and(|(generation, suffix)| {
            generation == self.generation && !suffix.is_empty()
        });
        let reason = if !self.live.load(Ordering::SeqCst) {
            Some("generation_retired")
        } else if target != self.target || document != self.document {
            Some("target_or_document_changed")
        } else if !context_matches {
            Some("generation_mismatch")
        } else if scroll {
            self.frames.is_empty().then_some("no_frame_receipt")
        } else if let Some(receipt) = receipt {
            (receipt.captured.elapsed() >= FRAME_AGE).then_some("frame_expired")
        } else {
            Some("frame_not_retained")
        };
        if let Some(reason) = reason {
            tracing::info!(component = "browser_input", event = "evidence_rejected",
                reason, target_id = %self.target, scroll,
                frame_age_ms = receipt.map(|r| r.captured.elapsed().as_millis() as u64),
                newest_frame_age_ms = self.frames.back().map(|r| r.captured.elapsed().as_millis() as u64),
                retained_frames = self.frames.len(), "Browser input evidence rejected");
            return None;
        }
        if scroll {
            self.frames.back()
        } else {
            receipt
        }
    }
}
impl Drop for StreamGuard {
    fn drop(&mut self) {
        self.invalidate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn metrics() -> Value {
        json!({"clientWidth":440,"clientHeight":816,"pageX":0,"pageY":0})
    }
    #[test]
    fn subpixel_offsets_do_not_allow_resize_or_larger_motion() {
        for field in ["pageX", "pageY"] {
            assert!(metric_matches(
                field,
                &json!(278.666748046875),
                &json!(278.5)
            ));
            for delta in [-0.5, 0.0, 0.5] {
                assert!(metric_matches(field, &json!(100.), &json!(100. + delta)));
            }
            for delta in [-1., -0.5001, 0.5001, 1.] {
                assert!(!metric_matches(field, &json!(100.), &json!(100. + delta)));
            }
            assert!(!metric_matches(field, &Value::Null, &json!(0)));
        }
        for field in ["clientWidth", "clientHeight"] {
            assert!(metric_matches(field, &json!(816), &json!(816.)));
            assert!(!metric_matches(field, &json!(816), &json!(816.1)));
            assert!(!metric_matches(field, &json!(816), &json!(817)));
        }
    }
    #[test]
    fn displayed_older_frame_survives_new_frames_but_not_a_generation_fence() {
        let mut guard = StreamGuard::new("target".into(), "document".into(), 440., 816.);
        let first = guard.record(metrics(), Instant::now()).unwrap();
        guard.record(metrics(), Instant::now()).unwrap();
        assert!(guard.resolve("target", "document", &first, false).is_some());
        assert!(guard.resolve("foreign", "document", &first, true).is_none());
        assert!(guard
            .resolve("target", "new-document", &first, false)
            .is_none());
        guard.invalidate();
        assert!(guard.resolve("target", "document", &first, true).is_none());
        assert!(guard.record(metrics(), Instant::now()).is_none());
    }
    #[test]
    fn bounded_history_retains_wheel_context_without_reviving_clicks() {
        let mut guard = StreamGuard::new("target".into(), "document".into(), 440., 816.);
        let first = guard.record(metrics(), Instant::now()).unwrap();
        for _ in 0..MAX_FRAMES {
            guard.record(metrics(), Instant::now()).unwrap();
        }
        assert_eq!(guard.frames.len(), MAX_FRAMES);
        assert!(guard.resolve("target", "document", &first, false).is_none());
        assert!(guard.resolve("target", "document", &first, true).is_some());
        assert!(guard
            .record(metrics(), Instant::now() - FRAME_AGE)
            .is_none());
        assert!(guard
            .record(
                json!({"clientWidth":400,"clientHeight":816}),
                Instant::now()
            )
            .is_none());
    }
}
