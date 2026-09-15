use bud_browser_spike::Browser;
use std::{path::PathBuf, time::Instant};

async fn probe(wave: usize, slot: usize) -> anyhow::Result<()> {
    let executable: PathBuf = std::env::var_os("BUD_BROWSER_EXECUTABLE")
        .expect("Set BUD_BROWSER_EXECUTABLE")
        .into();
    let start = Instant::now();
    let mut first = Browser::launch(&executable).await?;
    let first_ms = start.elapsed().as_millis();
    // Match the original failure's ordering: leave the first browser idle
    // while launching another before issuing a consumer inventory command.
    // launch() now also requires its own read-only readiness round trip.
    let mut second = Browser::launch(&executable).await?;
    let launch_ms = start.elapsed().as_millis();
    let result = async {
        assert!(!first.targets(1, None).await?.is_empty());
        assert!(!second.targets(1, None).await?.is_empty());
        first.version().await?;
        second.version().await?;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    eprintln!("launch-probe wave={wave} slot={slot} first_ms={first_ms} pair_ms={launch_ms} probe_ms={} ok={}", start.elapsed().as_millis() - launch_ms, result.is_ok());
    let first_close = first.close().await;
    let second_close = second.close().await;
    result?;
    first_close?;
    second_close?;
    Ok(())
}

#[test]
#[ignore = "launches concurrent installed Chromium instances"]
fn separate_runtimes() {
    let mut failures = Vec::new();
    for wave in 0..5 {
        let jobs: Vec<_> = (0..2)
            .map(|slot| {
                std::thread::spawn(move || {
                    tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .unwrap()
                        .block_on(probe(wave, slot))
                })
            })
            .collect();
        for job in jobs {
            if let Err(error) = job.join().unwrap() {
                failures.push(format!("{error:#}"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "launches concurrent installed Chromium instances"]
async fn shared_runtime() {
    let mut failures = Vec::new();
    for wave in 0..5 {
        let jobs: Vec<_> = (0..2).map(|slot| tokio::spawn(probe(wave, slot))).collect();
        for job in jobs {
            if let Err(error) = job.await.unwrap() {
                failures.push(format!("{error:#}"));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:?}");
}
