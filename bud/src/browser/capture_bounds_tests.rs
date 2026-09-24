use super::*;

#[tokio::test]
async fn live_capture_bounds_with_independent_screenshot_density() {
    let Some(executable) = std::env::var_os("BUD_BROWSER_EXECUTABLE") else {
        return;
    };
    let mut browser = Browser::launch_probe(&crate::browser::addon::test_runtime(executable))
        .await
        .unwrap();
    let result = async {
        let target = browser.targets().await.unwrap().remove(0).target_id;
        // Open the independent screenshot connection before giving it a native
        // 2x density. Command-side CSS geometry cannot predict this image size.
        browser.capture(&target).await.unwrap();
        let (cdp, sessions) = browser.screenshot.as_mut().unwrap();
        let session = sessions.get(&target).unwrap().clone();
        cdp.call(
            Some(&session),
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width":1734,"height":1278,"deviceScaleFactor":2,"mobile":false
            }),
        )
        .await
        .unwrap();
        let mut timing = CaptureTiming::default();
        let frame = browser
            .capture_scaled_timed(&target, Some(2.0), &mut timing)
            .await
            .unwrap();
        assert_eq!(frame["width"], 1734.0);
        assert_eq!(frame["height"], 1278.0);
        assert!(
            timing.attempts > 1,
            "fixture must exercise real oversized capture: {timing:?}"
        );
        let dimensions =
            crate::browser::image_bounds::dimensions(frame["image"].as_str().unwrap(), true)
                .unwrap();
        assert!(
            crate::browser::image_bounds::within_bounds(dimensions, true),
            "{dimensions:?}"
        );
        assert!(frame["image"].as_str().unwrap().len() <= 1_400_000);
        // Motion mode must also obey its 1280px bound and keep CSS coordinates.
        browser.last_wheel = Some(Instant::now());
        let motion = browser.capture_scaled(&target, Some(2.0)).await.unwrap();
        assert!(motion.get("image_format").is_none());
        let dimensions =
            crate::browser::image_bounds::dimensions(motion["image"].as_str().unwrap(), false)
                .unwrap();
        assert!(crate::browser::image_bounds::within_bounds(
            dimensions, false
        ));
        assert_eq!(motion["width"], frame["width"]);
        assert_eq!(motion["height"], frame["height"]);
    }
    .await;
    browser.close().await.unwrap();
    result
}
