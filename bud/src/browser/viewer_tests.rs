use super::*;
use crate::browser::viewer::HumanInput;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn live_private_capture_input_and_stale_frame_guard() {
    let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
        return;
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0; 4096];
                let _ = socket.read(&mut buffer).await;
                let body="<!doctype html><style>body{margin:20px}input{width:300px;height:40px}div{height:3000px}</style><input aria-label='Test password' type='password'><div></div>";
                let _=socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
            });
        }
    });
    let mut browser = Browser::launch(&crate::browser::addon::test_runtime(&executable))
        .await
        .unwrap();
    let target = browser.targets().await.unwrap()[0].target_id.clone();
    let mut timing = CaptureTiming::default();
    let blank = browser
        .capture_scaled_timed(&target, None, &mut timing)
        .await
        .unwrap();
    assert_eq!(timing.stage, "complete");
    assert_eq!(timing.format, "jpeg");
    assert!((1..=4).contains(&timing.attempts));
    assert_eq!(
        timing.image_chars[timing.attempts - 1],
        blank["image"].as_str().unwrap().len()
    );
    assert!(blank.get("capture_stages").is_none());
    let mut failed = CaptureTiming::default();
    assert!(browser
        .capture_scaled_timed("missing-target", None, &mut failed)
        .await
        .is_err());
    assert_eq!(failed.stage, "session");
    assert_eq!(failed.attempts, 0);
    assert_eq!(
        browser
            .human_input(
                &target,
                blank["document_id"].as_str().unwrap(),
                blank["frame_token"].as_str().unwrap(),
                &HumanInput::Back
            )
            .await
            .unwrap_err()
            .to_string(),
        "browser_no_previous_page"
    );
    browser.navigate(&target, &url).await.unwrap();
    for _ in 0..30 {
        if browser
            .observe(&target)
            .await
            .unwrap()
            .elements
            .iter()
            .any(|e| e.name == "Test password")
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let frame = browser.capture(&target).await.unwrap();
    assert!(frame["image"].as_str().unwrap().len() > 100);
    let document = frame["document_id"].as_str().unwrap();
    let token = frame["frame_token"].as_str().unwrap();
    let focused = browser
        .human_input(
            &target,
            document,
            token,
            &HumanInput::Click { x: 50.0, y: 40.0 },
        )
        .await
        .unwrap();
    let focus = focused["focus_token"].as_str().unwrap().to_owned();
    let input = HumanInput::Text {
        focus_token: focus,
        text: "fake-秘密-123".into(),
    };
    assert!(browser
        .human_input(&target, document, "stale-frame", &input)
        .await
        .is_err());
    browser
        .human_input(&target, document, token, &input)
        .await
        .unwrap();
    // Inspect only a synthetic credential in the test, never production diagnostics.
    let session = browser.session(&target).await.unwrap();
    let result = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"document.querySelector('input').value","returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(result["result"]["value"], "fake-秘密-123");
    let observation = serde_json::to_string(&browser.observe(&target).await.unwrap()).unwrap();
    assert!(!observation.contains("fake-"));
    let resized = browser
        .resize_viewport(&target, document, 640, 480)
        .await
        .unwrap();
    let after = browser.capture(&target).await.unwrap();
    assert_eq!(after["document_id"], document); // No navigation/reload.
    assert_eq!(after["width"].as_f64(), Some(640.0));
    assert_eq!(after["height"].as_f64(), Some(480.0));
    assert_eq!(after["viewport_id"], resized["viewport_id"]);
    assert_ne!(after["frame_token"], token);
    let sharp = browser.capture_scaled(&target, Some(2.0)).await.unwrap();
    assert_eq!(sharp["image_format"], "png");
    assert_eq!(sharp["frame_token"], after["frame_token"]);
    assert_eq!(sharp["document_id"], after["document_id"]);
    assert_eq!(sharp["width"], after["width"]);
    use base64::Engine;
    let png = base64::engine::general_purpose::STANDARD
        .decode(sharp["image"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 1280);
    assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 960);
    let value = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"document.querySelector('input').value","returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(value["result"]["value"], "fake-秘密-123");
    for gesture in [
        HumanInput::Click { x: 50.0, y: 40.0 },
        HumanInput::Scroll {
            x: 100.0,
            y: 100.0,
            delta_y: 100.0,
        },
    ] {
        // A visible screenshot does not imply that Chrome's tab is active.
        browser
            .cdp
            .call(None, "Target.createTarget", json!({"url":"about:blank"}))
            .await
            .unwrap();
        let frame = browser.capture(&target).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(5),
            browser.human_input(
                &target,
                document,
                frame["frame_token"].as_str().unwrap(),
                &gesture,
            ),
        )
        .await
        .expect("fitted input timed out")
        .unwrap();
    }
    // The preceding wheel can still be animating; production retries discarded
    // captures too. Establish a stable frame before testing repeated input.
    let mut stable = None;
    for _ in 0..30 {
        match browser.capture(&target).await {
            Ok(frame) => {
                stable = Some(frame);
                break;
            }
            Err(error) if error.to_string() == "browser_frame_discarded" => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Err(error) => panic!("{error}"),
        }
    }
    // Multiple wheels must progress without waiting for a screenshot after each.
    let frame = stable.expect("scroll settled");
    let token = frame["frame_token"].as_str().unwrap();
    let focus_before = browser.focus.as_ref().map(|focus| focus.token.clone());
    for _ in 0..3 {
        let result = browser
            .human_input(
                &target,
                document,
                token,
                &HumanInput::Scroll {
                    x: 100.0,
                    y: 100.0,
                    delta_y: 100.0,
                },
            )
            .await
            .unwrap();
        assert_eq!(result["focus_token"], json!(focus_before));
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let metrics = browser
        .cdp
        .call(Some(&session), "Page.getLayoutMetrics", json!({}))
        .await
        .unwrap();
    assert!(metrics["cssLayoutViewport"]["pageY"].as_f64().unwrap() >= 300.0);
    // Reproduce capture winning the CDP lock while a wheel referencing the
    // displayed frame is still in flight. New pixels have not reached the viewer.
    let newest = browser.capture(&target).await.unwrap();
    assert_ne!(newest["frame_token"], token);
    for _ in 0..3 {
        browser
            .human_input(
                &target,
                document,
                token,
                &HumanInput::Scroll {
                    x: 100.0,
                    y: 100.0,
                    delta_y: 10.0,
                },
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        browser.capture(&target).await.unwrap();
    }
    assert_eq!(
        browser
            .human_input(
                &target,
                document,
                token,
                &HumanInput::Click { x: 100.0, y: 100.0 }
            )
            .await
            .unwrap_err()
            .to_string(),
        "browser_stale_viewport"
    );
    // Scroll depends on current page/viewport context, not screenshot age.
    browser.viewport.as_mut().unwrap().captured = Instant::now() - Duration::from_secs(4);
    browser
        .human_input(
            &target,
            document,
            token,
            &HumanInput::Scroll {
                x: 100.0,
                y: 100.0,
                delta_y: 10.0,
            },
        )
        .await
        .unwrap();
    let light = browser.capture_scaled(&target, Some(2.0)).await.unwrap();
    assert!(light.get("image_format").is_none());
    let jpeg = base64::engine::general_purpose::STANDARD
        .decode(light["image"].as_str().unwrap())
        .unwrap();
    assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    assert_eq!(light["width"], newest["width"]);
    assert_eq!(light["height"], newest["height"]);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let restored = browser.capture_scaled(&target, Some(2.0)).await.unwrap();
    assert_eq!(restored["image_format"], "png");
    assert_eq!(restored["width"], light["width"]);
    assert_eq!(restored["height"], light["height"]);
    assert_eq!(
        restored["frame_token"]
            .as_str()
            .unwrap()
            .split_once(':')
            .unwrap()
            .0,
        token.split_once(':').unwrap().0
    );
    // Scroll tolerance must not allow a stale click or an unknown frame.
    assert!(browser
        .human_input(
            &target,
            document,
            token,
            &HumanInput::Click { x: 100.0, y: 100.0 }
        )
        .await
        .is_err());
    assert!(browser
        .human_input(
            &target,
            document,
            "unknown",
            &HumanInput::Scroll {
                x: 100.0,
                y: 100.0,
                delta_y: 10.0
            }
        )
        .await
        .is_err());
    // A page that never stops moving must still produce display frames.
    browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
        "expression":"window.moving=true;window.ticks=0;function move(){if(!window.moving)return;window.ticks++;scrollTo(0,400+(window.ticks%100)*5);requestAnimationFrame(move)};move()"
    })).await.unwrap();
    let mut moving_frames = 0;
    for _ in 0..8 {
        let moving = browser.capture_scaled(&target, Some(2.0)).await.unwrap();
        assert!(moving["image"].as_str().unwrap().len() > 100);
        if !browser.viewport.as_ref().unwrap().stable {
            moving_frames += 1;
            assert_eq!(
                browser
                    .human_input(
                        &target,
                        document,
                        moving["frame_token"].as_str().unwrap(),
                        &HumanInput::Click { x: 50.0, y: 40.0 }
                    )
                    .await
                    .unwrap_err()
                    .to_string(),
                "browser_stale_viewport"
            );
        }
    }
    assert!(
        moving_frames > 0,
        "fixture must exercise motion during capture"
    );
    browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({
                "expression":"window.moving=false;scrollTo(0,0)"
            }),
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let settled = browser.capture(&target).await.unwrap();
    assert!(browser.viewport.as_ref().unwrap().stable);
    browser
        .human_input(
            &target,
            document,
            settled["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 50.0, y: 40.0 },
        )
        .await
        .unwrap();

    browser
        .resize_viewport(&target, document, 650, 480)
        .await
        .unwrap();

    assert!(browser
        .human_input(
            &target,
            document,
            token,
            &HumanInput::Scroll {
                x: 100.0,
                y: 100.0,
                delta_y: 10.0
            }
        )
        .await
        .is_err());
    assert!(browser
        .resize_viewport(&target, "old-document", 800, 600)
        .await
        .is_err());
    browser.invalidate_references();

    assert!(browser
        .human_input(&target, document, token, &input)
        .await
        .is_err());
    browser
        .navigate(&target, &format!("{url}second"))
        .await
        .unwrap();
    let second = browser.capture(&target).await.unwrap();

    assert!(browser
        .human_input(
            &target,
            document,
            token,
            &HumanInput::Scroll {
                x: 100.0,
                y: 100.0,
                delta_y: 10.0
            }
        )
        .await
        .is_err());
    browser
        .human_input(
            &target,
            second["document_id"].as_str().unwrap(),
            second["frame_token"].as_str().unwrap(),
            &HumanInput::Back,
        )
        .await
        .unwrap();
    for _ in 0..30 {
        if browser
            .targets()
            .await
            .unwrap()
            .iter()
            .any(|page| page.target_id == target && page.url == url)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(browser
        .targets()
        .await
        .unwrap()
        .iter()
        .any(|page| page.target_id == target && page.url == url));
    browser.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn live_table_observation_reads_story_links_in_order() {
    let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
        return;
    };
    let mut browser = Browser::launch(&crate::browser::addon::test_runtime(&executable))
        .await
        .unwrap();
    let target = browser.ensure_page(None).await.unwrap();
    let session = browser.session(&target).await.unwrap();
    let tree = browser
        .cdp
        .call(Some(&session), "Page.getFrameTree", json!({}))
        .await
        .unwrap();
    let rows: String = (1..=30).map(|i| format!(
        "<tr><td>{i}.</td><td><span><a href='#story{i}'>Story {i}</a></span></td></tr><tr><td></td><td>Discussion {i}</td></tr><tr><td></td></tr>"
    )).collect();
    let html = format!("<!doctype html><title>Stories</title><table><tr><td><table>{rows}</table></td></tr><tr><td><a href='#footer'>Footer</a></td></tr></table><input type='password' aria-label='Password' value='synthetic-secret'><button></button>");
    browser
        .cdp
        .call(
            Some(&session),
            "Page.setDocumentContent",
            json!({"frameId":tree["frameTree"]["frame"]["id"],"html":html}),
        )
        .await
        .unwrap();
    let observation = browser.observe(&target).await.unwrap();
    let links: Vec<_> = observation
        .elements
        .iter()
        .filter(|e| e.role == "link")
        .collect();
    assert_eq!(
        links.iter().map(|e| e.name.as_str()).collect::<Vec<_>>(),
        (1..=30)
            .map(|i| format!("Story {i}"))
            .chain(["Footer".into()])
            .collect::<Vec<_>>()
    );
    assert!(!observation.truncated);
    assert!(observation
        .elements
        .iter()
        .any(|e| e.role == "button" && e.name.is_empty()));
    assert!(!serde_json::to_string(&observation)
        .unwrap()
        .contains("synthetic-secret"));
    let reference = links[15].reference.clone();
    browser.click(&reference).await.unwrap();
    let location = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"location.hash","returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(location["result"]["value"], "#story16");
    browser.observe(&target).await.unwrap();
    assert!(browser.click(&reference).await.is_err());
    let html = "<button>Example</button>".repeat(400);
    browser
        .cdp
        .call(
            Some(&session),
            "Page.setDocumentContent",
            json!({"frameId":tree["frameTree"]["frame"]["id"],"html":html}),
        )
        .await
        .unwrap();
    let limited = browser.observe(&target).await.unwrap();
    assert!(limited.truncated);
    assert!(limited.elements.len() <= 256);
    assert!(serde_json::to_vec(&limited.elements).unwrap().len() <= 64 * 1024);
    browser.close().await.unwrap();
}

#[tokio::test]
#[ignore = "headed macOS Chrome fixture; requires BUD_BROWSER_EXECUTABLE"]
async fn minimized_windows_preserve_capture_and_private_input() {
    let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("browser executable");
    let mut root = Browser::launch_mode(&crate::browser::addon::test_runtime(&executable), true)
        .await
        .unwrap();
    let mut browser = root.workspace("test-workspace").await.unwrap();
    let target = browser.ensure_page(None).await.unwrap();
    let session = browser.session(&target).await.unwrap();
    let tree = browser
        .cdp
        .call(Some(&session), "Page.getFrameTree", json!({}))
        .await
        .unwrap();
    browser.cdp.call(Some(&session), "Page.setDocumentContent", json!({
        "frameId":tree["frameTree"]["frame"]["id"],
        "html":"<style>body{margin:20px}input{width:300px;height:40px}</style><input aria-label='Text'><button onclick=\"document.body.style.background='red'\">Change</button><div style='height:4000px'>Scroll</div>"
    })).await.unwrap();
    let mut other = root.workspace("other-workspace").await.unwrap();
    let other_target = other.ensure_page(None).await.unwrap();
    // Both workspaces must capture without native activation, including the
    // second tab before any viewer has applied emulated viewport dimensions.
    other.capture(&other_target).await.unwrap();
    browser.capture(&target).await.unwrap();
    let document = browser.document(&session).await.unwrap();
    browser
        .resize_viewport(&target, &document, 640, 480)
        .await
        .unwrap();
    let window = browser.window_id(&target).await.unwrap();
    browser.observe(&target).await.unwrap();
    let before = browser.capture(&target).await.unwrap();
    browser
        .inspect(
            &target,
            json!({"operation":"click","locator":{"role":"button","name":"Change"}}),
        )
        .await
        .unwrap();
    let frame = browser.capture(&target).await.unwrap();
    assert_ne!(
        frame["image"], before["image"],
        "minimized screenshots must reflect changes"
    );
    let focused = browser
        .human_input(
            &target,
            frame["document_id"].as_str().unwrap(),
            frame["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 50.0, y: 40.0 },
        )
        .await
        .unwrap();
    browser
        .human_input(
            &target,
            frame["document_id"].as_str().unwrap(),
            frame["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: focused["focus_token"].as_str().unwrap().into(),
                text: "background input".into(),
            },
        )
        .await
        .unwrap();
    browser
        .human_input(
            &target,
            frame["document_id"].as_str().unwrap(),
            frame["frame_token"].as_str().unwrap(),
            &HumanInput::Scroll {
                x: 100.0,
                y: 100.0,
                delta_y: 300.0,
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let value=browser.cdp.call(Some(&session),"Runtime.evaluate",json!({"expression":"({text:document.querySelector('input').value,y:scrollY})","returnByValue":true})).await.unwrap();
    assert_eq!(value["result"]["value"]["text"], "background input");
    assert!(value["result"]["value"]["y"].as_f64().unwrap() > 0.0);
    let state = browser
        .cdp
        .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
        .await
        .unwrap();
    assert_eq!(state["bounds"]["windowState"], "minimized");
    browser.native_window(Some(&target), true).await.unwrap();
    let state = browser
        .cdp
        .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
        .await
        .unwrap();
    assert_eq!(state["bounds"]["windowState"], "normal");
    browser.hide_before_return().await.unwrap();
    let state = browser
        .cdp
        .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
        .await
        .unwrap();
    assert_eq!(state["bounds"]["windowState"], "minimized");
    // Verified opener popups inherit ownership and are minimized on discovery.
    browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
        "expression":"window.open('about:blank','bud-popup','popup,width=400,height=300')", "userGesture":true
    })).await.unwrap();
    let mut popup = None;
    for _ in 0..20 {
        popup = browser
            .targets()
            .await
            .unwrap()
            .into_iter()
            .find(|t| t.target_id != target);
        if popup.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let popup = popup.expect("owned popup");
    let popup_window = browser.window_id(&popup.target_id).await.unwrap();
    let state = browser
        .cdp
        .call(
            None,
            "Browser.getWindowBounds",
            json!({"windowId":popup_window}),
        )
        .await
        .unwrap();
    assert_eq!(state["bounds"]["windowState"], "minimized");
    browser
        .native_window(Some(&popup.target_id), true)
        .await
        .unwrap();
    browser.hide_before_return().await.unwrap();
    for id in [window, popup_window] {
        let state = browser
            .cdp
            .call(None, "Browser.getWindowBounds", json!({"windowId":id}))
            .await
            .unwrap();
        assert_eq!(state["bounds"]["windowState"], "minimized");
    }
    root.close().await.unwrap();
}

#[tokio::test]
async fn live_screenshot_timeout_recovers_without_recovering_commands() {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
        return;
    };
    let mut browser =
        Browser::launch_mode(&crate::browser::addon::test_runtime(&executable), false)
            .await
            .unwrap();
    let target = browser.targets().await.unwrap()[0].target_id.clone();
    let initial = browser.capture(&target).await.unwrap();
    // A CDP peer acknowledges attachment but never answers the screenshot.
    // Exercise the actual transport timeout, rather than setting its poison flag.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("ws://{}", listener.local_addr().unwrap());
    let peer = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let mut calls = Vec::new();
        while let Some(Ok(Message::Text(raw))) = socket.next().await {
            let request: serde_json::Value = serde_json::from_str(&raw).unwrap();
            calls.push(request["method"].as_str().unwrap().to_owned());
            if request["method"] == "Target.attachToTarget" {
                socket
                    .send(Message::Text(
                        json!({"id":request["id"],"result":{"sessionId":"fixture"}}).to_string(),
                    ))
                    .await
                    .unwrap();
            }
            if request["method"] == "Page.captureScreenshot" {
                tokio::time::sleep(Duration::from_secs(11)).await;
                return calls;
            }
        }
        calls
    });
    browser.screenshot = Some((Cdp::connect(&endpoint).await.unwrap(), HashMap::new()));
    let error = browser.capture(&target).await.unwrap_err();
    assert!(error.is::<tokio::time::error::Elapsed>());
    assert!(!browser.interrupted(), "capture must not poison commands");
    browser.version().await.unwrap();
    browser.observe(&target).await.unwrap();
    let recovered = browser.capture(&target).await.unwrap();
    assert_eq!(recovered["document_id"], initial["document_id"]);
    assert!(!recovered["image"].as_str().unwrap().is_empty());
    assert_eq!(
        peer.await.unwrap(),
        ["Target.attachToTarget", "Page.captureScreenshot"]
    );
    // An uncertain command must still fail closed, even with a healthy screenshot channel.
    let session = browser.session(&target).await.unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(50),
        browser.cdp.call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"new Promise(()=>{})","awaitPromise":true})
        )
    )
    .await
    .is_err());
    assert!(browser.interrupted());
    assert!(browser.capture(&target).await.is_err());
    browser.close().await.unwrap();
}

#[tokio::test]
#[ignore = "headed macOS Chrome fixture; requires BUD_BROWSER_EXECUTABLE"]
async fn static_idle_tab_preserves_minimized_navigation_capture() {
    let executable = std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("browser executable");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0; 4096];
                let n = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let body = format!("<!doctype html><h1>Navigation {path}</h1>");
                let _ = socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await;
            });
        }
    });
    let mut root = Browser::launch_mode(&crate::browser::addon::test_runtime(&executable), true)
        .await
        .unwrap();
    let mut a = root.workspace("idle-test-a").await.unwrap();
    let mut b = root.workspace("idle-test-b").await.unwrap();
    let ta = a.ensure_page(None).await.unwrap();
    let tb = b.ensure_page(None).await.unwrap();
    let (idle, window) = root.process.lock().unwrap().idle_tab.clone().unwrap();
    assert!(!root
        .targets()
        .await
        .unwrap()
        .iter()
        .any(|t| t.target_id == idle));
    assert!(a.session(&idle).await.is_err());
    assert!(b
        .inspect(&idle, json!({"operation":"snapshot"}))
        .await
        .is_err());
    let mut images = [serde_json::Value::Null, serde_json::Value::Null];
    for round in 0..4 {
        // Exercise explicit Show/Return once, then repeated background navigation.
        if round == 1 {
            b.native_window(Some(&tb), true).await.unwrap();
            b.hide_before_return().await.unwrap();
        }
        if round == 2 {
            // Native closure of the idle tab must not remove workspace pages.
            root.cdp
                .call(None, "Target.closeTarget", json!({"targetId":idle}))
                .await
                .unwrap();
            for _ in 0..20 {
                a.targets().await.unwrap();
                if root.process.lock().unwrap().idle_tab.as_ref().unwrap().0 != idle {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert_ne!(
                root.process.lock().unwrap().idle_tab.as_ref().unwrap().0,
                idle
            );
        }
        a.navigate(&ta, &format!("{url}/a-{round}")).await.unwrap();
        b.navigate(&tb, &format!("{url}/b-{round}")).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        for (index, (browser, target)) in [(&mut a, &ta), (&mut b, &tb)].into_iter().enumerate() {
            let frame = browser.capture(target).await.unwrap();
            assert_ne!(frame["image"], images[index], "fresh navigation pixels");
            images[index] = frame["image"].clone();
            assert_eq!(browser.targets().await.unwrap().len(), 1);
        }
        let bounds = root
            .cdp
            .call(None, "Browser.getWindowBounds", json!({"windowId":window}))
            .await
            .unwrap();
        assert_eq!(
            bounds["bounds"]["windowState"], "minimized",
            "round {round}"
        );
    }
    a.save_pages(Some(&ta)).await.unwrap();
    assert_eq!(
        a.recovery.lock().unwrap().get("idle-test-a").unwrap().urls,
        vec![format!("{url}/a-3")]
    );
    a.close().await.unwrap();
    assert_eq!(b.targets().await.unwrap().len(), 1);
    assert!(root.process.lock().unwrap().idle_tab.is_some());
    b.capture(&tb).await.unwrap();
    root.close().await.unwrap();
    server.abort();
}
