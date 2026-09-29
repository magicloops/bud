use super::*;
use crate::browser::{
    screencast::{Source, SourceFrame},
    viewer::HumanInput,
};

async fn frame(source: &mut Source) -> SourceFrame {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            source.latest.changed().await.expect("source remains live");
            if let Some(frame) = source.latest.borrow_and_update().clone() {
                return frame;
            }
        }
    })
    .await
    .expect("fresh frame")
}

#[tokio::test]
#[ignore = "requires local Chrome; creates only disposable headless profiles"]
async fn private_stream_contenteditable() {
    exercise_private_stream_typing(false, true).await;
    exercise_private_stream_typing(true, true).await;
}

#[tokio::test]
#[ignore = "requires local Chrome; creates only a disposable headless profile"]
async fn private_stream_input_guards_and_idle_refresh() {
    exercise_private_stream_typing(false, false).await;
}

#[tokio::test]
#[ignore = "requires local Chrome; creates only a disposable headless profile"]
async fn private_stream_shadow_search_input() {
    exercise_private_stream_typing(true, false).await;
}

#[tokio::test]
#[ignore = "requires local Chrome; disposable headed profile"]
async fn private_stream_after_passive_capture() {
    let _ = tracing_subscriber::fmt().with_test_writer().try_init();
    let runtime = crate::browser::addon::test_runtime(
        std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
    );
    let mut browser = Browser::launch_mode(&runtime, true).await.unwrap();
    let result = async {
        let target = browser.targets().await.unwrap().remove(0).target_id;
        let session = browser.session(&target).await.unwrap();
        browser
            .cdp
            .call(
                Some(&session),
                "Page.navigate",
                json!({"url":"data:text/html,<input><button style='position:fixed;top:100px;left:0;width:200px;height:50px' onclick='window.clicked=(window.clicked||0)+1'>Click</button><div style='height:4000px'>fixture</div>"}),
            )
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        let document = browser.document(&session).await.unwrap();
        browser
            .resize_viewport(&target, &document, 440, 816)
            .await
            .unwrap();
        browser.capture_scaled(&target, Some(2.)).await.unwrap();
        // Half-pixel scrolling on HiDPI rounds the layout viewport inward.
        browser
            .cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":"window.scrollTo(0,278.5)"}),
            )
            .await?;
        let metrics = browser
            .cdp
            .call(Some(&session), "Page.getLayoutMetrics", json!({}))
            .await?;
        assert_eq!(metrics["cssVisualViewport"]["clientHeight"], 816);
        let (config, generation) = browser.prepare_stream(&target).await.unwrap();
        let mut source = Source::start(config).await?;
        let mut first = frame(&mut source).await;
        // Replay the device's compositor/layout disagreement with real CDP input.
        // This injects metadata only; it does not claim Chrome always emits it.
        let current = browser.cdp.call(Some(&session), "Page.getLayoutMetrics", json!({})).await?;
        assert_eq!(current["cssVisualViewport"]["pageY"].as_f64(), Some(278.5));
        first.metrics["pageY"] = json!(278.666748046875);
        let header = browser.stream_frame(&generation, &first)?;
        assert_eq!(header["height"], 816.0);
        browser.human_input(
            &target, &document, header["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 100., y: 120. },
        ).await?;
        for _ in 0..5 {
            browser
                .human_input(
                    &target,
                    &document,
                    header["frame_token"].as_str().unwrap(),
                    &HumanInput::Scroll {
                        x: 200.,
                        y: 400.,
                        delta_y: 100.5,
                    },
                )
                .await?;
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // Include idle refresh on the same immutable generation after motion.
        tokio::time::sleep(Duration::from_millis(1200)).await;
        // A live generation alone must not authorize a click at old scroll offsets.
        let error = browser.human_input(
            &target, &document, header["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 100., y: 120. },
        ).await.unwrap_err();
        assert_eq!(error.to_string(), "browser_stale_viewport");
        let fresh = frame(&mut source).await;
        let fresh = browser.stream_frame(&generation, &fresh)?;
        browser.human_input(
            &target, &document, fresh["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 100., y: 120. },
        ).await?;
        let clicked = browser.cdp.call(Some(&session), "Runtime.evaluate",
            json!({"expression":"window.clicked", "returnByValue":true})).await?;
        assert_eq!(clicked["result"]["value"], 2, "screencast and idle post-scroll clicks reach page");
        browser
            .cdp
            .call(
                Some(&session),
                "Emulation.setDeviceMetricsOverride",
                json!({"width":440,"height":817,"deviceScaleFactor":1,"mobile":false}),
            )
            .await?;
        assert!(
            browser
                .human_input(
                    &target,
                    &document,
                    fresh["frame_token"].as_str().unwrap(),
                    &HumanInput::Scroll {
                        x: 200.,
                        y: 400.,
                        delta_y: 100.5
                    }
                )
                .await
                .is_err(),
            "real one-pixel resize must reject old input"
        );
        source.stop().await?;
        browser.hide_before_return().await?;
        browser
            .inspect(&target, json!({"operation":"snapshot","compact":true}))
            .await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    browser.close().await.unwrap();
    result.unwrap();
}

async fn exercise_private_stream_typing(shadow: bool, rich: bool) {
    let runtime = crate::browser::addon::test_runtime(
        std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
    );
    let mut browser = Browser::launch_probe(&runtime).await.unwrap();
    let target = browser.targets().await.unwrap().remove(0).target_id;
    let session = browser.session(&target).await.unwrap();
    let input = if rich {
        "<div contenteditable='true' style='position:fixed;top:0;left:0;width:200px;height:40px'></div>"
    } else {
        "<input type='search' style='position:fixed;top:0;left:0;width:200px;height:40px'>"
    };
    let html = if shadow {
        format!("<div id='host'></div><script>const outer=document.getElementById('host').attachShadow({{mode:'open'}}); outer.innerHTML='<div></div>'; const inner=outer.firstChild.attachShadow({{mode:'open'}}); inner.innerHTML={}; window.testField=inner.firstChild;</script>", serde_json::to_string(input).unwrap())
    } else {
        format!("{input}<script>window.testField=document.querySelector('[contenteditable],input')</script>")
    };
    browser.cdp.call(Some(&session), "Page.navigate", json!({"url":format!("data:text/html,{html}<input id='other' style='position:fixed;top:60px;left:0'><script>window.inputEvents=0; document.addEventListener('input',()=>window.inputEvents++);</script><div style='height:4000px'>scroll</div>")})).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let document = browser.document(&session).await.unwrap();
    browser
        .resize_viewport(&target, &document, 440, 816)
        .await
        .unwrap();
    let (config, generation) = browser.prepare_stream(&target).await.unwrap();
    let live = config.live.clone();
    let cleanup = config.cleanup.clone();
    let mut source = Source::start(config).await.unwrap();
    let first = frame(&mut source).await;
    let first = browser.stream_frame(&generation, &first).unwrap();
    let second = frame(&mut source).await;
    browser.stream_frame(&generation, &second).unwrap();
    let focused = browser
        .human_input(
            &target,
            &document,
            first["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 20., y: 20. },
        )
        .await
        .unwrap();
    assert_eq!(focused["focus_editable"], true);
    let next = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &next).unwrap();
    let mut typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: focused["focus_token"].as_str().unwrap().into(),
                text: "guarded".into(),
            },
        )
        .await
        .unwrap();
    // Repeated typing must rotate focus tokens without newer frames cancelling it.
    for text in [" ", "more", " text"] {
        let next = frame(&mut source).await;
        let header = browser.stream_frame(&generation, &next).unwrap();
        typed = browser
            .human_input(
                &target,
                &document,
                header["frame_token"].as_str().unwrap(),
                &HumanInput::Text {
                    focus_token: typed["focus_token"].as_str().unwrap().into(),
                    text: text.into(),
                },
            )
            .await
            .unwrap();
    }
    let latest = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &latest).unwrap();
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Key {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                key: "Backspace".into(),
            },
        )
        .await
        .unwrap();
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                text: "t".into(),
            },
        )
        .await
        .unwrap();
    let value = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":if rich { "window.testField.textContent" } else { "window.testField.value" }, "returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(value["result"]["value"], "guarded more text");
    let latest = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &latest).unwrap();
    browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Scroll {
                x: 300.,
                y: 400.,
                delta_y: 300.,
            },
        )
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let latest = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &latest).unwrap();
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                text: " after scroll".into(),
            },
        )
        .await
        .unwrap();
    let value = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":if rich { "window.testField.textContent" } else { "window.testField.value" }, "returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(value["result"]["value"], "guarded more text after scroll");
    // Bubbling input must reach handlers outside the component's shadow roots.
    let events = browser
        .cdp
        .call(
            Some(&session),
            "Runtime.evaluate",
            json!({"expression":"window.inputEvents", "returnByValue":true}),
        )
        .await
        .unwrap();
    assert_eq!(events["result"]["value"], 7);
    // Delete a selected range, then the final remaining character (including rich hosts).
    browser.cdp.call(Some(&session), "Runtime.evaluate", json!({"expression":
        if rich { "(() => { const root=testField.getRootNode(); const s=root.getSelection ? root.getSelection() : getSelection(); const r=document.createRange(); r.selectNodeContents(testField); s.removeAllRanges(); s.addRange(r); })()" }
        else { "testField.select()" }
    })).await.unwrap();
    let latest = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &latest).unwrap();
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                text: "x".into(),
            },
        )
        .await
        .unwrap();
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Key {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                key: "Backspace".into(),
            },
        )
        .await
        .unwrap();
    let value = browser.cdp.call(Some(&session), "Runtime.evaluate", json!({
        "expression": if rich { "testField.textContent" } else { "testField.value" }, "returnByValue":true
    })).await.unwrap();
    assert_eq!(
        value["result"]["value"], "",
        "Backspace deletes the final remote character"
    );
    typed = browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Text {
                focus_token: typed["focus_token"].as_str().unwrap().into(),
                text: "guarded more text after scroll".into(),
            },
        )
        .await
        .unwrap();
    // Neither read-only fields nor a changed active chain may receive stale text.
    for expression in [
        // Retain focus but deliberately move the selection outside the rich host.
        if rich {
            "const r=document.createRange(); r.selectNodeContents(document.body); const s=getSelection(); s.removeAllRanges(); s.addRange(r)"
        } else {
            "window.testField.readOnly=true"
        },
        "window.testField.readOnly=true",
        "window.testField.readOnly=false; document.getElementById('other').focus()",
    ] {
        browser
            .cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":expression}),
            )
            .await
            .unwrap();
        let latest = frame(&mut source).await;
        let header = browser.stream_frame(&generation, &latest).unwrap();
        let error = browser
            .human_input(
                &target,
                &document,
                header["frame_token"].as_str().unwrap(),
                &HumanInput::Text {
                    focus_token: typed["focus_token"].as_str().unwrap().into(),
                    text: "must not land".into(),
                },
            )
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "browser_stale_or_unsupported_focus");
    }
    let values = browser.cdp.call(Some(&session), "Runtime.evaluate",
        json!({"expression":if rich { "[window.testField.textContent,document.getElementById('other').value]" } else { "[window.testField.value,document.getElementById('other').value]" }, "returnByValue":true})).await.unwrap();
    assert_eq!(
        values["result"]["value"],
        json!(["guarded more text after scroll", ""])
    );
    // Static pages remain usable after the original three-second evidence expires.
    tokio::time::sleep(Duration::from_secs(4)).await;
    let refreshed = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &refreshed).unwrap();
    browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 20., y: 20. },
        )
        .await
        .unwrap();
    live.store(false, std::sync::atomic::Ordering::SeqCst);
    assert!(browser
        .human_input(
            &target,
            &document,
            header["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 20., y: 20. }
        )
        .await
        .is_err());
    source.stop().await.unwrap();
    assert_eq!(cleanup.load(std::sync::atomic::Ordering::SeqCst), 1);
    browser.retire_stream().await.unwrap();
    // Real navigation retires the generation without adapter-side invalidation.
    let (config, generation) = browser.prepare_stream(&target).await.unwrap();
    let live = config.live.clone();
    let mut source = Source::start(config).await.unwrap();
    let before = frame(&mut source).await;
    let before = browser.stream_frame(&generation, &before).unwrap();
    browser
        .cdp
        .call(
            Some(&session),
            "Page.navigate",
            json!({"url":"data:text/html,<h1>new document</h1>"}),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while live.load(std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(browser
        .human_input(
            &target,
            &document,
            before["frame_token"].as_str().unwrap(),
            &HumanInput::Click { x: 20., y: 20. }
        )
        .await
        .is_err());
    source.stop().await.unwrap();
    let document = browser.document(&session).await.unwrap();
    browser
        .resize_viewport(&target, &document, 600, 700)
        .await
        .unwrap();
    let (config, generation) = browser.prepare_stream(&target).await.unwrap();
    let cleanup = config.cleanup.clone();
    let mut source = Source::start(config).await.unwrap();
    let resized = frame(&mut source).await;
    let header = browser.stream_frame(&generation, &resized).unwrap();
    assert_eq!(header["width"].as_f64(), Some(600.));
    assert_eq!(header["height"].as_f64(), Some(700.));
    // Return must await capture/focus cleanup even in the headless test runtime.
    browser.hide_before_return().await.unwrap();
    assert_eq!(cleanup.load(std::sync::atomic::Ordering::SeqCst), 1);
    source.stop().await.unwrap();
    browser.close().await.unwrap();
}

#[tokio::test]
#[ignore = "requires local Chrome; creates only a disposable headless profile"]
async fn private_stream_model_backed_deletion() {
    let runtime = crate::browser::addon::test_runtime(
        std::env::var_os("BUD_BROWSER_EXECUTABLE").expect("Chrome path"),
    );
    let mut browser = Browser::launch_probe(&runtime).await.unwrap();
    let result = async {
        let target = browser.targets().await?.remove(0).target_id;
        let session = browser.session(&target).await?;
        let fixture = r#"(() => {
          const field=document.createElement('div'); field.contentEditable='true';
          const other=document.createElement('input'); document.body.append(field,other);
          let model='ab', intents=0, nativeInputs=0;
          function render() {
            field.textContent=model; field.focus();
            const r=document.createRange(); r.selectNodeContents(field); r.collapse(false);
            const s=getSelection(); s.removeAllRanges(); s.addRange(r);
          }
          render();
          field.addEventListener('beforeinput',event=>{
            if(event.inputType!=='deleteContentBackward') return;
            intents++;
            if(window.moveFocus){other.focus();return;}
            if(window.moveSelection){getSelection().collapse(field.firstChild,0);return;}
            event.preventDefault(); model=model.slice(0,-1); render();
          });
          // Model-backed editors can restore a removed final DOM text node unless
          // their own deletion handler updates the model first.
          field.addEventListener('input',()=>{
            nativeInputs++;
            if(field.textContent) model=field.textContent; else render();
          });
          window.fixture={field,other,reset(){model='ab';render();},
            state:()=>({text:field.textContent,model,intents,nativeInputs,other:other.value})};
        })()"#;
        browser
            .cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":fixture}),
            )
            .await?;
        let object = browser
            .cdp
            .call(
                Some(&session),
                "Runtime.evaluate",
                json!({"expression":"fixture.field"}),
            )
            .await?;
        for expected in ["a", "", ""] {
            let response = browser
                .cdp
                .call(
                    Some(&session),
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId":object["result"]["objectId"], "returnByValue":true,
                        "functionDeclaration":include_str!("human_edit.js"),
                        "arguments":[{"value":"key"},{"value":"Backspace"}], "userGesture":true
                    }),
                )
                .await?;
            assert_eq!(response["result"]["value"], true);
            let state = browser
                .cdp
                .call(
                    Some(&session),
                    "Runtime.evaluate",
                    json!({"expression":"fixture.state()", "returnByValue":true}),
                )
                .await?;
            assert_eq!(state["result"]["value"]["text"], expected);
            assert_eq!(state["result"]["value"]["model"], expected);
            assert_eq!(
                state["result"]["value"]["nativeInputs"], 0,
                "handled intent cannot delete twice"
            );
        }
        for setup in [
            "window.moveFocus=true",
            "window.moveFocus=false; window.moveSelection=true",
        ] {
            browser
                .cdp
                .call(
                    Some(&session),
                    "Runtime.evaluate",
                    json!({"expression":format!("fixture.reset(); {setup}")}),
                )
                .await?;
            let response = browser
                .cdp
                .call(
                    Some(&session),
                    "Runtime.callFunctionOn",
                    json!({
                        "objectId":object["result"]["objectId"], "returnByValue":true,
                        "functionDeclaration":include_str!("human_edit.js"),
                        "arguments":[{"value":"key"},{"value":"Backspace"}], "userGesture":true
                    }),
                )
                .await?;
            assert_eq!(
                response["result"]["value"], false,
                "handler redirects must fence fallback"
            );
            let state = browser
                .cdp
                .call(
                    Some(&session),
                    "Runtime.evaluate",
                    json!({"expression":"fixture.state()", "returnByValue":true}),
                )
                .await?;
            assert_eq!(state["result"]["value"]["text"], "ab");
            assert_eq!(state["result"]["value"]["other"], "");
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    browser.close().await.unwrap();
    result.unwrap();
}
