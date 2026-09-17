//! Run explicitly with disposable Chrome; never uses the Bud daemon identity.
use super::*;

#[tokio::test]
#[ignore = "requires BUD_BROWSER_EXECUTABLE and the installed browser helper"]
async fn shared_process_keeps_workspaces_separate_and_shares_site_cookies() {
    let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("browser executable");
    let mut runtime = Browser::launch_mode(Path::new(&executable), false)
        .await
        .unwrap();
    let mut a = runtime.workspace("thread-a").await.unwrap();
    let mut b = runtime.workspace("thread-b").await.unwrap();
    assert!(Arc::ptr_eq(&a.process, &b.process));
    assert!(runtime.workspace("thread-a").await.is_err());
    let ta = a.targets().await.unwrap().remove(0).target_id;
    let tb = b.targets().await.unwrap().remove(0).target_id;
    assert_ne!(ta, tb);
    assert!(a.session(&tb).await.is_err());
    assert!(a
        .inspect(&tb, json!({"operation":"snapshot"}))
        .await
        .is_err());
    assert!(a.capture(&tb).await.is_err());
    assert!(b.session(&ta).await.is_err());

    let sa = a.session(&ta).await.unwrap();
    let sb = b.session(&tb).await.unwrap();
    a.cdp.call(Some(&sa), "Network.setCookie", json!({
        "url":"https://bud-fixture.invalid/", "name":"shared-login", "value":"fixture", "expires":4102444800_f64
    })).await.unwrap();
    let cookies = b
        .cdp
        .call(
            Some(&sb),
            "Network.getCookies",
            json!({"urls":["https://bud-fixture.invalid/"]}),
        )
        .await
        .unwrap();
    assert!(cookies["cookies"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["name"] == "shared-login" && c["value"] == "fixture"));
    for (browser, target, title) in [(&mut a, &ta, "Thread A"), (&mut b, &tb, "Thread B")] {
        let session = browser.session(target).await.unwrap();
        browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
            "expression":format!("document.body.innerHTML = '<h1>{title}</h1><button>Continue</button>'")
        })).await.unwrap();
    }
    let first = a
        .inspect(&ta, json!({"operation":"snapshot","compact":true}))
        .await
        .unwrap();
    let second = b
        .inspect(&tb, json!({"operation":"snapshot","compact":true}))
        .await
        .unwrap();
    assert!(first.to_string().contains("Thread A"));
    assert!(!first.to_string().contains("Thread B"));
    assert!(second.to_string().contains("Thread B"));
    // B's observation must not invalidate A's observed-role action.
    a.inspect(
        &ta,
        json!({"operation":"click","locator":{"role":"button","name":"Continue"}}),
    )
    .await
    .unwrap();

    a.cdp
        .call(
            Some(&sa),
            "Runtime.evaluate",
            json!({
                "expression":"window.open('about:blank')", "userGesture":true
            }),
        )
        .await
        .unwrap();
    let targets = a.targets().await.unwrap();
    assert_eq!(targets.len(), 2, "popup did not inherit its opener");
    assert_eq!(b.targets().await.unwrap().len(), 1);
    // An unassigned native page remains hidden from both workspaces.
    let unknown = runtime
        .cdp
        .call(None, "Target.createTarget", json!({"url":"about:blank"}))
        .await
        .unwrap();
    assert!(!a
        .targets()
        .await
        .unwrap()
        .iter()
        .any(|t| t.target_id == unknown["targetId"]));
    assert!(!b
        .targets()
        .await
        .unwrap()
        .iter()
        .any(|t| t.target_id == unknown["targetId"]));
    a.close().await.unwrap();
    assert!(!b.interrupted());
    assert_eq!(b.targets().await.unwrap()[0].target_id, tb);
    let cookies = b
        .cdp
        .call(
            Some(&sb),
            "Network.getCookies",
            json!({"urls":["https://bud-fixture.invalid/"]}),
        )
        .await
        .unwrap();
    assert_eq!(cookies["cookies"][0]["value"], "fixture");
    b.close().await.unwrap();
    let process = runtime.process.clone();
    runtime.close().await.unwrap();
    assert!(process.lock().unwrap().child.try_wait().unwrap().is_some());
}

#[tokio::test]
#[ignore = "requires BUD_BROWSER_EXECUTABLE and the installed browser helper"]
async fn page_hints_reopen_only_the_authorized_workspace_without_replaying_history() {
    let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("browser executable");
    let hints = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/fixture", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        while let Ok((mut socket, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buf = [0; 4096];
                let _ = socket.read(&mut buf).await;
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 16\r\nConnection: close\r\n\r\n<h1>Fixture</h1>").await;
            });
        }
    });
    let mut runtime = Browser::launch_mode(Path::new(&executable), false)
        .await
        .unwrap();
    runtime.recovery = Arc::new(Mutex::new(super::super::recovery::Recovery::load(Some(
        hints.path(),
    ))));
    let mut a = runtime.workspace("a").await.unwrap();
    let mut b = runtime.workspace("b").await.unwrap();
    let old_a = a.targets().await.unwrap()[0].target_id.clone();
    let old_b = b.targets().await.unwrap()[0].target_id.clone();
    for (browser, target) in [(&mut a, &old_a), (&mut b, &old_b)] {
        browser.navigate(target, &url).await.unwrap();
        for _ in 0..100 {
            if browser
                .targets()
                .await
                .unwrap()
                .iter()
                .any(|t| t.url == url)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(browser
            .targets()
            .await
            .unwrap()
            .iter()
            .any(|t| t.url == url));
        browser.save_pages(Some(target)).await.unwrap();
    }
    // User-closing B removes hints; stopping the process preserves A.
    b.close().await.unwrap();
    runtime.close().await.unwrap();
    drop(a);
    drop(b);
    drop(runtime);
    let mut runtime = Browser::launch_mode(Path::new(&executable), false)
        .await
        .unwrap();
    runtime.recovery = Arc::new(Mutex::new(super::super::recovery::Recovery::load(Some(
        hints.path(),
    ))));
    let mut a = runtime.workspace("a").await.unwrap();
    let mut b = runtime.workspace("b").await.unwrap();
    assert_eq!(a.targets().await.unwrap()[0].url, "about:blank");
    // Acquiring/observing a blank workspace must not overwrite unused hints.
    a.save_pages(None).await.unwrap();
    assert!(b.reopen_pages().await.is_err());
    let target = a.reopen_pages().await.unwrap();
    assert_ne!(target, old_a);
    assert!(a.session(&old_a).await.is_err());
    assert!(b.session(&target).await.is_err());
    assert!(a.reopen_pages().await.is_err(), "recovery was replayed");
    assert_eq!(a.targets().await.unwrap().len(), 1);
    let session = a.session(&target).await.unwrap();
    let history = a
        .cdp
        .call(Some(&session), "Page.getNavigationHistory", json!({}))
        .await
        .unwrap();
    assert!(history["entries"].as_array().unwrap().len() <= 2);
    runtime.close().await.unwrap();
    server.abort();
}
