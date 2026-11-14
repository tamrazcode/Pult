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
    let raw = match std::fs::read_to_string(home.join("config.toml")) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    match toml::from_str::<ConfigFile>(&raw) {
        Ok(config) => config.instances,
        Err(err) => {
            tracing::warn!(target: "pult::config", error = %err, "config.toml parse failed; using defaults");
            Vec::new()
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct ConfigFile {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    instances: Vec<InstanceSpec>,
}

/// Rewrites the `instances` array in `<home>/config.toml`, keeping the rest
/// of the file untouched (parse the whole table → patch the one key → write;
/// creates the file if absent).
pub fn save_instances(home: &Path, specs: &[InstanceSpec]) -> Result<(), PultError> {
    let path = home.join("config.toml");
    let mut table: toml::Table = match std::fs::read_to_string(&path) {
        Ok(raw) => toml::from_str(&raw).map_err(|e| PultError::store(format!("config.toml parse: {e}")))?,
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
    std::fs::write(&path, body).map_err(|e| PultError::store(format!("write config: {e}")))?;
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
type Candidate = (&'static str, &'static str, &'static str, SuggestedCommand, &'static str);

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
            "dsh",
            "dsh",
            "dsh",
            Some(vec!["dsh".to_string(), "--profile".to_string(), "acp".to_string()]),
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
    found
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
                args: vec!["-y".to_string(), "@zed-industries/claude-code-acp".to_string()],
                env: [("DEBUG".to_string(), "1".to_string())].into_iter().collect(),
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
    fn missing_config_yields_empty_and_mock_fills_in() {
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
                "claude-code" | "gemini-cli" | "codex" | "opencode" | "dsh"
            ));
            assert!(
                agent.suggested_command.is_some(),
                "{} must carry a one-click command",
                agent.id
            );
        }
    }
}
