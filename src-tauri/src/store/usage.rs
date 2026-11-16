//! Read-only usage aggregation over the persisted event log (`kind = 'usage'`).
//!
//! ACP `usage_update` is a gauge: `used`/`size` describe the context window at
//! that moment, and `cost` is whatever the agent reports (per-turn or
//! cumulative). The report therefore keeps the LAST snapshot per run and never
//! sums gauges across runs.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::PultError;

use super::{sql, Store};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub amount: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct UsageSnapshot {
    pub used: Option<u64>,
    pub size: Option<u64>,
    pub cost: Option<UsageCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunUsageRecord {
    pub run_id: String,
    pub thread_id: String,
    pub thread_title: String,
    pub run_idx: i64,
    pub status: String,
    pub instance_id: String,
    pub model: Option<String>,
    pub started_at: i64,
    pub stopped_at: Option<i64>,
    pub usage_ts: i64,
    pub used: Option<u64>,
    pub size: Option<u64>,
    pub cost: Option<UsageCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUsageSummary {
    pub thread_id: String,
    pub thread_title: String,
    pub runs_with_usage: u64,
    pub latest_run_id: String,
    pub latest_instance_id: String,
    pub latest_started_at: i64,
    pub latest_used: Option<u64>,
    pub latest_size: Option<u64>,
    pub peak_used: Option<u64>,
    pub latest_cost: Option<UsageCost>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstanceUsageSummary {
    pub instance_id: String,
    pub runs_with_usage: u64,
    pub median_used: Option<u64>,
    pub peak_used: Option<u64>,
    pub latest_cost: Option<UsageCost>,
    pub last_used_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    pub total_runs: u64,
    pub runs: Vec<RunUsageRecord>,
    pub by_thread: Vec<ThreadUsageSummary>,
    pub by_instance: Vec<InstanceUsageSummary>,
}

/// Parses one stored `usage` payload (`{"detail": {...}}`). Corrupt, partial
/// or non-ACP shapes yield `None`; never panics.
pub fn parse_usage_detail(payload_json: &str) -> Option<UsageSnapshot> {
    let payload: Value = serde_json::from_str(payload_json).ok()?;
    let detail = payload.get("detail")?;
    let used = detail.get("used").and_then(Value::as_u64);
    let size = detail.get("size").and_then(Value::as_u64);
    let cost = detail.get("cost").and_then(|cost| {
        let amount = cost.get("amount").and_then(Value::as_f64)?;
        if !amount.is_finite() || amount < 0.0 {
            return None;
        }
        let currency = cost
            .get("currency")
            .and_then(Value::as_str)
            .map(str::to_string);
        Some(UsageCost { amount, currency })
    });
    if used.is_none() && size.is_none() && cost.is_none() {
        return None;
    }
    Some(UsageSnapshot { used, size, cost })
}

impl Store {
    /// Latest valid usage snapshot per run plus thread/instance groupings.
    pub fn usage_report(&self) -> Result<UsageReport, PultError> {
        self.with_conn(|conn| {
            let total_runs: i64 = conn
                .query_row("SELECT COUNT(*) FROM runs", [], |row| row.get(0))
                .map_err(|e| sql("usage_report count runs", e))?;
            let mut stmt = conn
                .prepare(
                    "SELECT e.run_id, r.thread_id, t.title, r.idx, r.status, r.instance_id,
                            r.model, r.started_at, r.stopped_at, e.seq, e.ts, e.payload
                     FROM events AS e
                     JOIN runs AS r ON r.id = e.run_id
                     JOIN threads AS t ON t.id = r.thread_id
                     WHERE e.kind = 'usage'
                     ORDER BY e.run_id ASC, e.seq ASC",
                )
                .map_err(|e| sql("usage_report prepare", e))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, i64>(7)?,
                        row.get::<_, Option<i64>>(8)?,
                        row.get::<_, i64>(9)?,
                        row.get::<_, i64>(10)?,
                        row.get::<_, String>(11)?,
                    ))
                })
                .map_err(|e| sql("usage_report query", e))?;

            let mut by_run: std::collections::BTreeMap<String, RunUsageRecord> =
                std::collections::BTreeMap::new();
            for row in rows {
                let (
                    run_id,
                    thread_id,
                    thread_title,
                    run_idx,
                    status,
                    instance_id,
                    model,
                    started_at,
                    stopped_at,
                    _seq,
                    ts,
                    payload,
                ) = row.map_err(|e| sql("usage_report row", e))?;
                let Some(snapshot) = parse_usage_detail(&payload) else {
                    continue;
                };
                // Rows arrive in ascending seq; the next valid one replaces.
                by_run.insert(
                    run_id.clone(),
                    RunUsageRecord {
                        run_id,
                        thread_id,
                        thread_title,
                        run_idx,
                        status,
                        instance_id,
                        model,
                        started_at,
                        stopped_at,
                        usage_ts: ts,
                        used: snapshot.used,
                        size: snapshot.size,
                        cost: snapshot.cost,
                    },
                );
            }
            let mut runs: Vec<RunUsageRecord> = by_run.into_values().collect();
            runs.sort_by_key(|r| std::cmp::Reverse(r.started_at));

            let mut threads: std::collections::BTreeMap<String, Vec<&RunUsageRecord>> =
                std::collections::BTreeMap::new();
            let mut instances: std::collections::BTreeMap<String, Vec<&RunUsageRecord>> =
                std::collections::BTreeMap::new();
            for run in &runs {
                threads.entry(run.thread_id.clone()).or_default().push(run);
                instances
                    .entry(run.instance_id.clone())
                    .or_default()
                    .push(run);
            }

            let mut by_thread: Vec<ThreadUsageSummary> = threads
                .into_values()
                .map(|mut group| {
                    group.sort_by_key(|r| (std::cmp::Reverse(r.started_at), std::cmp::Reverse(r.run_idx)));
                    let latest = group[0];
                    let latest_cost = group
                        .iter()
                        .filter(|r| r.cost.is_some())
                        .max_by_key(|r| (r.started_at, r.run_idx))
                        .and_then(|r| r.cost.clone());
                    let peak = group.iter().filter_map(|r| r.used).max();
                    ThreadUsageSummary {
                        thread_id: latest.thread_id.clone(),
                        thread_title: latest.thread_title.clone(),
                        runs_with_usage: group.len() as u64,
                        latest_run_id: latest.run_id.clone(),
                        latest_instance_id: latest.instance_id.clone(),
                        latest_started_at: latest.started_at,
                        latest_used: latest.used,
                        latest_size: latest.size,
                        peak_used: peak,
                        latest_cost,
                    }
                })
                .collect();
            by_thread.sort_by_key(|t| std::cmp::Reverse(t.latest_started_at));

            let mut by_instance: Vec<InstanceUsageSummary> = instances
                .into_values()
                .map(|group| {
                    let latest = group
                        .iter()
                        .max_by_key(|r| (r.usage_ts, r.started_at, r.run_idx))
                        .expect("group is non-empty");
                    let latest_cost = group
                        .iter()
                        .filter(|r| r.cost.is_some())
                        .max_by_key(|r| (r.started_at, r.run_idx, r.usage_ts))
                        .and_then(|r| r.cost.clone());
                    let mut used: Vec<u64> = group.iter().filter_map(|r| r.used).collect();
                    used.sort_unstable();
                    let median_used = if used.is_empty() {
                        None
                    } else if used.len() % 2 == 1 {
                        Some(used[used.len() / 2])
                    } else {
                        let mid = used.len() / 2;
                        Some((used[mid - 1] + used[mid]) / 2)
                    };
                    InstanceUsageSummary {
                        instance_id: latest.instance_id.clone(),
                        runs_with_usage: group.len() as u64,
                        median_used,
                        peak_used: used.last().copied(),
                        latest_cost,
                        last_used_at: latest.usage_ts,
                    }
                })
                .collect();
            by_instance.sort_by_key(|i| std::cmp::Reverse(i.last_used_at));

            Ok(UsageReport {
                total_runs: total_runs as u64,
                runs,
                by_thread,
                by_instance,
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::{Event, EventKind};
    use crate::store::records::{RunRecord, ThreadRecord};

    fn thread(id: &str) -> ThreadRecord {
        ThreadRecord {
            id: id.to_string(),
            project_id: None,
            title: format!("Thread {id}"),
            status: "draft".to_string(),
            pinned: false,
            created_at: 1,
            updated_at: 1,
            workspace: None,
            main_repo: None,
            worktree_name: None,
            parent_thread_id: None,
            parent_run_id: None,
            depth: 0,
            lineage_kind: None,
            child_role: None,
        }
    }

    fn run(id: &str, thread_id: &str, idx: i64, instance: &str, started_at: i64) -> RunRecord {
        RunRecord {
            id: id.to_string(),
            thread_id: thread_id.to_string(),
            idx,
            status: "finished".to_string(),
            instance_id: instance.to_string(),
            model: Some("mock-pro".to_string()),
            mode: None,
            effort: None,
            started_at,
            stopped_at: Some(started_at + 100),
            stop_reason: Some("end_turn".to_string()),
            error: None,
        }
    }

    fn usage(store: &Store, run_id: &str, seq: u64, ts: i64, used: u64, size: u64, cost: f64) {
        let mut event = Event::new(
            run_id,
            seq,
            EventKind::Usage {
                detail: serde_json::json!({
                    "used": used,
                    "size": size,
                    "cost": {"amount": cost, "currency": "USD"}
                }),
            },
        );
        event.ts = ts;
        store.append_event(&event).unwrap();
    }

    #[test]
    fn parse_usage_detail_handles_valid_partial_and_corrupt_payloads() {
        let valid = parse_usage_detail(
            r#"{"detail":{"used":12300,"size":200000,"cost":{"amount":0.04,"currency":"USD"}}}"#,
        )
        .expect("valid");
        assert_eq!(valid.used, Some(12300));
        assert_eq!(valid.size, Some(200000));
        assert_eq!(
            valid.cost,
            Some(UsageCost {
                amount: 0.04,
                currency: Some("USD".into())
            })
        );

        let no_cost = parse_usage_detail(r#"{"detail":{"used":5,"size":10,"cost":null}}"#)
            .expect("no cost");
        assert_eq!(no_cost.cost, None);

        for bad in [
            "{broken",
            r#"{"detail":null}"#,
            r#"{"detail":{"used":"123"}}"#,
            r#"{"detail":{"used":-1}}"#,
            r#"{"detail":{"cost":{"amount":-0.5}}}"#,
            r#"{"detail":{"inputTokens":12}}"#,
        ] {
            assert!(parse_usage_detail(bad).is_none(), "must reject {bad}");
        }
    }

    #[test]
    fn usage_report_is_empty_without_data() {
        let store = Store::open_in_memory().unwrap();
        let report = store.usage_report().unwrap();
        assert_eq!(report.total_runs, 0);
        assert!(report.runs.is_empty());
        assert!(report.by_thread.is_empty());
        assert!(report.by_instance.is_empty());
    }

    #[test]
    fn usage_report_keeps_last_snapshot_and_never_sums() {
        let store = Store::open_in_memory().unwrap();
        store.create_thread(&thread("th1")).unwrap();
        store.create_thread(&thread("th2")).unwrap();
        store.create_run(&run("r1", "th1", 0, "mock", 100)).unwrap();
        store.create_run(&run("r2", "th1", 1, "mock", 300)).unwrap();
        store.create_run(&run("r3", "th2", 0, "codex", 500)).unwrap();

        usage(&store, "r1", 1, 10, 12_000, 200_000, 0.05);
        usage(&store, "r1", 2, 20, 50_000, 200_000, 0.12);
        usage(&store, "r1", 3, 30, 50_000, 200_000, 0.12);
        usage(&store, "r3", 1, 40, 7_500, 100_000, 0.02);

        let report = store.usage_report().unwrap();
        assert_eq!(report.total_runs, 3);
        assert_eq!(report.runs.len(), 2, "r2 has no usage and is not invented");
        let latest = report.runs.iter().find(|r| r.run_id == "r1").unwrap();
        assert_eq!(latest.used, Some(50_000), "last seq wins, no sum");
        assert_eq!(latest.cost.as_ref().unwrap().amount, 0.12);

        let th1 = report.by_thread.iter().find(|t| t.thread_id == "th1").unwrap();
        assert_eq!(th1.runs_with_usage, 1);
        assert_eq!(th1.latest_used, Some(50_000));
        assert_eq!(th1.peak_used, Some(50_000));
        assert_eq!(th1.latest_cost.as_ref().unwrap().amount, 0.12);

        let inst = report.by_instance.iter().find(|i| i.instance_id == "codex").unwrap();
        assert_eq!(inst.runs_with_usage, 1);
        assert_eq!(inst.median_used, Some(7_500));
    }

    #[test]
    fn usage_report_serializes_camel_case_keys() {
        let report = UsageReport {
            total_runs: 2,
            runs: vec![],
            by_thread: vec![],
            by_instance: vec![],
        };
        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value["totalRuns"], 2);
        assert!(value["byThread"].is_array());
        assert!(value["byInstance"].is_array());
    }

    #[test]
    fn usage_report_uses_last_cost_bearing_run_and_even_median() {
        let store = Store::open_in_memory().unwrap();
        store.create_thread(&thread("th")).unwrap();
        for (idx, id) in ["r1", "r2", "r3", "r4"].iter().enumerate() {
            store
                .create_run(&run(id, "th", idx as i64, "mock", 100 + idx as i64 * 100))
                .unwrap();
        }
        for (idx, id) in ["r1", "r2", "r3", "r4"].iter().enumerate() {
            store
                .append_event(&Event::new(
                    *id,
                    1,
                    EventKind::Usage {
                        detail: serde_json::json!({
                            "used": (idx as u64 + 1) * 10_000,
                            "size": 100_000,
                            "cost": if idx == 1 || idx == 3 { serde_json::Value::Null } else { serde_json::json!({"amount": 0.01 * (idx as f64 + 1.0), "currency": "USD"}) }
                        }),
                    },
                ))
                .unwrap();
        }
        let report = store.usage_report().unwrap();
        let inst = report.by_instance.iter().find(|i| i.instance_id == "mock").unwrap();
        assert_eq!(inst.median_used, Some(25_000), "even median of 10k/20k/30k/40k");
        assert_eq!(inst.latest_cost.as_ref().unwrap().amount, 0.03, "last run that reported cost");
        let th = &report.by_thread[0];
        assert_eq!(th.latest_cost.as_ref().unwrap().amount, 0.03);
    }

    #[test]
    fn usage_report_skips_a_broken_latest_payload() {
        let store = Store::open_in_memory().unwrap();
        store.create_thread(&thread("th")).unwrap();
        store.create_run(&run("r1", "th", 0, "mock", 100)).unwrap();
        usage(&store, "r1", 1, 10, 1_000, 10_000, 0.01);
        store
            .append_event(&Event::new(
                "r1",
                2,
                EventKind::Usage {
                    detail: serde_json::json!({"used": "oops"}),
                },
            ))
            .unwrap();
        let report = store.usage_report().unwrap();
        assert_eq!(report.runs.len(), 1);
        assert_eq!(report.runs[0].used, Some(1_000));
    }
}
