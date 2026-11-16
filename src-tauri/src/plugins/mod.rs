//! Declarative plugin discovery. Plugins live in `~/.pult/plugins/<id>/` and
//! describe themselves with `pult-plugin.json`. This first milestone reads and
//! validates metadata only; no plugin code is executed, so the surface stays
//! inert until the sandboxed runtime lands.

use std::path::PathBuf;

use serde::Serialize;

use crate::runtime::AgentRuntime;
use crate::PultError;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub path: String,
    pub enabled: bool,
    pub commands: Vec<String>,
    pub slots: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    pub dir: String,
    pub plugins: Vec<PluginInfo>,
}

fn plugins_dir() -> PathBuf {
    crate::pult_home().join("plugins")
}

fn enabled_map(runtime: &AgentRuntime) -> serde_json::Map<String, serde_json::Value> {
    runtime
        .store()
        .get_setting("plugins_state")
        .ok()
        .flatten()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.'
        })
}

#[tauri::command]
pub fn plugins_list(runtime: tauri::State<'_, std::sync::Arc<AgentRuntime>>) -> Result<PluginList, PultError> {
    let dir = plugins_dir();
    let state = enabled_map(&runtime);
    let mut seen = std::collections::HashSet::new();
    let mut plugins = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let plugin_dir = entry.path();
            if !plugin_dir.is_dir() {
                continue;
            }
            let manifest_path = plugin_dir.join("pult-plugin.json");
            let Ok(raw) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let id = manifest.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if !valid_id(id) {
                continue;
            }
            if entry.file_name().to_str() != Some(id) || !seen.insert(id.to_owned()) {
                continue;
            }
            let string = |key: &str| manifest.get(key).and_then(|v| v.as_str()).map(str::to_owned);
            let strings = |key: &str| {
                manifest
                    .get("contributes")
                    .and_then(|value| value.get(key))
                    .and_then(|value| value.as_array())
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(|item| {
                                item.as_str().map(str::to_owned).or_else(|| {
                                    item.get("id").and_then(|id| id.as_str()).map(str::to_owned)
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            };
            let enabled = state.get(id).and_then(|value| value.as_bool()).unwrap_or(false);
            plugins.push(PluginInfo {
                id: id.to_owned(),
                name: string("name").unwrap_or_else(|| id.to_owned()),
                version: string("version").unwrap_or_else(|| "0.0.0".to_owned()),
                description: string("description"),
                author: string("author"),
                path: plugin_dir.display().to_string(),
                enabled,
                commands: strings("commands"),
                slots: strings("slots"),
            });
        }
    }
    plugins.sort_by_key(|plugin| plugin.name.to_lowercase());
    Ok(PluginList {
        dir: dir.display().to_string(),
        plugins,
    })
}

#[tauri::command]
pub fn plugins_set_enabled(
    runtime: tauri::State<'_, std::sync::Arc<AgentRuntime>>,
    id: String,
    enabled: bool,
) -> Result<(), PultError> {
    if !valid_id(&id) {
        return Err(PultError::with_code("plugins.bad_id", "invalid plugin id"));
    }
    let mut state = enabled_map(&runtime);
    state.insert(id, serde_json::Value::Bool(enabled));
    runtime
        .store()
        .set_setting("plugins_state", &serde_json::Value::Object(state))
}
