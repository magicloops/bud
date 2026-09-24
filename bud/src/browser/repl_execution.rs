//! Cell orchestration has no page lock. Each bridge operation acquires it anew.
use super::*;
use tokio::sync::OwnedMutexGuard;

impl BrowserManager {
    pub(super) async fn drain_repl_cells(&self) -> anyhow::Result<()> {
        let slots: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        for slot in slots {
            let mut worker = match tokio::time::timeout_at(deadline, slot.repl.lock()).await {
                Ok(worker) => worker,
                Err(_) => {
                    slot.repl_stop.send_replace(Some("takeover_timeout"));
                    // The cell terminates its worker and drops pending operation
                    // locks before releasing the workspace mutex.
                    tokio::time::timeout(Duration::from_secs(1), slot.repl.lock())
                        .await
                        .map_err(|_| anyhow::anyhow!("browser_repl_stop_unconfirmed"))?
                }
            };
            if worker.runtime.as_mut().is_some_and(|w| w.interrupted()) {
                worker.reset("interrupted").await?;
            }
        }
        Ok(())
    }

    pub(super) async fn stop_repl_cells(&self) -> anyhow::Result<()> {
        let slots: Vec<_> = self.entries.lock().unwrap().values().cloned().collect();
        for slot in &slots {
            slot.repl_stop.send_replace(Some("browser_stopped"));
        }
        for slot in slots {
            slot.repl.lock().await.reset("browser_stopped").await?;
        }
        Ok(())
    }

    pub(super) async fn execute_cell(
        &self,
        request: &Request,
        slot: Arc<Slot>,
        mut worker: OwnedMutexGuard<super::super::repl::Workspace>,
        authority_fence: u64,
    ) -> Reply {
        let Action::Exec { code } = &request.command else {
            unreachable!()
        };
        let mut stop = slot.repl_stop.subscribe();
        let mut connection = self.connection.subscribe();
        let mut cancellation = slot.cancel.subscribe();
        if !self.cell_authorized(request, &slot, authority_fence) {
            return Reply::error(request, "browser_private_or_paused", false);
        }
        if slot.cancel.borrow().as_deref() == Some(&request.request_id) {
            return Reply::error(request, "browser_canceled", false);
        }
        if request.expires_at_ms <= crate::util::now_millis() {
            return Reply::error(request, "browser_deadline", false);
        }
        if worker.runtime.as_mut().is_some_and(|w| w.interrupted())
            && worker.reset("worker_exit").await.is_err()
        {
            return Reply::error(request, "browser_repl_stop_unconfirmed", false);
        }
        let created = worker.runtime.is_none();
        if created {
            match super::super::repl::Runtime::spawn(self.runtime.as_ref().unwrap()) {
                Ok(mut runtime) => {
                    runtime.authority_fence = authority_fence;
                    worker.runtime = Some(runtime);
                }
                Err(_) => return Reply::error(request, "browser_repl_not_prepared", false),
            }
        }
        let generation = worker.runtime.as_ref().unwrap().generation.clone();
        let reset_reason = worker.reset_reason;
        let deadline = Duration::from_millis(
            request
                .expires_at_ms
                .saturating_sub(crate::util::now_millis())
                .min(30_000),
        );
        let mut dispatched = false;
        let dirty = std::sync::atomic::AtomicBool::new(false);
        let result = tokio::select! {
            biased;
            _ = stop.changed() => Err(*stop.borrow()),
            _ = connection.changed() => Err(Some("connection_lost")),
            _ = async { loop {
                if cancellation.borrow_and_update().as_deref() == Some(&request.request_id) { break; }
                if cancellation.changed().await.is_err() { break; }
            } } => Err(Some("canceled")),
            result = tokio::time::timeout(deadline, async {
                dispatched = true;
                worker.runtime.as_mut().unwrap().execute(
                    &request.request_id, code, |command| self.cell_operation(request, &slot, authority_fence, command, &dirty)).await
            }) =>
                match result { Ok(result) => result.map_err(|_| Some("worker_exit")), Err(_) => Err(Some("deadline")) },
        };
        if !dispatched {
            let code = match result {
                Err(Some("connection_lost")) => "browser_stale_connection",
                Err(Some("canceled")) => "browser_canceled",
                _ => "browser_private_or_paused",
            };
            let mut reply = Reply::error(request, code, false);
            reply.data = json!({"execution_state":"not_executed","runtime_generation":generation});
            return reply;
        }
        if let Err(reason) = &result {
            if worker.reset(reason.unwrap_or("interrupted")).await.is_err() {
                return Reply::error(request, "browser_repl_stop_unconfirmed", true);
            }
        }
        let entry = slot.state.lock().await;
        let stale = entry.closed_at.is_some()
            || entry.epoch != request.control_epoch
            || entry.sequence != request.sequence
            || entry.invocation.as_ref()
                != Some(&(request.invocation_id.clone(), request.invocation_fence));
        drop(entry);
        if stale || !self.cell_authorized(request, &slot, authority_fence) {
            let code = if self.connection.borrow().as_deref() != Some(&request.device_session_id) {
                "browser_stale_connection"
            } else if stale {
                "browser_stale_request"
            } else {
                "browser_private_or_paused"
            };
            if let Some(runtime) = worker.runtime.as_mut() {
                runtime.discard_trace();
            }
            let mut reply = Reply::error(request, code, true);
            reply.data = json!({"runtime_generation":generation, "runtime_reset":worker.runtime.is_none(),
                "reset_reason":worker.reset_reason, "execution_state":match &result {
                    Ok(data) if data["ok"] == true => "completed", Ok(_) => "failed", Err(_) => "interrupted" },
                "output_withheld":true});
            return reply;
        }
        if dirty.load(std::sync::atomic::Ordering::Relaxed) {
            slot.refresh.send_modify(|n| *n += 1);
        }
        match result {
            Ok(mut data) => {
                worker.reset_reason = None;
                data["runtime_created"] = json!(created);
                data["reset_reason"] = json!(reset_reason);
                data["execution_state"] = json!(if data["ok"] == true {
                    "completed"
                } else {
                    "failed"
                });
                // Trace data stays local and only survives the same authority fence
                // as cell output; the service still applies its own delivery fence.
                let trace_path = if let Some(runtime) = worker.runtime.as_mut() {
                    runtime
                        .publish_trace(
                            json!({"request_id":request.request_id,
                        "thread_id":request.thread_id,"session_id":request.session_id,
                        "invocation_id":request.invocation_id}),
                            &data,
                        )
                        .await
                } else {
                    None
                };
                // Trace I/O must not introduce a new output-delivery race.
                let entry = slot.state.lock().await;
                let stale = entry.closed_at.is_some()
                    || entry.epoch != request.control_epoch
                    || entry.sequence != request.sequence
                    || entry.invocation.as_ref()
                        != Some(&(request.invocation_id.clone(), request.invocation_fence));
                drop(entry);
                if stale || !self.cell_authorized(request, &slot, authority_fence) {
                    if let Some(runtime) = worker.runtime.as_mut() {
                        runtime.retract_trace(trace_path).await;
                    }
                    let code = if self.connection.borrow().as_deref()
                        != Some(&request.device_session_id)
                    {
                        "browser_stale_connection"
                    } else if stale {
                        "browser_stale_request"
                    } else {
                        "browser_private_or_paused"
                    };
                    let mut reply = Reply::error(request, code, true);
                    reply.data = json!({"runtime_generation":generation,
                        "execution_state":data["execution_state"],"output_withheld":true});
                    return reply;
                }
                let ok = data["ok"] == true;
                Reply {
                    request_id: request.request_id.clone(),
                    session_id: request.session_id.clone(),
                    generation: request.generation.clone(),
                    ok,
                    outcome: if ok { "completed" } else { "unknown" },
                    error: if ok {
                        None
                    } else {
                        Some("browser_repl_execution_failed")
                    },
                    data,
                }
            }
            Err(_) => {
                let mut reply = Reply::error(request, "browser_repl_interrupted", true);
                reply.data = json!({"runtime_generation":generation,"runtime_reset":true,
                    "reset_reason":worker.reset_reason,"execution_state":"interrupted"});
                reply
            }
        }
    }

    fn cell_authorized(&self, request: &Request, slot: &Slot, fence: u64) -> bool {
        let mut authority = slot.authority.lock().unwrap();
        self.connection.borrow().as_deref() == Some(&request.device_session_id)
            && authority.agent_allowed(request.browser_epoch)
            && authority.media_fence() == fence
    }

    async fn cell_operation(
        &self,
        request: &Request,
        slot: &Slot,
        fence: u64,
        command: Value,
        dirty: &std::sync::atomic::AtomicBool,
    ) -> anyhow::Result<Value> {
        let local = command["action"] == "repl";
        let action = if local {
            None
        } else {
            let action: Action = serde_json::from_value(command.clone())
                .map_err(|_| anyhow::anyhow!("browser_invalid_arguments"))?;
            if !matches!(
                action,
                Action::Open { .. }
                    | Action::Navigate { .. }
                    | Action::Inspect { .. }
                    | Action::Click { .. }
                    | Action::Focus { .. }
                    | Action::InsertText { .. }
            ) || !valid_action(&action)
            {
                anyhow::bail!("browser_invalid_arguments");
            }
            Some(action)
        };
        if !self.cell_authorized(request, slot, fence) {
            anyhow::bail!("browser_private_or_paused");
        }
        let _page = tokio::time::timeout(Duration::from_secs(4), slot.page_lock.lock())
            .await
            .map_err(|_| anyhow::anyhow!("browser_busy"))?;
        let mut entry = slot.state.lock().await;
        if !self.cell_authorized(request, slot, fence)
            || entry.closed_at.is_some()
            || request.expires_at_ms <= crate::util::now_millis()
            || slot.cancel.borrow().as_deref() == Some(&request.request_id)
            || entry.epoch != request.control_epoch
            || entry.sequence != request.sequence
        {
            anyhow::bail!("browser_stale_request");
        }
        let result = if let Some(action) = action {
            let mut operation = request.clone();
            operation.command = action;
            self.perform(&mut entry, self.runtime.as_ref().unwrap(), &operation)
                .await
        } else {
            self.repl_page_operation(&mut entry, request, command).await
        };
        if !self.cell_authorized(request, slot, fence) {
            anyhow::bail!("browser_private_or_paused");
        }
        // A failed action can still scroll or mutate before reporting an error.
        // Keep the viewer alive and refresh once at the cell boundary either way.
        dirty.store(true, std::sync::atomic::Ordering::Relaxed);
        if result.is_ok() {
            let selected = entry.target.clone();
            if let Some(browser) = entry.browser.as_mut() {
                if browser.save_pages(selected.as_deref()).await.is_err() {
                    tracing::warn!(
                        component = "browser_recovery",
                        "Browser checkpoint write unavailable"
                    );
                }
            }
        }
        result
    }
    async fn repl_page_operation(
        &self,
        entry: &mut Entry,
        request: &Request,
        command: Value,
    ) -> anyhow::Result<Value> {
        let browser = entry
            .browser
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("browser_interrupted"))?;
        let targets = browser.targets().await?;
        let operation = command["operation"].as_str().unwrap_or("");
        if operation == "tabs" {
            return Ok(json!(targets
                .iter()
                .map(
                    |t| json!({"target_id":t.target_id,"title":t.title,"url":t.url,
                "selected":entry.target.as_ref() == Some(&t.target_id)})
                )
                .collect::<Vec<_>>()));
        }
        if operation == "create_tab" {
            let url = match command.get("url") {
                None => None,
                Some(value) => Some(
                    value
                        .as_str()
                        .ok_or_else(|| anyhow::anyhow!("browser_invalid_arguments"))?
                        .to_owned(),
                ),
            };
            if !valid_action(&Action::Open { url: url.clone() }) {
                anyhow::bail!("browser_invalid_arguments");
            }
            let target = browser.create_page().await?;
            entry.target = Some(target.clone());
            browser.selected_explicitly();
            if let Some(url) = url {
                browser.navigate(&target, &url).await?;
            }
            return Ok(json!({"target_id":target}));
        }
        let target = command["target_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("browser_invalid_arguments"))?;
        if !targets.iter().any(|t| t.target_id == target) {
            anyhow::bail!("browser_target_not_found");
        }
        match operation {
            "select_tab" => {
                // Logical viewer selection; never bring the native window forward.
                entry.target = Some(target.into());
                browser.selected_explicitly();
                Ok(json!({"target_id":target,"selected":true}))
            }
            "close_tab" => {
                let selected = entry
                    .target
                    .as_deref()
                    .filter(|id| *id != target)
                    .map(str::to_owned)
                    .or_else(|| {
                        targets
                            .iter()
                            .find(|t| t.target_id != target)
                            .map(|t| t.target_id.clone())
                    });
                browser.close_page(target, selected.as_deref()).await?;
                entry.target = selected;
                Ok(json!({"closed":true,"target_id":target}))
            }
            "insert_text" => {
                let text = command["text"]
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() <= 8192)
                    .ok_or_else(|| anyhow::anyhow!("browser_invalid_arguments"))?;
                browser.insert_text_in_tab(target, text).await?;
                entry.target = Some(target.into());
                Ok(json!({"action_applied":true}))
            }
            "snapshot" | "visible_dom" => {
                for key in ["scope", "observation_id"] {
                    if !command[key].is_null()
                        && command[key]
                            .as_str()
                            .is_none_or(|s| s.is_empty() || s.len() > 128)
                    {
                        anyhow::bail!("browser_invalid_arguments");
                    }
                }
                browser.inspect(target, json!({"operation":operation,"full":true,"trace":super::super::repl::trace_enabled(),"scope":command["scope"],"observation_id":command["observation_id"]})).await
            }
            "frames" => browser.inspect(target, json!({"operation":"frames"})).await,
            "evaluate" => {
                if command["source"]
                    .as_str()
                    .is_none_or(|s| s.is_empty() || s.len() > 64 * 1024)
                    || command["argument"].to_string().len() > 64 * 1024
                    || (!command["frame_id"].is_null()
                        && command["frame_id"].as_str().is_none_or(|s| s.len() > 128))
                {
                    anyhow::bail!("browser_invalid_arguments");
                }
                browser
                    .inspect(
                        target,
                        json!({"operation":"evaluate","source":command["source"],
                    "argument":command["argument"],"frame_id":command["frame_id"]}),
                    )
                    .await
            }
            "screenshot" => browser.capture_scaled(target, Some(1.0)).await,
            "emit_image" => {
                let index = command["index"]
                    .as_u64()
                    .filter(|n| *n < 2)
                    .ok_or_else(|| anyhow::anyhow!("browser_image_limit"))?;
                let upload = request
                    .repl_images
                    .as_ref()
                    .and_then(|v| v.get(index as usize))
                    .ok_or_else(|| anyhow::anyhow!("browser_image_unsupported"))?;
                let frame = &command["frame"];
                if frame["target_id"] != target
                    || frame["image"].as_str().is_none_or(|s| s.len() > 1_400_000)
                    || !valid_action(&Action::Capture {
                        target_id: Some(target.into()),
                        endpoint: upload.endpoint.clone(),
                        ticket: upload.ticket.clone(),
                    })
                {
                    anyhow::bail!("browser_invalid_arguments");
                }
                super::super::capture::upload(&upload.endpoint, &upload.ticket, frame).await
            }
            _ => anyhow::bail!("browser_invalid_arguments"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (BrowserManager, Arc<Slot>) {
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime("unused")));
        manager.connect("device".into());
        let slot = Arc::new(Slot {
            owner: "owner".into(),
            thread: "thread".into(),
            generation: "generation".into(),
            cancel: watch::channel(None).0,
            repl: Arc::default(),
            repl_stop: watch::channel(None).0,
            authority: manager.authority.clone(),
            page_lock: manager.page_lock.clone(),
            media: false.into(),
            refresh: watch::channel(0).0,
            state: AsyncMutex::new(Entry {
                epoch: 1,
                sequence: 0,
                invocation: Some(("invocation".into(), 1)),
                connection: "device".into(),
                browser: None,
                target: None,
                closed_at: None,
            }),
        });
        manager
            .entries
            .lock()
            .unwrap()
            .insert("workspace".into(), slot.clone());
        (manager, slot)
    }
    fn request(sequence: u64, code: &str) -> Request {
        Request {
            browser_color: None,
            repl_images: None,
            request_id: format!("cell-{sequence}"),
            device_session_id: "device".into(),
            session_id: "workspace".into(),
            generation: "generation".into(),
            thread_id: "thread".into(),
            owner_user_id: "owner".into(),
            browser_id: "resource".into(),
            browser_epoch: 1,
            private_content: false,
            browser_paused: false,
            control_epoch: 1,
            sequence,
            expires_at_ms: crate::util::now_millis() + 30_000,
            invocation_id: "invocation".into(),
            invocation_fence: 1,
            command: Action::Exec { code: code.into() },
        }
    }
    #[tokio::test]
    async fn local_cells_preserve_state_and_release_the_page_lock() {
        let (manager, slot) = setup();
        let first = manager.execute(request(1, "var n = 7; n")).await;
        assert!(first.ok, "{first:?}");
        let call = manager.execute(request(
            2,
            "await new Promise(r => setTimeout(r, 100)); ++n",
        ));
        let (second, ()) = tokio::join!(call, async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert!(slot.page_lock.try_lock().is_ok());
            assert!(slot.state.try_lock().is_ok());
        });
        assert_eq!(second.data["text"], "8\n");
        assert_eq!(
            first.data["runtime_generation"],
            second.data["runtime_generation"]
        );
        assert_eq!(
            manager.execute(request(2, "n++")).await.error,
            Some("browser_stale_request")
        );
        manager.stop_repl_cells().await.unwrap();
    }
    #[tokio::test]
    async fn clean_takeover_retains_memory_and_stuck_takeover_resets_only_the_worker() {
        let (manager, slot) = setup();
        let first = manager.execute(request(1, "var n = 3")).await;
        assert!(first.ok, "{first:?}");
        manager.authority.lock().unwrap().pause();
        manager.drain_repl_cells().await.unwrap();
        assert_eq!(
            slot.repl.lock().await.runtime.as_ref().unwrap().generation,
            first.data["runtime_generation"]
        );
        assert_eq!(
            manager.execute(request(2, "console.log(n)")).await.error,
            Some("browser_private_or_paused")
        );
        manager.authority.lock().unwrap().resume_after_stop(2);
        let mut next = request(2, "console.log(n)");
        next.browser_epoch = 2;
        let resumed = manager.execute(next).await;
        assert_eq!(resumed.data["text"], "3\n");
        let mut stuck = request(3, "while(true) {}");
        stuck.browser_epoch = 2;
        let (stopped, ()) = tokio::join!(manager.execute(stuck), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            manager.authority.lock().unwrap().pause();
            manager.drain_repl_cells().await.unwrap();
        });
        assert!(!stopped.ok);
        assert!(slot.repl.lock().await.runtime.is_none());
    }
    #[tokio::test]
    async fn deadline_and_cancel_do_not_reexecute_a_cell() {
        let (manager, slot) = setup();
        let mut infinite = request(1, "while(true) {}");
        infinite.expires_at_ms = crate::util::now_millis() + 100;
        let result = manager.execute(infinite).await;
        assert!(!result.ok);
        assert!(slot.repl.lock().await.runtime.is_none());
        let next = manager.execute(request(2, "console.log(typeof n)")).await;
        assert!(next.ok, "{next:?}");
        let mut canceled = request(3, "var n = 1");
        canceled.command = Action::Cancel;
        manager.execute(canceled).await;
        let result = manager.execute(request(3, "var n = 1")).await;
        assert_eq!(result.error, Some("browser_canceled"));
        assert_eq!(
            manager
                .execute(request(4, "console.log(typeof n)"))
                .await
                .data["text"],
            "undefined\n"
        );
        manager.stop_repl_cells().await.unwrap();
    }
    #[tokio::test]
    async fn exceptions_keep_partial_state_and_duplicate_delivery_never_replays() {
        let (manager, _) = setup();
        let failed = manager
            .execute(request(1, "var n = 1; n++; throw Error('after effect')"))
            .await;
        assert!(!failed.ok);
        assert_eq!(failed.outcome, "unknown");
        assert_eq!(failed.data["execution_state"], "failed");
        let duplicate = manager.execute(request(1, "n++")).await;
        assert_eq!(duplicate.error, Some("browser_stale_request"));
        let next = manager.execute(request(2, "console.log(n)")).await;
        assert_eq!(next.data["text"], "2\n");
        assert_eq!(
            failed.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn idle_reconnect_preserves_memory_active_disconnect_resets_and_withholds_output() {
        let (manager, _) = setup();
        let first = manager.execute(request(1, "var saved = 7")).await;
        manager.disconnect();
        manager.connect("device-two".into());
        let mut next = request(2, "console.log(saved)");
        next.device_session_id = "device-two".into();
        let next = manager.execute(next).await;
        assert_eq!(next.data["text"], "7\n");
        assert_eq!(
            first.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        let mut active = request(
            3,
            "console.log('withhold'); await new Promise(r => setTimeout(r, 500))",
        );
        active.device_session_id = "device-two".into();
        let (lost, ()) = tokio::join!(manager.execute(active), async {
            tokio::time::sleep(Duration::from_millis(50)).await;
            manager.disconnect();
        });
        assert!(!lost.ok);
        assert_eq!(lost.data["output_withheld"], true);
        assert_eq!(lost.data["reset_reason"], "connection_lost");
        assert!(lost.data.get("text").is_none());
        manager.connect("device-three".into());
        let mut next = request(4, "console.log(typeof saved)");
        next.device_session_id = "device-three".into();
        let next = manager.execute(next).await;
        assert_eq!(next.data["text"], "undefined\n");
        assert_eq!(next.data["reset_reason"], "connection_lost");
        assert_ne!(
            first.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn takeover_withholds_completed_output_but_preserves_its_state() {
        let (manager, slot) = setup();
        let first = manager.execute(request(1, "var saved = 7")).await;
        let trace_directory = slot
            .repl
            .lock()
            .await
            .runtime
            .as_mut()
            .unwrap()
            .enable_trace_for_test();
        let (finished, ()) = tokio::join!(
            manager.execute(request(
                2,
                "saved++; await new Promise(r => setTimeout(r, 150)); 'withhold'"
            )),
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                manager.authority.lock().unwrap().pause();
                manager.drain_repl_cells().await.unwrap();
            }
        );
        assert_eq!(finished.data["execution_state"], "completed");
        assert_eq!(finished.data["output_withheld"], true);
        assert!(finished.data.get("text").is_none());
        assert_eq!(
            slot.repl.lock().await.runtime.as_ref().unwrap().generation,
            first.data["runtime_generation"]
        );
        assert!(!std::fs::read_dir(&trace_directory).unwrap().any(|f| f
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("trace-")));
        manager.authority.lock().unwrap().resume_after_stop(2);
        let mut next = request(3, "console.log(saved)");
        next.browser_epoch = 2;
        assert_eq!(manager.execute(next).await.data["text"], "8\n");
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn crash_is_not_replayed_and_next_cell_explains_heap_loss() {
        let (manager, slot) = setup();
        let first = manager.execute(request(1, "var saved = 7")).await;
        let crash = manager.execute(request(2, "process.exit(7)")).await;
        assert_eq!(crash.outcome, "unknown");
        assert_eq!(crash.data["execution_state"], "interrupted");
        assert!(slot.repl.lock().await.runtime.is_none());
        let next = manager
            .execute(request(3, "console.log(typeof saved)"))
            .await;
        assert_eq!(next.data["text"], "undefined\n");
        assert_eq!(next.data["reset_reason"], "worker_exit");
        assert_ne!(
            first.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn ownership_and_host_operation_allowlist_are_checked_before_effects() {
        let (manager, _) = setup();
        assert!(manager.execute(request(1, "var saved = 7")).await.ok);
        let mut foreign = request(2, "saved++");
        foreign.owner_user_id = "other".into();
        assert!(!manager.execute(foreign).await.ok);
        let mut foreign = request(2, "saved++");
        foreign.thread_id = "other".into();
        assert!(!manager.execute(foreign).await.ok);
        let mut foreign = request(2, "saved++");
        foreign.generation = "other".into();
        assert!(!manager.execute(foreign).await.ok);
        let mut foreign = request(2, "saved++");
        foreign.invocation_id = "other".into();
        assert!(!manager.execute(foreign).await.ok);
        let failed = manager
            .execute(request(
                2,
                "await browser.operation({action:'lifecycle', reset:true})",
            ))
            .await;
        assert!(!failed.ok);
        assert!(manager.authority.lock().unwrap().agent_allowed(1));
        assert_eq!(
            manager.execute(request(3, "console.log(saved)")).await.data["text"],
            "7\n"
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn canceled_running_cell_is_not_a_safe_rejection_or_an_implicit_replay() {
        let (manager, slot) = setup();
        assert!(manager.execute(request(1, "var saved = 7")).await.ok);
        let (canceled, ()) = tokio::join!(
            manager.execute(request(
                2,
                "saved++; await new Promise(r => setTimeout(r, 500))"
            )),
            async {
                tokio::time::sleep(Duration::from_millis(40)).await;
                let mut cancel = request(2, "");
                cancel.command = Action::Cancel;
                manager.execute(cancel).await;
            }
        );
        assert_eq!(canceled.outcome, "unknown");
        assert_eq!(canceled.data["reset_reason"], "canceled");
        assert!(slot.repl.lock().await.runtime.is_none());
        let next = manager
            .execute(request(3, "console.log(typeof saved)"))
            .await;
        assert_eq!(next.data["text"], "undefined\n");
        assert_eq!(next.data["reset_reason"], "canceled");
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn live_repl_operations_reuse_browser_guards_and_private_return_invalidates_references() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0; 4096];
                    let _ = socket.read(&mut buffer).await;
                    let body = r#"<html><title>Before</title><button onclick="document.title='After'">Continue</button></html>"#;
                    let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).as_bytes()).await;
                });
            }
        });
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let mut open = request(1, "");
        open.command = Action::Open { url: Some(url) };
        let opened = manager.execute(open).await;
        assert!(opened.ok, "{opened:?}");
        let snapshot_code = "var tab = await browser.tabs.current(); var observed = await tab.snapshot(); var button = observed.nodes.find(n => n.role === 'button'); var handle = tab.getByReference(button.reference); console.log(button.name)";
        let first = manager.execute(request(2, snapshot_code)).await;
        assert!(first.ok, "{first:?}");
        assert_eq!(first.data["text"], "Continue\n");
        let controller = "viewer".to_string();
        for (i, control) in [
            ControlCommand::Pause,
            ControlCommand::Acquire {
                controller_id: controller.clone(),
            },
            ControlCommand::PrepareReturn {
                controller_id: controller,
            },
            ControlCommand::FinishReturn,
        ]
        .into_iter()
        .enumerate()
        {
            let mut r = request(3 + i as u64, "");
            r.control_epoch = 2 + i as u64;
            r.browser_epoch = r.control_epoch;
            r.command = Action::Control { control };
            let result = manager.execute(r).await;
            assert!(result.ok, "{result:?}");
        }
        let click = "await handle.click()";
        let mut stale = request(7, click);
        stale.control_epoch = 6;
        stale.browser_epoch = 6;
        let stale = manager.execute(stale).await;
        assert!(!stale.ok, "{stale:?}");
        assert_eq!(
            first.data["runtime_generation"],
            stale.data["runtime_generation"]
        );
        let mut fresh = request(
            8,
            &format!("{snapshot_code}; {click}; console.log(await tab.title())"),
        );
        fresh.control_epoch = 6;
        fresh.browser_epoch = 6;
        let fresh = manager.execute(fresh).await;
        assert!(fresh.ok, "{fresh:?}");
        assert!(
            fresh.data["text"].as_str().unwrap().contains("After"),
            "{fresh:?}"
        );
        // Worker death cannot close or reset the independently owned Chrome.
        let mut crash = request(9, "process.exit(7)");
        crash.control_epoch = 6;
        crash.browser_epoch = 6;
        assert_eq!(
            manager.execute(crash).await.data["execution_state"],
            "interrupted"
        );
        let mut info = request(
            10,
            "console.log(typeof observed); console.log(await (await browser.tabs.current()).title())",
        );
        info.control_epoch = 6;
        info.browser_epoch = 6;
        let recovered = manager.execute(info).await;
        assert!(recovered.ok, "{recovered:?}");
        assert_eq!(recovered.data["text"], "undefined\nAfter\n");
        assert_ne!(
            first.data["runtime_generation"],
            recovered.data["runtime_generation"]
        );
        manager.shutdown().await.unwrap();
        server.abort();
    }
    #[tokio::test]
    async fn live_selective_facade_keeps_full_snapshot_local_and_evaluates_owned_frames() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let _ = socket.read(&mut [0; 4096]).await;
                    let links = (0..500)
                        .map(|i| {
                            format!("<li><a href='/{i}?exact=a%2Fb#section'>Story {i}</a></li>")
                        })
                        .collect::<String>();
                    let body=format!("<html><title>Selective</title><ul>{links}</ul><iframe srcdoc='<p>Frame evidence</p>'></iframe></html>");
                    let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await;
                });
            }
        });
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let mut open = request(1, "");
        open.command = Action::Open { url: Some(url) };
        assert!(manager.execute(open).await.ok);
        let first=manager.execute(request(2,"var tab=await browser.tabs.current(); var saved=await tab.snapshot(); console.log(JSON.stringify({large:JSON.stringify(saved).length>32768,last:saved.nodes.filter(n=>n.role==='link').at(-1).name,truncated:saved.truncated}))")).await;
        assert!(first.ok, "{first:?}");
        assert_eq!(
            first.data["text"],
            "{\"large\":true,\"last\":\"Story 499\",\"truncated\":false}\n"
        );
        assert!(!first.data.to_string().contains("Story 498"));
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("workspace")
            .unwrap()
            .clone();
        if super::super::super::repl::trace_enabled() {
            let directory = slot
                .repl
                .lock()
                .await
                .runtime
                .as_mut()
                .unwrap()
                .enable_trace_for_test();
            let traces: Vec<Value> = std::fs::read_dir(directory)
                .unwrap()
                .filter_map(|file| {
                    let file = file.unwrap();
                    file.file_name()
                        .to_string_lossy()
                        .starts_with("trace-")
                        .then(|| {
                            serde_json::from_slice(&std::fs::read(file.path()).unwrap()).unwrap()
                        })
                })
                .collect();
            assert!(traces
                .iter()
                .any(
                    |trace| trace["stages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|stage| stage["stage"] == "upstream_snapshot"
                            && stage["value"]["content"]
                                .as_str()
                                .unwrap()
                                .contains("Story 499"))
                ));
            assert!(!first.data.to_string().contains("_bud_trace"));
        }
        let revision = *slot.refresh.borrow();
        let cached = manager
            .execute(request(
                3,
                "console.log(saved.nodes.filter(n=>n.role==='link').at(-2).url)",
            ))
            .await;
        assert!(cached.ok, "{cached:?}");
        assert!(cached.data["text"]
            .as_str()
            .unwrap()
            .contains("?exact=a%2Fb#section"));
        assert_eq!(
            revision,
            *slot.refresh.borrow(),
            "local work must not capture"
        );
        let eval=manager.execute(request(4,"console.log(await tab.evaluate(x=>({title:document.title,value:x}),7)); var frames=await tab.frames(); console.log(await tab.frame(frames.find(f=>!f.main).frame_id).evaluate(()=>document.body.textContent))")).await;
        assert!(eval.ok, "{eval:?}");
        assert!(eval.data["text"]
            .as_str()
            .unwrap()
            .contains("Frame evidence"));
        let foreign = manager
            .execute(request(
                5,
                "await browser.tabs.get('foreign').evaluate(()=>document.title)",
            ))
            .await;
        assert!(!foreign.ok);
        assert!(foreign.data["error"]
            .as_str()
            .unwrap()
            .contains("target_not_found"));
        let capture=manager.execute(request(6,"var shot=await tab.screenshot(); console.log(JSON.stringify({image:Buffer.isBuffer(shot),bytes:shot.length>0}))")).await;
        assert!(capture.ok, "{capture:?}");
        assert_eq!(capture.data["text"], "{\"image\":true,\"bytes\":true}\n");
        let unsupported = manager
            .execute(request(7, "await repl.emitImage(shot)"))
            .await;
        assert!(!unsupported.ok);
        assert!(unsupported.data["error"]
            .as_str()
            .unwrap()
            .contains("image_unsupported"));
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn live_interactions_tab_lifetime_and_partial_effects_preserve_workspace() {
        let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
            return;
        };
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "http://{}/?exact=a%2Fb#fragment",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let _ = socket.read(&mut [0; 4096]).await;
                    let body = r#"<html><title>Form</title><input aria-label="Note"><button onclick="document.title='Applied';window.clicks=(window.clicks||0)+1">Apply</button><button>Duplicate</button><button>Duplicate</button><div style="height:5000px">Long page</div></html>"#;
                    let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await;
                });
            }
        });
        let manager = BrowserManager::new(Some(crate::browser::addon::test_runtime(executable)));
        manager.connect("device".into());
        let mut open = request(1, "");
        open.command = Action::Open {
            url: Some(url.clone()),
        };
        assert!(manager.execute(open).await.ok);
        let first = manager.execute(request(2, "var tab=await browser.tabs.current(); var saved=await tab.snapshot(); var oldHandle=tab.getByRole('button',{name:'Apply'}); await tab.getByRole('textbox',{name:'Note'}).fill('Hello'); await tab.getByReference(saved.nodes.find(n=>n.role==='textbox').reference).focus(); await tab.insertText('!'); console.log(await tab.evaluate(()=>document.querySelector('input').value)); await oldHandle.click(); console.log(await tab.title())")).await;
        assert!(first.ok, "{first:?}");
        assert!(first.data["text"].as_str().unwrap().contains("Hello"));
        assert!(first.data["text"].as_str().unwrap().contains('!'));
        assert!(first.data["text"].as_str().unwrap().contains("Applied"));
        let slot = manager
            .entries
            .lock()
            .unwrap()
            .get("workspace")
            .unwrap()
            .clone();
        let revision = *slot.refresh.borrow();
        // Fresh observation retires a previously constructed role/name handle.
        let stale = manager
            .execute(request(3, "await tab.snapshot(); await oldHandle.click()"))
            .await;
        assert!(!stale.ok, "{stale:?}");
        assert!(stale.data["error"]
            .as_str()
            .unwrap()
            .contains("stale_reference"));
        assert!(*slot.refresh.borrow() > revision);
        let partial = manager.execute(request(4,"await tab.getByRole('button',{name:'Apply'}).click(); await tab.getByRole('button',{name:'Duplicate'}).click()")).await;
        assert!(!partial.ok, "{partial:?}");
        assert_eq!(partial.outcome, "unknown");
        assert!(partial.data["error"]
            .as_str()
            .unwrap()
            .contains("ambiguous"));
        let checked = manager.execute(request(5,"console.log(await tab.evaluate(()=>window.clicks)); await tab.scroll(400); var second=await browser.tabs.create(); console.log((await browser.tabs.list()).length); await tab.select(); console.log((await browser.tabs.current()).id===tab.id)")).await;
        assert!(checked.ok, "{checked:?}");
        assert_eq!(checked.data["text"], "2\n2\ntrue\n");
        let wrong_focus = manager.execute(request(6,"await tab.snapshot(); await tab.getByRole('textbox',{name:'Note'}).focus(); await second.insertText('wrong tab')")).await;
        assert!(!wrong_focus.ok, "{wrong_focus:?}");
        assert!(wrong_focus.data["error"]
            .as_str()
            .unwrap()
            .contains("focus_required"));
        let navigate = manager.execute(request(7,&format!("var oldField=tab.getByRole('textbox',{{name:'Note'}}); await tab.goto({}); await oldField.fill('stale')",json!(url)))).await;
        assert!(!navigate.ok, "{navigate:?}");
        assert!(navigate.data["error"]
            .as_str()
            .unwrap()
            .contains("stale_reference"));
        // Another workspace's target IDs grant no access through any tab operation.
        let other_request = |sequence, code: &str| {
            let mut r = request(sequence, code);
            r.session_id = "other-workspace".into();
            r.thread_id = "other-thread".into();
            r.generation = "other-generation".into();
            r.request_id = format!("other-{sequence}");
            r
        };
        let mut other = other_request(1, "");
        other.command = Action::Open { url: Some(url) };
        let other = manager.execute(other).await;
        assert!(other.ok, "{other:?}");
        let foreign_id = other.data["target_id"].as_str().unwrap();
        for (sequence, method) in [
            (8, "select()"),
            (9, "close()"),
            (10, "snapshot()"),
            (11, "insertText('foreign')"),
        ] {
            let result = manager
                .execute(request(
                    sequence,
                    &format!("await browser.tabs.get({}).{method}", json!(foreign_id)),
                ))
                .await;
            assert!(!result.ok, "{result:?}");
            assert!(result.data["error"]
                .as_str()
                .unwrap()
                .contains("target_not_found"));
        }
        let closed=manager.execute(request(12,"await second.close(); await tab.close(); console.log(await browser.tabs.current()); console.log((await browser.tabs.list()).length); console.log(saved.nodes.some(n=>n.name==='Apply'))")).await;
        assert!(closed.ok, "{closed:?}");
        assert_eq!(closed.data["text"], "null\n0\ntrue\n");
        assert_eq!(
            first.data["runtime_generation"],
            closed.data["runtime_generation"]
        );
        assert!(slot
            .state
            .lock()
            .await
            .browser
            .as_ref()
            .unwrap()
            .checkpoint_for_test()
            .is_none());
        let closed_handle = manager.execute(request(13, "await tab.snapshot()")).await;
        assert!(!closed_handle.ok);
        let reopened=manager.execute(request(14,"var replacement=await browser.tabs.open(); console.log(await replacement.url()); console.log((await browser.tabs.list()).length)")).await;
        assert!(reopened.ok, "{reopened:?}");
        assert_eq!(reopened.data["text"], "about:blank\n1\n");
        let other_alive = manager
            .execute(other_request(
                2,
                "console.log((await browser.tabs.list()).length)",
            ))
            .await;
        assert_eq!(other_alive.data["text"], "1\n");
        manager.shutdown().await.unwrap();
        server.abort();
    }

    #[tokio::test]
    async fn daemon_restart_replaces_heap_without_replaying_prior_source() {
        let (old, _) = setup();
        let first = old.execute(request(1, "var saved = 7")).await;
        assert!(first.ok);
        old.shutdown().await.unwrap();
        let (new, _) = setup();
        let mut r = request(2, "console.log(typeof saved)");
        r.device_session_id = "new-device".into();
        new.connect("new-device".into());
        assert_eq!(
            new.execute(request(1, "var saved = 99")).await.error,
            Some("browser_stale_connection")
        );
        let next = new.execute(r).await;
        assert_eq!(next.data["text"], "undefined\n");
        assert_eq!(next.data["runtime_created"], true);
        assert_ne!(
            first.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        new.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn parallel_workspaces_do_not_share_bindings_or_block_local_cells() {
        let (manager, _) = setup();
        // A second workspace on the same manager shares Chrome authority/page
        // serialization, but has its own JavaScript lifecycle.
        let second = Arc::new(Slot {
            owner: "owner".into(),
            thread: "other-thread".into(),
            generation: "other-generation".into(),
            cancel: watch::channel(None).0,
            repl: Arc::default(),
            repl_stop: watch::channel(None).0,
            authority: manager.authority.clone(),
            page_lock: manager.page_lock.clone(),
            media: false.into(),
            refresh: watch::channel(0).0,
            state: AsyncMutex::new(Entry {
                epoch: 1,
                sequence: 0,
                invocation: Some(("invocation".into(), 1)),
                connection: "device".into(),
                browser: None,
                target: None,
                closed_at: None,
            }),
        });
        manager
            .entries
            .lock()
            .unwrap()
            .insert("other-workspace".into(), second);
        assert!(manager.execute(request(1, "var saved = 7")).await.ok);
        let mut other = request(1, "console.log(typeof saved)");
        other.session_id = "other-workspace".into();
        other.generation = "other-generation".into();
        other.thread_id = "other-thread".into();
        other.request_id = "other-call".into();
        let (long, short) = tokio::join!(
            manager.execute(request(
                2,
                "await new Promise(r => setTimeout(r, 300)); console.log(saved)"
            )),
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                let busy = manager.execute(request(3, "saved++")).await;
                assert_eq!(busy.error, Some("browser_busy"));
                manager.execute(other).await
            }
        );
        assert_eq!(short.data["text"], "undefined\n");
        assert_eq!(long.data["text"], "7\n");
        assert_ne!(
            short.data["runtime_generation"],
            long.data["runtime_generation"]
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_admission_keeps_existing_memory() {
        let (manager, slot) = setup();
        let first = manager.execute(request(1, "var saved = 7")).await;
        let page = slot.page_lock.lock().await;
        let (canceled, ()) = tokio::join!(manager.execute(request(2, "saved++")), async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            let mut cancel = request(2, "");
            cancel.command = Action::Cancel;
            manager.execute(cancel).await;
            drop(page);
        });
        assert_eq!(canceled.outcome, "rejected");
        let next = manager.execute(request(3, "console.log(saved)")).await;
        assert_eq!(next.data["text"], "7\n");
        assert_eq!(
            first.data["runtime_generation"],
            next.data["runtime_generation"]
        );
        manager.stop_repl_cells().await.unwrap();
    }

    #[tokio::test]
    async fn superseded_cell_withholds_output_even_if_local_code_completes() {
        let (manager, slot) = setup();
        assert!(manager.execute(request(1, "var saved = 7")).await.ok);
        let (finished, ()) = tokio::join!(
            manager.execute(request(
                2,
                "saved++; await new Promise(r => setTimeout(r, 150)); 'withhold'"
            )),
            async {
                tokio::time::sleep(Duration::from_millis(30)).await;
                slot.state.lock().await.invocation = Some(("replacement".into(), 2));
            }
        );
        assert_eq!(finished.error, Some("browser_stale_request"));
        assert_eq!(finished.data["execution_state"], "completed");
        assert_eq!(finished.data["output_withheld"], true);
        assert!(finished.data.get("text").is_none());
        manager.stop_repl_cells().await.unwrap();
    }
}
