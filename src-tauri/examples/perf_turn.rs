//! Measures cold spawn + handshake + session + time-to-first-delta for one
//! agent, twice. Usage:
//! `cargo run --manifest-path src-tauri/Cargo.toml --example perf_turn -- mock`

use std::time::{Duration, Instant};

use pult_core::drivers::acp::{AcpConn, SpawnConfig};
use pult_core::events::EventKind;
use pult_core::protocol::types::ContentBlock;

#[tokio::main]
async fn main() {
    let agent = std::env::args().nth(1).unwrap_or_else(|| "mock".to_string());
    let (command, args) = match agent.as_str() {
        "mock" => (
            "node".to_string(),
            vec![fixture_path().to_string_lossy().into_owned()],
        ),
        "opencode" => (
            "cmd".to_string(),
            vec!["/d".into(), "/s".into(), "/c".into(), "opencode acp".into()],
        ),
        "codex" => (
            "cmd".to_string(),
            vec![
                "/d".into(),
                "/s".into(),
                "/c".into(),
                "npx -y @agentclientprotocol/codex-acp".into(),
            ],
        ),
        "antigravity" => {
            let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
            (
                format!("{local}\\pult\\antigravity\\agy_acp_server.exe"),
                Vec::new(),
            )
        }
        other => {
            eprintln!("unknown agent {other}; use mock|opencode|codex|antigravity");
            std::process::exit(2);
        }
    };

    for turn in 1..=2 {
        let spawn = Instant::now();
        let (conn, streams) = AcpConn::spawn(&SpawnConfig {
            command: command.clone(),
            args: args.clone(),
            env: Default::default(),
        })
        .expect("spawn agent");
        let spawn_ms = spawn.elapsed().as_millis();
        let handshake = Instant::now();
        conn.initialize().await.expect("initialize");
        let handshake_ms = handshake.elapsed().as_millis();
        let session = Instant::now();
        let session_id = conn
            .new_session(&std::env::current_dir().unwrap().to_string_lossy())
            .await
            .expect("session/new")
            .session_id;
        let session_ms = session.elapsed().as_millis();

        let prompt = Instant::now();
        let prompt_fut = conn.prompt(&session_id, vec![ContentBlock::text("Reply with ok")]);
        tokio::pin!(prompt_fut);
        let mut events_rx = streams.events_rx;
        let mut first_delta_ms = None;
        tokio::select! {
            _ = &mut prompt_fut => {},
            delta = async {
                while let Some(kind) = events_rx.recv().await {
                    if matches!(kind, EventKind::AgentMessageDelta { .. } | EventKind::AgentThoughtDelta { .. }) {
                        return Some(prompt.elapsed().as_millis());
                    }
                }
                None
            } => { first_delta_ms = delta; }
            _ = tokio::time::sleep(Duration::from_secs(90)) => {},
        }
        conn.kill();
        println!(
            "{{\"turn\":{turn},\"agent\":\"{agent}\",\"spawnMs\":{spawn_ms},\"handshakeMs\":{handshake_ms},\"sessionMs\":{session_ms},\"firstDeltaMs\":{},\"totalMs\":{}}}",
            first_delta_ms.map(|v| v.to_string()).unwrap_or_else(|| "null".into()),
            spawn.elapsed().as_millis()
        );
    }
}

fn fixture_path() -> std::path::PathBuf {
    let cwd = std::env::current_dir().expect("cwd");
    [cwd.join("fixtures/mock-acp-agent.mjs"), cwd.join("../fixtures/mock-acp-agent.mjs")]
        .into_iter()
        .find(|path| path.is_file())
        .expect("fixtures/mock-acp-agent.mjs")
}
