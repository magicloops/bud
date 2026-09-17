use bud_browser_spike::Browser;
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const PAGE: &str = r#"<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bud browser fixture</title><h1>Browser handoff fixture</h1>
<label>Name <input id="name" aria-label="Name"></label>
<label>Password <input id="password" type="password" aria-label="Password"></label>
<button onclick="document.querySelector('h1').textContent='Submitted'; document.querySelector('#password').value=''">Submit</button>
<button onclick="window.open('/popup','_blank')">Open popup</button>
<button onclick="document.querySelector('#name').focus()">Change focus</button>
<a href="/next">Next document</a>"#;

async fn fixture() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let count = socket.read(&mut request).await.unwrap_or(0);
            if count == 0 {
                continue;
            }
            let request = String::from_utf8_lossy(&request[..count]);
            let body = if request.starts_with("GET /focus-race ") {
                PAGE.replace("id=\"password\"", "id=\"password\" onfocus=\"setTimeout(() => { document.querySelector('#name').focus(); document.querySelector('h1').textContent='Focus moved'; }, 50)\"")
            } else if request.starts_with("GET /navigation-race ") {
                PAGE.replace(
                    "id=\"password\"",
                    "id=\"password\" onfocus=\"setTimeout(() => location.href='/next', 50)\"",
                )
            } else {
                PAGE.into()
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = socket.write_all(response.as_bytes()).await;
        }
    });
    (url, task)
}

fn executable() -> PathBuf {
    std::env::var_os("BUD_BROWSER_EXECUTABLE")
        .expect("Set BUD_BROWSER_EXECUTABLE to installed Chromium")
        .into()
}

async fn ready(
    browser: &mut Browser,
    epoch: u64,
    viewer: Option<&str>,
    target: &str,
) -> bud_browser_spike::Observation {
    for _ in 0..100 {
        if let Ok(observation) = browser.observe(epoch, viewer, target).await {
            if observation.elements.iter().any(|e| e.name == "Name") {
                return observation;
            }
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("fixture not ready");
}

#[tokio::test]
#[ignore = "launches installed Chromium; run explicitly with BUD_BROWSER_EXECUTABLE"]
async fn same_process_private_handoff_navigation_and_popup() {
    let (url, fixture_task) = fixture().await;
    let mut browser = Browser::launch(&executable()).await.unwrap();
    let pid = browser.process_id();
    println!("tested_browser={}", browser.version().await.unwrap());
    let target = browser.targets(1, None).await.unwrap().remove(0).target_id;
    browser.navigate(1, None, &target, &url).await.unwrap();
    let observation = ready(&mut browser, 1, None, &target).await;
    let old_name = observation
        .elements
        .iter()
        .find(|e| e.role == "textbox" && e.name == "Name")
        .unwrap()
        .reference
        .clone();
    let epoch = browser.takeover(1, "phone").unwrap();
    assert!(browser.observe(epoch, None, &target).await.is_err());
    assert!(browser.capture(epoch, None, &target).await.is_err());
    assert!(browser.targets(epoch, None).await.is_err());
    assert!(browser
        .observe(epoch, Some("other-viewer"), &target)
        .await
        .is_err());
    assert!(browser
        .focus(epoch, Some("phone"), &old_name)
        .await
        .is_err());

    let observation = ready(&mut browser, epoch, Some("phone"), &target).await;
    let password = observation
        .elements
        .iter()
        .find(|e| e.role == "textbox" && e.name == "Password")
        .unwrap()
        .reference
        .clone();
    browser
        .focus(epoch, Some("phone"), &password)
        .await
        .unwrap();
    browser
        .insert_text(epoch, Some("phone"), "fixture-secret-密碼🔑")
        .await
        .unwrap();
    let observation = browser
        .observe(epoch, Some("phone"), &target)
        .await
        .unwrap();
    assert!(!serde_json::to_string(&observation)
        .unwrap()
        .contains("fixture-secret"));
    let frame = browser
        .capture(epoch, Some("phone"), &target)
        .await
        .unwrap();
    assert_eq!(&frame[..2], &[0xff, 0xd8]);
    let submit = observation
        .elements
        .iter()
        .find(|e| e.role == "button" && e.name == "Submit")
        .unwrap()
        .reference
        .clone();
    browser.click(epoch, Some("phone"), &submit).await.unwrap();

    let returned = browser
        .return_to_agent(epoch, "phone", &target)
        .await
        .unwrap();
    assert!(returned.elements.iter().any(|e| e.name == "Submitted"));
    assert_eq!(browser.process_id(), pid);
    assert!(browser
        .insert_text(epoch, Some("phone"), "stale")
        .await
        .is_err());
    let agent_epoch = browser.control.epoch;
    let popup = returned
        .elements
        .iter()
        .find(|e| e.role == "button" && e.name == "Open popup")
        .unwrap()
        .reference
        .clone();
    browser.click(agent_epoch, None, &popup).await.unwrap();
    let targets = browser.targets(agent_epoch, None).await.unwrap();
    assert_eq!(targets.len(), 2, "popup should remain a separate target");

    let observation = ready(&mut browser, agent_epoch, None, &target).await;
    let name = observation
        .elements
        .iter()
        .find(|e| e.role == "textbox" && e.name == "Name")
        .unwrap()
        .reference
        .clone();
    browser.focus(agent_epoch, None, &name).await.unwrap();
    browser
        .navigate(agent_epoch, None, &target, &format!("{url}/next"))
        .await
        .unwrap();
    ready(&mut browser, agent_epoch, None, &target).await;
    assert!(browser.focus(agent_epoch, None, &name).await.is_err());
    assert!(browser
        .insert_text(agent_epoch, None, "must-not-reach-new-page")
        .await
        .is_err());
    browser.close().await.unwrap();
    fixture_task.abort();
}

#[tokio::test]
#[ignore = "launches installed Chromium; run explicitly with BUD_BROWSER_EXECUTABLE"]
async fn instances_are_isolated_and_close_is_scoped() {
    let mut first = Browser::launch(&executable()).await.unwrap();
    let mut second = Browser::launch(&executable()).await.unwrap();
    assert_ne!(first.process_id(), second.process_id());
    let first_target = first.targets(1, None).await.unwrap().remove(0).target_id;
    assert!(second.observe(1, None, &first_target).await.is_err());
    first.close().await.unwrap();
    assert_eq!(second.targets(1, None).await.unwrap().len(), 1);
    second.close().await.unwrap();
}

#[tokio::test]
#[ignore = "launches installed Chromium; run explicitly with BUD_BROWSER_EXECUTABLE"]
async fn page_initiated_focus_and_navigation_changes_reject_buffered_text() {
    let (url, fixture_task) = fixture().await;
    let mut browser = Browser::launch(&executable()).await.unwrap();
    let target = browser.targets(1, None).await.unwrap().remove(0).target_id;
    let epoch = browser.takeover(1, "phone").unwrap();
    for path in ["focus-race", "navigation-race"] {
        browser
            .navigate(epoch, Some("phone"), &target, &format!("{url}/{path}"))
            .await
            .unwrap();
        let observation = ready(&mut browser, epoch, Some("phone"), &target).await;
        let field = &observation
            .elements
            .iter()
            .find(|e| e.role == "textbox" && e.name == "Password")
            .unwrap()
            .reference;
        browser.focus(epoch, Some("phone"), field).await.unwrap();
        let mut changed = false;
        for _ in 0..100 {
            if let Ok(current) = browser.observe(epoch, Some("phone"), &target).await {
                if current.document_id != observation.document_id
                    || current.elements.iter().any(|e| e.name == "Focus moved")
                {
                    changed = true;
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(changed, "fixture did not establish {path}");
        assert!(
            browser
                .insert_text(epoch, Some("phone"), "must-not-reach-another-field")
                .await
                .is_err(),
            "{path}"
        );
    }
    browser.close().await.unwrap();
    fixture_task.abort();
}
