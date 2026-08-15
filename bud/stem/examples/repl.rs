//! Manual smoke tool: an interactive stem session against an in-process holder.
//!
//! ```sh
//! cargo run -p stem --example repl [-- /path/to/shell]
//! ```
//!
//! Type text to send it (Enter appended); special commands:
//!   :screen        print the emulator grid
//!   :key <name>    send a named key (enter, ctrl+c, up, ...)
//!   :mode          print current mode/cwd
//!   :q             kill the session and exit

use std::time::Duration;

use stem::events::Event;
use stem::holder::{run_holder, HolderConfig};
use stem::modes::NoRepl;
use stem::pty::SpawnSpec;
use stem::session::{Session, SessionConfig};

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let shell = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "/bin/sh".to_string());
    let tmp = tempfile::tempdir().expect("tempdir");
    let dir = tmp.path().join("demo-session");
    std::fs::create_dir_all(&dir).unwrap();

    let cfg = HolderConfig {
        session_dir: dir.clone(),
        spawn: SpawnSpec {
            shell,
            args: vec![],
            cwd: std::env::var("HOME").unwrap_or_else(|_| "/".into()),
            env: vec![],
            cols: 100,
            rows: 30,
        },
        ring_cap: 1024 * 1024,
        post_exit_ttl_secs: 2,
    };
    std::thread::spawn(move || {
        let _ = run_holder(cfg, false);
    });

    // Wait for the holder socket.
    for _ in 0..100 {
        if stem::client::HolderClient::connect(&dir).await.is_ok() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let (mut session, mut events) = Session::attach(SessionConfig {
        session_dir: dir,
        quiet_ms: 300,
        resume_from_offset: 0,
        scrollback_lines: 2000,
        repl_matcher: Box::new(NoRepl),
    })
    .await
    .expect("attach");

    println!("== attached (mode {:?}); :q to quit ==", session.mode());

    // Event printer (compact; raw output shown verbatim).
    tokio::spawn(async move {
        while let Some(ev) = events.recv().await {
            match ev {
                Event::Output { bytes, .. } => {
                    use std::io::Write;
                    let mut out = std::io::stdout();
                    let _ = out.write_all(&bytes);
                    let _ = out.flush();
                }
                other => eprintln!("\r\n[event] {other:?}"),
            }
        }
    });

    // Blocking stdin reader → channel.
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<String>(16);
    std::thread::spawn(move || {
        let stdin = std::io::stdin();
        let mut buf = String::new();
        loop {
            buf.clear();
            if std::io::BufRead::read_line(&mut stdin.lock(), &mut buf).unwrap_or(0) == 0 {
                break;
            }
            if line_tx
                .blocking_send(buf.trim_end_matches('\n').to_string())
                .is_err()
            {
                break;
            }
        }
    });

    while let Some(line) = line_rx.recv().await {
        match line.as_str() {
            ":q" => break,
            ":screen" => {
                for l in session.screen_lines() {
                    println!("|{l}");
                }
            }
            ":mode" => println!("mode={:?} cwd={:?}", session.mode(), session.cwd()),
            l if l.starts_with(":key ") => {
                if let Err(e) = session.send_key(l.trim_start_matches(":key ").trim()).await {
                    eprintln!("[err] {e}");
                }
            }
            text => {
                let with_enter = format!("{text}\n");
                if let Err(e) = session.write_text(&with_enter).await {
                    eprintln!("[err] {e}");
                    break;
                }
            }
        }
    }

    let _ = session.kill().await;
    println!("== session killed ==");
}
