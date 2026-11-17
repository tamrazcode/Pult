//! User config (§4.5): `~/.pult/config.toml` holds agent instances — the
//! agent matrix source of truth. The built-in mock instance is the fallback
//! when the file has none. Detection scans PATH for known agent CLIs.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::PultError;

/// One configured agent instance (§4.5 instances). `driver` selects how the
/// process is spawned: `"mock"` = the built-in dev agent (fixtures resolved
/// at spawn time), `"acp"` = a raw ACP-over-stdio command.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSpec {
    pub id: String,
    #[serde(rename = "displayName")]
    pub display_name: String,
    #[serde(default = "default_driver")]
    pub driver: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
    /// Disabled providers stay configured but never spawn (T3-style toggle).
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

fn default_driver() -> String {
    "acp".to_string()
}

/// The built-in dev instance used when the config has no instances.
pub fn mock_spec() -> InstanceSpec {
    InstanceSpec {
        id: "mock".to_string(),
        display_name: "Mock agent (dev)".to_string(),
        driver: "mock".to_string(),
        command: "node".to_string(),
        args: Vec::new(),
        env: Default::default(),
        enabled: true,
    }
}

/// Reads instances from `<home>/config.toml`; missing file → empty.
pub fn load_instances(home: &Path) -> Vec<InstanceSpec> {
    match load_instances_checked(home) {
        Ok(instances) => instances,
        Err(err) => {
            tracing::warn!(target: "pult::config", error = %err, "config.toml unreadable; using defaults");
            Vec::new()
        }
    }
}

/// Reads instances from `<home>/config.toml`, reporting read/parse failures
/// instead of silently returning an empty list.
pub fn load_instances_checked(home: &Path) -> Result<Vec<InstanceSpec>, String> {
    let raw = match std::fs::read_to_string(home.join("config.toml")) {
        Ok(raw) => raw,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err.to_string()),
    };
    toml::from_str::<ConfigFile>(&raw)
        .map(|config| config.instances)
        .map_err(|err| err.to_string())
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    instances: Vec<InstanceSpec>,
}

/// Rewrites the `instances` array in `<home>/config.toml`, keeping the rest
/// of the file untouched (parse the whole table → patch the one key → write
/// via a temp file + rename so a failed write never corrupts the old file;
/// creates the file if absent).
pub fn save_instances(home: &Path, specs: &[InstanceSpec]) -> Result<(), PultError> {
    let path = home.join("config.toml");
    let mut table: toml::Table = match std::fs::read_to_string(&path) {
        Ok(raw) => {
            toml::from_str(&raw).map_err(|e| PultError::store(format!("config.toml parse: {e}")))?
        }
        Err(_) => toml::Table::new(),
    };
    let values = specs
        .iter()
        .map(toml::Value::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| PultError::store(format!("instance serialize: {e}")))?;
    table.insert("instances".to_string(), toml::Value::Array(values));
    let body = toml::to_string_pretty(&table)
        .map_err(|e| PultError::store(format!("config.toml serialize: {e}")))?;
    std::fs::create_dir_all(home).map_err(|e| PultError::store(format!("create home: {e}")))?;
    let tmp = home.join(format!("config.toml.tmp.{}", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        std::io::Write::write_all(&mut file, body.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if let Err(err) = write {
        let _ = std::fs::remove_file(&tmp);
        return Err(PultError::store(format!("write config: {err}")));
    }
    Ok(())
}

/// A known agent CLI found on PATH (§4.3 `providers.detectInstalled`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DetectedAgent {
    /// Canonical id ("claude-code", "gemini-cli", "codex", "dsh").
    pub id: String,
    pub display_name: String,
    /// The CLI binary that was found on PATH.
    pub command: String,
    /// Suggested instance id for the wizard's "Add" button.
    pub suggested_instance_id: String,
    /// Prefilled ACP command for the instance (adapter argv), if known.
    pub suggested_command: Option<Vec<String>>,
    pub notes: &'static str,
}

/// Suggested ACP invocation for a detected CLI (adapter argv), if known.
type SuggestedCommand = Option<Vec<String>>;

/// One detection candidate: (cli binary, instance id, display, adapter argv, notes).
type Candidate = (
    &'static str,
    &'static str,
    &'static str,
    SuggestedCommand,
    &'static str,
);

/// Known agent CLIs and their ACP invocation patterns. Detection is a PATH
/// scan (no version probe — cheap and offline). Every entry carries a
/// prefilled one-click Connect command — native ACP where the CLI speaks it,
/// the official bridge package where it does not.
pub fn detect_installed() -> Vec<DetectedAgent> {
    let candidates: &[Candidate] = &[
        (
            "claude",
            "claude-code",
            "Claude Code",
            Some(vec![
                "npx".to_string(),
                "-y".to_string(),
                "@zed-industries/claude-code-acp".to_string(),
            ]),
            "Connects through the community ACP adapter; sign in with `claude` first if prompted.",
        ),
        (
            "gemini",
            "gemini-cli",
            "Gemini CLI",
            Some(vec![
                "npx".to_string(),
                "-y".to_string(),
                "@google/gemini-cli".to_string(),
                "--experimental-acp".to_string(),
            ]),
            "Google's CLI has an ACP mode (`--experimental-acp`) — connected for you.",
        ),
        (
            "codex",
            "codex",
            "Codex CLI",
            Some(vec![
                "npx".to_string(),
                "-y".to_string(),
                "@agentclientprotocol/codex-acp".to_string(),
            ]),
            "Connects through the official ACP bridge; sign in with `codex` if prompted.",
        ),
        (
            "opencode",
            "opencode",
            "OpenCode",
            Some(vec!["opencode".to_string(), "acp".to_string()]),
            "OpenCode speaks ACP natively (`opencode acp`) — connected for you.",
        ),
        (
            "grok",
            "grok",
            "Grok",
            Some(vec![
                "grok".to_string(),
                "agent".to_string(),
                "stdio".to_string(),
            ]),
            "xAI's CLI speaks ACP (`grok agent stdio`) — sign in with `grok` first.",
        ),
        (
            "dsh",
            "dsh",
            "dsh",
            Some(vec![
                "dsh".to_string(),
                "--profile".to_string(),
                "acp".to_string(),
            ]),
            "ACP-native coding agent.",
        ),
    ];
    let mut found = Vec::new();
    for (binary, id, display, suggested, notes) in candidates {
        if which(binary).is_some() {
            found.push(DetectedAgent {
                id: (*id).to_string(),
                display_name: (*display).to_string(),
                command: (*binary).to_string(),
                suggested_instance_id: (*id).to_string(),
                suggested_command: suggested.clone(),
                notes,
            });
        }
    }
    // Google ships the Antigravity ACP runtime separately from the IDE; pult
    // looks for the server it installs (or one on PATH).
    if let Some(server) = antigravity_server_path() {
        let command = server.to_string_lossy().into_owned();
        found.push(DetectedAgent {
            id: "antigravity".to_string(),
            display_name: "Google Antigravity".to_string(),
            command: command.clone(),
            suggested_instance_id: "antigravity".to_string(),
            suggested_command: Some(vec![command]),
            notes: "Official Google ACP server. Cold start can take 15-25 s on Windows; sign in from Providers.",
        });
    }
    found
}

/// The standalone Antigravity ACP server (`agy_acp_server`), installed by pult
/// under `%LOCALAPPDATA%\\pult\\antigravity`, downloaded by T3 Code, or on PATH.
fn antigravity_server_path() -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    if let Some(path) = antigravity_server_path_in(
        std::env::var_os("LOCALAPPDATA")
            .map(std::path::PathBuf::from)
            .as_deref(),
        Some(crate::runtime::home_dir_pub().as_path()),
    ) {
        return Some(path);
    }
    which("agy_acp_server")
}

/// Pult's own copy wins; T3 Code's downloaded artifact is reused when the
/// install folder was wiped by a reinstall, so the provider still appears.
fn antigravity_server_path_in(
    local_app_data: Option<&Path>,
    home: Option<&Path>,
) -> Option<std::path::PathBuf> {
    if let Some(local) = local_app_data {
        let candidate = local
            .join("pult")
            .join("antigravity")
            .join("agy_acp_server.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(home) = home {
        let versions = home
            .join(".t3")
            .join("tools")
            .join("antigravity-acp")
            .join("win32-x64")
            .join("versions");
        if let Some(candidate) = newest_antigravity_server(&versions) {
            return Some(candidate);
        }
    }
    None
}

/// Newest `<sha>/agy_acp_server.exe` under T3's versions folder.
fn newest_antigravity_server(versions: &Path) -> Option<std::path::PathBuf> {
    let mut best: Option<(std::time::SystemTime, String, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(versions).ok()?.flatten() {
        let server = entry.path().join("agy_acp_server.exe");
        if !server.is_file() {
            continue;
        }
        let modified = server
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        let name = entry.file_name().to_string_lossy().into_owned();
        let newer = match &best {
            None => true,
            Some((best_time, best_name, _)) => {
                modified > *best_time || (modified == *best_time && name > *best_name)
            }
        };
        if newer {
            best = Some((modified, name, server));
        }
    }
    best.map(|(_, _, server)| server)
}

/// PATH lookup honoring PATHEXT (Windows) — a poor man's `which`.
pub fn which(binary: &str) -> Option<std::path::PathBuf> {
    let extensions: &[&str] = if cfg!(windows) {
        &["exe", "cmd", "bat"]
    } else {
        &[""]
    };
    let path_var = std::env::var("PATH").ok()?;
    for dir in std::env::split_paths(&path_var) {
        for ext in extensions {
            let candidate = if ext.is_empty() {
                dir.join(binary)
            } else {
                dir.join(format!("{binary}.{ext}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Resolves a command name to its absolute file (needed because CreateProcess
/// only finds `.exe` implicitly, while agents like `opencode` are `.cmd`
/// shims). Returns `None` for absolute paths or unknown names.
pub fn resolve_command(command: &str) -> Option<std::path::PathBuf> {
    if std::path::Path::new(command).is_absolute() {
        return None;
    }
    which(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_instances_through_config_toml() {
        let home = std::env::temp_dir().join(format!("pult-config-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        let specs = vec![
            mock_spec(),
            InstanceSpec {
                id: "claude-code".to_string(),
                display_name: "Claude Code".to_string(),
                driver: "acp".to_string(),
                command: "npx".to_string(),
                args: vec![
                    "-y".to_string(),
                    "@zed-industries/claude-code-acp".to_string(),
                ],
                env: [("DEBUG".to_string(), "1".to_string())]
                    .into_iter()
                    .collect(),
                enabled: true,
            },
        ];
        save_instances(&home, &specs).unwrap();
        let raw = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(raw.contains("[[instances]]"));
        assert!(raw.contains("claude-code"));
        let loaded = load_instances(&home);
        assert_eq!(loaded, specs);
        // Extra top-level keys survive a save round-trip.
        std::fs::write(
            home.join("config.toml"),
            "theme = \"t3-dark\"\n\n[[instances]]\nid = \"mock\"\ndisplayName = \"Mock agent (dev)\"\ndriver = \"mock\"\n",
        )
        .unwrap();
        let patched = save_instances(&home, &specs).is_ok();
        assert!(patched);
        let raw = std::fs::read_to_string(home.join("config.toml")).unwrap();
        assert!(raw.contains("theme"), "unrelated keys preserved");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn missing_config_yields_empty_without_mock_fallback() {
        let home = std::env::temp_dir().join(format!("pult-config-none-{}", std::process::id()));
        assert!(load_instances(&home).is_empty());
        assert_eq!(mock_spec().driver, "mock");
    }

    #[test]
    fn detection_includes_known_candidates() {
        // No assertion on what IS installed (machine-dependent); the list
        // only ever contains known ids, and every known CLI ships a
        // one-click command (no manual wiring anywhere).
        for agent in detect_installed() {
            assert!(matches!(
                agent.id.as_str(),
                "claude-code"
                    | "gemini-cli"
                    | "codex"
                    | "opencode"
                    | "dsh"
                    | "antigravity"
                    | "grok"
            ));
            assert!(
                agent.suggested_command.is_some(),
                "{} must carry a one-click command",
                agent.id
            );
        }
    }

    #[test]
    fn antigravity_prefers_pult_install_over_t3_fallback() {
        let root = temp_config_home("antigravity-pult");
        let local = root.join("local");
        let home = root.join("home");
        let pult_server = local
            .join("pult")
            .join("antigravity")
            .join("agy_acp_server.exe");
        std::fs::create_dir_all(pult_server.parent().unwrap()).unwrap();
        std::fs::write(&pult_server, b"pult").unwrap();
        let t3_server = home
            .join(".t3")
            .join("tools")
            .join("antigravity-acp")
            .join("win32-x64")
            .join("versions")
            .join("t3")
            .join("agy_acp_server.exe");
        std::fs::create_dir_all(t3_server.parent().unwrap()).unwrap();
        std::fs::write(&t3_server, b"t3").unwrap();

        assert_eq!(
            antigravity_server_path_in(Some(&local), Some(&home)),
            Some(pult_server)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn antigravity_falls_back_to_newest_t3_version() {
        let root = temp_config_home("antigravity-t3");
        let local = root.join("local");
        let versions = root
            .join("home")
            .join(".t3")
            .join("tools")
            .join("antigravity-acp")
            .join("win32-x64")
            .join("versions");
        let older = versions.join("a").join("agy_acp_server.exe");
        std::fs::create_dir_all(older.parent().unwrap()).unwrap();
        std::fs::write(&older, b"older").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let newer = versions.join("b").join("agy_acp_server.exe");
        std::fs::create_dir_all(newer.parent().unwrap()).unwrap();
        std::fs::write(&newer, b"newer").unwrap();
        std::fs::create_dir_all(versions.join("empty")).unwrap();

        assert_eq!(
            antigravity_server_path_in(Some(&local), Some(&root.join("home"))),
            Some(newer)
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn antigravity_missing_everywhere_is_none() {
        let root = temp_config_home("antigravity-none");
        let local = root.join("local");
        let home = root.join("home");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        assert_eq!(antigravity_server_path_in(Some(&local), Some(&home)), None);
        std::fs::remove_dir_all(&root).unwrap();
    }

    fn temp_config_home(label: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "pult-config-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn load_instances_checked_reports_corrupt_toml_without_silent_empty() {
        let home = temp_config_home("corrupt-load");
        assert_eq!(
            load_instances_checked(&home).unwrap(),
            Vec::<InstanceSpec>::new()
        );

        std::fs::write(
            home.join("config.toml"),
            "[[instances]\nbroken = [unterminated",
        )
        .unwrap();
        let err = load_instances_checked(&home).unwrap_err();
        assert!(!err.is_empty());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn save_instances_preserves_existing_file_when_toml_is_corrupt_or_write_fails() {
        let home = temp_config_home("atomic-save");
        let config_path = home.join("config.toml");
        let corrupt = "[[instances]\nbroken = \"unterminated";
        std::fs::write(&config_path, corrupt).unwrap();

        assert!(save_instances(&home, &[mock_spec()]).is_err());
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            corrupt,
            "corrupt config.toml must not be truncated or overwritten on save error"
        );

        std::fs::write(&config_path, "theme = \"t3-dark\"\n").unwrap();
        save_instances(&home, &[mock_spec()]).unwrap();
        let loaded = load_instances_checked(&home).unwrap();
        assert_eq!(loaded, vec![mock_spec()]);

        let tmp_leftovers: Vec<_> = std::fs::read_dir(&home)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(
            tmp_leftovers.is_empty(),
            "no leftover .tmp files expected after save, found {tmp_leftovers:?}"
        );

        let _ = std::fs::remove_dir_all(&home);
    }
}
