//! Per-instance provider model preferences (default, disabled, order, custom).

use rusqlite::{params, OptionalExtension};

use crate::events::now_millis;
use crate::PultError;

use super::{sql, Store};

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelPrefs {
    pub instance_id: String,
    pub default_model_id: Option<String>,
    pub disable_all: bool,
    pub disabled_models: Vec<String>,
    pub model_order: Vec<String>,
    pub custom_models: Vec<String>,
    pub updated_at: i64,
}

impl Store {
    pub fn get_provider_model_prefs(
        &self,
        instance_id: &str,
    ) -> Result<Option<ProviderModelPrefs>, PultError> {
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT instance_id, default_model_id, disable_all,
                        disabled_models_json, model_order_json, custom_models_json, updated_at
                 FROM provider_model_preferences WHERE instance_id = ?1",
                params![instance_id],
                prefs_from_row,
            )
            .optional()
            .map_err(|e| sql("get provider model prefs", e))
        })
    }

    pub fn list_provider_model_prefs(&self) -> Result<Vec<ProviderModelPrefs>, PultError> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT instance_id, default_model_id, disable_all,
                            disabled_models_json, model_order_json, custom_models_json, updated_at
                     FROM provider_model_preferences ORDER BY instance_id",
                )
                .map_err(|e| sql("list provider model prefs", e))?;
            let rows = stmt
                .query_map([], prefs_from_row)
                .map_err(|e| sql("list provider model prefs", e))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| sql("list provider model prefs row", e))
        })
    }

    pub fn set_provider_model_prefs(&self, prefs: &ProviderModelPrefs) -> Result<(), PultError> {
        let updated_at = now_millis();
        self.with_conn(|conn| {
            conn.execute(
                "INSERT INTO provider_model_preferences (
                    instance_id, default_model_id, disable_all, disabled_models_json,
                    model_order_json, custom_models_json, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(instance_id) DO UPDATE SET
                    default_model_id = excluded.default_model_id,
                    disable_all = excluded.disable_all,
                    disabled_models_json = excluded.disabled_models_json,
                    model_order_json = excluded.model_order_json,
                    custom_models_json = excluded.custom_models_json,
                    updated_at = excluded.updated_at",
                params![
                    prefs.instance_id,
                    prefs.default_model_id,
                    prefs.disable_all,
                    encode(&prefs.disabled_models),
                    encode(&prefs.model_order),
                    encode(&prefs.custom_models),
                    updated_at,
                ],
            )
            .map_err(|e| sql("set provider model prefs", e))?;
            Ok(())
        })
    }

    pub fn delete_provider_model_prefs(&self, instance_id: &str) -> Result<(), PultError> {
        self.with_conn(|conn| {
            conn.execute(
                "DELETE FROM provider_model_preferences WHERE instance_id = ?1",
                params![instance_id],
            )
            .map_err(|e| sql("delete provider model prefs", e))?;
            Ok(())
        })
    }
}

fn prefs_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProviderModelPrefs> {
    Ok(ProviderModelPrefs {
        instance_id: row.get(0)?,
        default_model_id: row.get(1)?,
        disable_all: row.get(2)?,
        disabled_models: decode(row.get::<_, String>(3)?),
        model_order: decode(row.get::<_, String>(4)?),
        custom_models: decode(row.get::<_, String>(5)?),
        updated_at: row.get(6)?,
    })
}

fn encode(values: &[String]) -> String {
    serde_json::to_string(values).unwrap_or_else(|_| "[]".to_string())
}

fn decode(raw: String) -> Vec<String> {
    serde_json::from_str(&raw).unwrap_or_default()
}
