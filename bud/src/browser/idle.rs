//! Daemon-local resource expiry. Durable session identity and public recovery
//! hints survive; expiration never returns private authority or replays a cell.
use super::*;

pub(super) const IDLE_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(60);

impl BrowserManager {
    pub(super) fn start_idle_expiry(&self) {
        if self.runtime.is_none() {
            return;
        }
        let mut task = self.idle_task.lock().unwrap();
        if task.as_ref().is_some_and(|task| !task.is_finished()) {
            return;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let entries = Arc::downgrade(&self.entries);
        let page = self.page_lock.clone();
        let authority = self.authority.clone();
        *task = Some(runtime.spawn(async move {
            loop {
                tokio::time::sleep(SWEEP_INTERVAL).await;
                let Some(entries) = entries.upgrade() else {
                    break;
                };
                expire(&entries, &page, &authority, Instant::now()).await;
            }
        }));
    }
}

pub(super) async fn expire(
    entries: &Mutex<HashMap<String, Arc<Slot>>>,
    page: &AsyncMutex<()>,
    authority: &Mutex<Authority>,
    now: Instant,
) {
    // Checkpointing, cells, input and cleanup share this lock. Never queue an
    // idle sweep behind interactive work, or wait on a running cell's worker.
    let Ok(_page) = page.try_lock() else { return };
    let slots: Vec<_> = {
        let entries = entries.lock().unwrap();
        entries
            .iter()
            .filter_map(|(id, slot)| {
                if Arc::strong_count(slot) > 1
                    || slot.media.load(std::sync::atomic::Ordering::Relaxed)
                {
                    *slot.last_used.lock().unwrap() = now;
                    return None;
                }
                if now.saturating_duration_since(*slot.last_used.lock().unwrap()) < IDLE_TIMEOUT {
                    return None;
                }
                Some((id.clone(), slot.clone()))
            })
            .collect()
    };
    for (id, slot) in slots {
        let Ok(mut worker) = slot.repl.try_lock() else {
            continue;
        };
        let Ok(mut state) = slot.state.try_lock() else {
            continue;
        };
        // A request may have been admitted since collecting candidates. Its
        // reservation wins; it will start/reuse the workspace normally.
        if Arc::strong_count(&slot) > 2
            || now.saturating_duration_since(*slot.last_used.lock().unwrap()) < IDLE_TIMEOUT
            || state.closed_at.is_some()
            || (state.browser.is_none() && worker.runtime.is_none())
        {
            continue;
        }
        let private = {
            let mut authority = authority.lock().unwrap();
            authority.expire();
            if authority.workspace_allowed(&id)
                && matches!(
                    authority.mode,
                    super::super::control::Mode::HumanPrivate
                        | super::super::control::Mode::ResumePending
                )
            {
                *slot.last_used.lock().unwrap() = now;
                continue;
            }
            authority.private_content()
        };
        let selected = state.target.clone();
        let result = async {
            if let Some(browser) = state.browser.as_mut() {
                browser.expire_idle(selected.as_deref(), private).await?;
            }
            worker.reset("idle_expired").await?;
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if result.is_err() {
            tracing::warn!(component="browser_lifecycle", event="idle_expiry_failed", session_id=%id,
                "Idle browser workspace cleanup will retry");
            continue;
        }
        state.browser = None;
        state.target = None;
        // Keep the scope/sequence fence and reset notice for the next ensure/cell.
        // Logical close is deliberately not set: this is automatically reusable.
        tracing::info!(component="browser_lifecycle", event="idle_expired", session_id=%id,
            "Browser workspace expired after 24 idle hours");
    }
}
