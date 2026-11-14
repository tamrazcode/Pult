//! Idle agent-process pool (Task 4): keeps a warm ACP process + session per
//! thread so the next turn skips spawn, initialize, and session/new|load.
//!
//! Interface skeleton only — behavior is implemented after the failing tests
//! land (TDD order).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::drivers::acp::{AcpConn, ClientRequest};
use crate::events::EventKind;
use crate::runtime::DesiredConfigMap;

pub const MAX_IDLE_CONNS: usize = 6;
pub const IDLE_TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSig {
    pub command: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

pub struct IdleConn {
    pub conn: std::sync::Arc<AcpConn>,
    pub events_rx: UnboundedReceiver<EventKind>,
    pub client_requests_rx: UnboundedReceiver<ClientRequest>,
    pub session_id: String,
    pub instance_id: String,
    pub root: PathBuf,
    pub spawn_sig: SpawnSig,
    pub applied_config: DesiredConfigMap,
    pub applied_mode: Option<String>,
    pub last_used: Instant,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PoolStats {
    pub idle: usize,
    pub evicted: u64,
    pub expired: u64,
}

pub struct IdlePool {
    entries: Mutex<HashMap<String, IdleConn>>,
    evicted: AtomicU64,
    expired: AtomicU64,
}

impl IdlePool {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            evicted: AtomicU64::new(0),
            expired: AtomicU64::new(0),
        }
    }

    pub fn take_matching(
        &self,
        thread_id: &str,
        instance_id: &str,
        root: &Path,
        spawn_sig: &SpawnSig,
    ) -> Option<IdleConn> {
        let entry = self.lock().remove(thread_id)?;
        let matches =
            entry.instance_id == instance_id && entry.root == root && &entry.spawn_sig == spawn_sig;
        if !matches || entry.conn.is_dead() {
            entry.conn.kill();
            return None;
        }
        Some(entry)
    }

    pub fn park(&self, thread_id: String, entry: IdleConn) {
        let now = Instant::now();
        let mut kill = Vec::new();
        {
            let mut entries = self.lock();
            let stale: Vec<String> = entries
                .iter()
                .filter(|(_, e)| now.duration_since(e.last_used) > IDLE_TTL)
                .map(|(key, _)| key.clone())
                .collect();
            for key in stale {
                if let Some(old) = entries.remove(&key) {
                    kill.push(old.conn);
                    self.expired.fetch_add(1, Ordering::Relaxed);
                }
            }
            if let Some(old) = entries.remove(&thread_id) {
                kill.push(old.conn);
            }
            entries.insert(thread_id, entry);
            while entries.len() > MAX_IDLE_CONNS {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(key, _)| key.clone());
                let Some(key) = oldest else { break };
                if let Some(old) = entries.remove(&key) {
                    kill.push(old.conn);
                    self.evicted.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for conn in kill {
            conn.kill();
        }
    }

    pub fn invalidate_thread(&self, thread_id: &str) {
        let entry = self.lock().remove(thread_id);
        if let Some(entry) = entry {
            entry.conn.kill();
        }
    }

    pub fn invalidate_instance(&self, instance_id: &str) {
        self.remove_matching(|entry| entry.instance_id == instance_id);
    }

    pub fn invalidate_root(&self, root: &Path) {
        self.remove_matching(|entry| entry.root == root);
    }

    pub fn evict_expired(&self) {
        let now = Instant::now();
        let mut kill = Vec::new();
        {
            let mut entries = self.lock();
            let stale: Vec<String> = entries
                .iter()
                .filter(|(_, e)| now.duration_since(e.last_used) > IDLE_TTL)
                .map(|(key, _)| key.clone())
                .collect();
            for key in stale {
                if let Some(old) = entries.remove(&key) {
                    kill.push(old.conn);
                    self.expired.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for conn in kill {
            conn.kill();
        }
    }

    pub fn stats(&self) -> PoolStats {
        PoolStats {
            idle: self.lock().len(),
            evicted: self.evicted.load(Ordering::Relaxed),
            expired: self.expired.load(Ordering::Relaxed),
        }
    }

    fn remove_matching(&self, predicate: impl Fn(&IdleConn) -> bool) {
        let mut kill = Vec::new();
        {
            let mut entries = self.lock();
            let keys: Vec<String> = entries
                .iter()
                .filter(|(_, entry)| predicate(entry))
                .map(|(key, _)| key.clone())
                .collect();
            for key in keys {
                if let Some(entry) = entries.remove(&key) {
                    kill.push(entry.conn);
                }
            }
        }
        for conn in kill {
            conn.kill();
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, IdleConn>> {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Drop for IdlePool {
    fn drop(&mut self) {
        if let Ok(entries) = self.entries.get_mut() {
            for entry in entries.values() {
                entry.conn.kill();
            }
        }
    }
}

impl Default for IdlePool {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::await_holding_lock)]

    use super::*;
    use crate::drivers::acp::SpawnConfig;
    use std::sync::Arc;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn fixture_path() -> PathBuf {
        let mut candidates = Vec::new();
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("fixtures/mock-acp-agent.mjs"));
            candidates.push(cwd.join("../fixtures/mock-acp-agent.mjs"));
        }
        candidates
            .into_iter()
            .find(|p| p.is_file())
            .expect("mock fixture present")
    }

    fn mock_sig() -> SpawnSig {
        SpawnSig {
            command: "node".to_string(),
            args: vec![fixture_path().to_string_lossy().into_owned()],
            env: BTreeMap::new(),
        }
    }

    fn spawn_idle_conn(
        thread_id: &str,
        instance_id: &str,
        root: &Path,
        sig: &SpawnSig,
        last_used: Instant,
    ) -> IdleConn {
        let config = SpawnConfig {
            command: sig.command.clone(),
            args: sig.args.clone(),
            env: sig
                .env
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        };
        let (conn, streams) = AcpConn::spawn(&config).expect("spawn mock agent");
        IdleConn {
            conn: Arc::new(conn),
            events_rx: streams.events_rx,
            client_requests_rx: streams.client_requests_rx,
            session_id: format!("sess-{thread_id}"),
            instance_id: instance_id.to_string(),
            root: root.to_path_buf(),
            spawn_sig: sig.clone(),
            applied_config: DesiredConfigMap::new(),
            applied_mode: None,
            last_used,
        }
    }

    async fn wait_dead(conn: &AcpConn) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !conn.is_dead() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "connection did not die within 5s"
            );
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    }

    #[tokio::test]
    async fn lru_eviction_keeps_six_and_kills_oldest() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-lru");
        let sig = mock_sig();
        let base = Instant::now();

        let mut conns = Vec::new();
        for i in 1..=7u64 {
            let last_used = base
                .checked_sub(Duration::from_millis((10 - i) * 50))
                .unwrap_or(base);
            let entry = spawn_idle_conn(&format!("th-{i}"), "mock", &root, &sig, last_used);
            conns.push(Arc::clone(&entry.conn));
            pool.park(format!("th-{i}"), entry);
        }

        let stats = pool.stats();
        assert_eq!(stats.idle, MAX_IDLE_CONNS);
        assert_eq!(stats.evicted, 1);

        wait_dead(&conns[0]).await;
        assert!(
            pool.take_matching("th-1", "mock", &root, &sig).is_none(),
            "oldest entry must have been evicted"
        );
        let newest = pool.take_matching("th-7", "mock", &root, &sig);
        assert!(newest.is_some(), "newest entry must remain in pool");
        assert!(!conns[6].is_dead());
    }

    #[tokio::test]
    async fn ttl_expiry_drops_stale_entry_and_updates_stats() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-ttl");
        let sig = mock_sig();
        let expired_at = Instant::now()
            .checked_sub(IDLE_TTL + Duration::from_secs(5))
            .expect("system uptime must exceed IDLE_TTL for TTL expiry test");

        // Case 1: evict_expired drops an entry older than IDLE_TTL.
        let stale_entry = spawn_idle_conn("th-expired", "mock", &root, &sig, expired_at);
        let stale_conn = Arc::clone(&stale_entry.conn);
        pool.park("th-expired".to_string(), stale_entry);
        pool.evict_expired();

        let stats = pool.stats();
        assert_eq!(stats.idle, 0);
        assert_eq!(stats.expired, 1);
        wait_dead(&stale_conn).await;
        assert!(pool
            .take_matching("th-expired", "mock", &root, &sig)
            .is_none());

        // Case 2: parking a fresh entry sweeps an already-expired sibling.
        let old_entry = spawn_idle_conn("th-old", "mock", &root, &sig, expired_at);
        let old_conn = Arc::clone(&old_entry.conn);
        pool.park("th-old".to_string(), old_entry);

        let fresh_entry = spawn_idle_conn("th-fresh", "mock", &root, &sig, Instant::now());
        pool.park("th-fresh".to_string(), fresh_entry);

        let stats = pool.stats();
        assert_eq!(stats.idle, 1);
        assert_eq!(stats.expired, 2);
        wait_dead(&old_conn).await;
        assert!(pool
            .take_matching("th-fresh", "mock", &root, &sig)
            .is_some());
    }

    #[tokio::test]
    async fn take_matching_returns_none_and_kills_on_mismatch() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root_a = std::env::temp_dir().join("pult-pool-root-a");
        let root_b = std::env::temp_dir().join("pult-pool-root-b");
        let sig_a = mock_sig();
        let mut sig_b = sig_a.clone();
        sig_b.env.insert("EXTRA_FLAG".to_string(), "1".to_string());

        // Mismatched instance_id
        let entry1 = spawn_idle_conn("th-inst", "mock", &root_a, &sig_a, Instant::now());
        let conn1 = Arc::clone(&entry1.conn);
        pool.park("th-inst".to_string(), entry1);
        assert!(pool
            .take_matching("th-inst", "other", &root_a, &sig_a)
            .is_none());
        assert_eq!(pool.stats().idle, 0);
        wait_dead(&conn1).await;

        // Mismatched root
        let entry2 = spawn_idle_conn("th-root", "mock", &root_a, &sig_a, Instant::now());
        let conn2 = Arc::clone(&entry2.conn);
        pool.park("th-root".to_string(), entry2);
        assert!(pool
            .take_matching("th-root", "mock", &root_b, &sig_a)
            .is_none());
        assert_eq!(pool.stats().idle, 0);
        wait_dead(&conn2).await;

        // Mismatched spawn_sig
        let entry3 = spawn_idle_conn("th-sig", "mock", &root_a, &sig_a, Instant::now());
        let conn3 = Arc::clone(&entry3.conn);
        pool.park("th-sig".to_string(), entry3);
        assert!(pool
            .take_matching("th-sig", "mock", &root_a, &sig_b)
            .is_none());
        assert_eq!(pool.stats().idle, 0);
        wait_dead(&conn3).await;
    }

    #[tokio::test]
    async fn take_matching_returns_none_for_dead_connection() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-dead");
        let sig = mock_sig();

        let entry = spawn_idle_conn("th-dead", "mock", &root, &sig, Instant::now());
        let conn = Arc::clone(&entry.conn);
        pool.park("th-dead".to_string(), entry);

        conn.kill();
        wait_dead(&conn).await;

        assert!(pool.take_matching("th-dead", "mock", &root, &sig).is_none());
        assert_eq!(pool.stats().idle, 0);
    }

    #[tokio::test]
    async fn take_matching_returns_some_for_matching_live_entry_and_removes_it() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-hit");
        let sig = mock_sig();

        let entry = spawn_idle_conn("th-live", "mock", &root, &sig, Instant::now());
        pool.park("th-live".to_string(), entry);
        assert_eq!(pool.stats().idle, 1);

        let taken = pool
            .take_matching("th-live", "mock", &root, &sig)
            .expect("matching live entry must be returned");
        assert_eq!(taken.session_id, "sess-th-live");
        assert!(!taken.conn.is_dead());
        assert_eq!(pool.stats().idle, 0);
        assert!(pool.take_matching("th-live", "mock", &root, &sig).is_none());
    }
}
