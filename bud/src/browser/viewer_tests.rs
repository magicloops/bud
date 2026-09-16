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
    let mut browser = Browser::launch(Path::new(&executable)).await.unwrap();
    let target = browser.targets().await.unwrap()[0].target_id.clone();
    let blank = browser.capture(&target).await.unwrap();
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
    let mut browser = Browser::launch(Path::new(&executable)).await.unwrap();
    let target = browser.targets().await.unwrap()[0].target_id.clone();
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
