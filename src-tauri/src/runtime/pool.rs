//! Idle agent-process pool (Task 4): keeps a warm ACP process + session per
//! thread so the next turn skips spawn, initialize, and session/new|load.
//!
//! Interface skeleton only — behavior is implemented after the failing tests
//! land (TDD order).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::mpsc::UnboundedReceiver;

use crate::drivers::acp::{AcpConn, ClientRequest};
use crate::events::EventKind;
use crate::runtime::terminals::TerminalRegistry;
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
    /// Terminal ownership token for this connection. Never the ACP session id:
    /// two agent processes can report the same remote id.
    pub owner_token: String,
    pub instance_id: String,
    pub root: PathBuf,
    pub spawn_sig: SpawnSig,
    pub applied_config: DesiredConfigMap,
    pub applied_mode: Option<String>,
    /// Orchestration bearer issued for this ACP session, if any.
    pub mcp_token: Option<String>,
    /// `<pult_instructions>` already traveled on the wire for this session.
    pub instructions_injected: bool,
    /// Compaction generation the injection belongs to.
    pub compaction_epoch: u64,
    /// MCP configuration generation this session was opened with.
    pub mcp_generation: u64,
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
    /// Agent terminals belong to a session; killing the session releases them.
    terminals: Arc<TerminalRegistry>,
    /// Bearer tokens are revoked the moment their ACP session dies.
    mcp_registry: Option<Arc<crate::orchestrator::McpTokenRegistry>>,
    /// Gateway tokens issued for user MCP servers, revoked with the session.
    gateway_tokens: Option<Arc<crate::mcp::gateway::GatewayTokens>>,
}

impl IdlePool {
    /// Pool without a shared terminal registry (tests, isolated use).
    pub fn new() -> Self {
        Self::with_terminals(Arc::new(TerminalRegistry::default()))
    }

    /// Production pool: terminal release follows session eviction/kill.
    pub fn with_terminals(terminals: Arc<TerminalRegistry>) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            evicted: AtomicU64::new(0),
            expired: AtomicU64::new(0),
            terminals,
            mcp_registry: None,
            gateway_tokens: None,
        }
    }

    /// Production pool also revokes orchestration tokens on eviction.
    pub fn with_mcp_registry(
        mut self,
        registry: Arc<crate::orchestrator::McpTokenRegistry>,
    ) -> Self {
        self.mcp_registry = Some(registry);
        self
    }

    /// Revokes user-MCP gateway tokens when their ACP session is evicted.
    pub fn with_gateway_tokens(mut self, tokens: Arc<crate::mcp::gateway::GatewayTokens>) -> Self {
        self.gateway_tokens = Some(tokens);
        self
    }

    /// Kill a warm session and everything it still owns.
    fn kill_idle(&self, entry: IdleConn) {
        entry.conn.kill();
        self.terminals.release_owner(&entry.owner_token);
        if let Some(registry) = &self.mcp_registry {
            registry.revoke(&entry.owner_token);
        }
        if let Some(tokens) = &self.gateway_tokens {
            tokens.revoke_owner(&entry.owner_token);
        }
    }

    pub fn take_matching(
        &self,
        thread_id: &str,
        instance_id: &str,
        root: &Path,
        spawn_sig: &SpawnSig,
    ) -> Option<IdleConn> {
        self.take_matching_generation(thread_id, instance_id, root, spawn_sig, 0)
    }

    /// A session opened under an older MCP configuration is stale: kill it and
    /// let the next turn open a fresh one with the current server list.
    pub fn take_matching_generation(
        &self,
        thread_id: &str,
        instance_id: &str,
        root: &Path,
        spawn_sig: &SpawnSig,
        mcp_generation: u64,
    ) -> Option<IdleConn> {
        // Reap any entry past its TTL even when no new turn parks one.
        self.evict_expired();
        let entry = self.lock().remove(thread_id)?;
        if entry.mcp_generation != mcp_generation {
            self.kill_idle(entry);
            self.evicted.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        if Instant::now().duration_since(entry.last_used) > IDLE_TTL {
            self.kill_idle(entry);
            self.expired.fetch_add(1, Ordering::Relaxed);
            return None;
        }
        let matches =
            entry.instance_id == instance_id && entry.root == root && &entry.spawn_sig == spawn_sig;
        if !matches || entry.conn.is_dead() {
            self.kill_idle(entry);
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
                    kill.push(old);
                    self.expired.fetch_add(1, Ordering::Relaxed);
                }
            }
            if let Some(old) = entries.remove(&thread_id) {
                kill.push(old);
            }
            entries.insert(thread_id, entry);
            while entries.len() > MAX_IDLE_CONNS {
                let oldest = entries
                    .iter()
                    .min_by_key(|(_, e)| e.last_used)
                    .map(|(key, _)| key.clone());
                let Some(key) = oldest else { break };
                if let Some(old) = entries.remove(&key) {
                    kill.push(old);
                    self.evicted.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for entry in kill {
            self.kill_idle(entry);
        }
    }

    pub fn invalidate_thread(&self, thread_id: &str) {
        let entry = self.lock().remove(thread_id);
        if let Some(entry) = entry {
            self.kill_idle(entry);
        }
    }

    pub fn invalidate_instance(&self, instance_id: &str) {
        self.remove_matching(|entry| entry.instance_id == instance_id);
    }

    pub fn invalidate_root(&self, root: &Path) {
        self.remove_matching(|entry| entry.root == root);
    }

    /// Broad config change (a global MCP server was edited): every warm
    /// session may be stale, so drop all of them.
    pub fn invalidate_all(&self) {
        self.remove_matching(|_| true);
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
                    kill.push(old);
                    self.expired.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
        for entry in kill {
            self.kill_idle(entry);
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
                    kill.push(entry);
                }
            }
        }
        for entry in kill {
            self.kill_idle(entry);
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
                self.terminals.release_owner(&entry.owner_token);
                if let Some(registry) = &self.mcp_registry {
                    registry.revoke(&entry.owner_token);
                }
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
            env_remove: Vec::new(),
        };
        let (conn, streams) = AcpConn::spawn(&config).expect("spawn mock agent");
        IdleConn {
            conn: Arc::new(conn),
            events_rx: streams.events_rx,
            client_requests_rx: streams.client_requests_rx,
            session_id: format!("sess-{thread_id}"),
            owner_token: format!("owner-{thread_id}"),
            instance_id: instance_id.to_string(),
            root: root.to_path_buf(),
            spawn_sig: sig.clone(),
            applied_config: DesiredConfigMap::new(),
            applied_mode: None,
            mcp_token: None,
            instructions_injected: false,
            compaction_epoch: 0,
            mcp_generation: 0,
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
    async fn a_stale_mcp_generation_is_discarded_instead_of_reused() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-mcp-generation");
        let sig = mock_sig();
        let entry = spawn_idle_conn("th-gen", "mock", &root, &sig, Instant::now());
        let conn = Arc::clone(&entry.conn);
        pool.park("th-gen".to_string(), entry);

        assert!(pool
            .take_matching_generation("th-gen", "mock", &root, &sig, 1)
            .is_none());
        assert_eq!(pool.stats().idle, 0);
        wait_dead(&conn).await;
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

    #[tokio::test]
    async fn invalidating_a_session_revokes_its_orchestration_token() {
        let _env = env_lock();
        let registry = Arc::new(crate::orchestrator::McpTokenRegistry::new());
        let pool = IdlePool::new().with_mcp_registry(Arc::clone(&registry));
        let root = std::env::temp_dir().join("pult-pool-token");
        let sig = mock_sig();
        let entry = spawn_idle_conn("th-token", "mock", &root, &sig, Instant::now());
        let token = registry.issue(crate::orchestrator::McpScope::new(
            "owner-th-token",
            "th-token",
            0,
        ));
        pool.park("th-token".to_string(), entry);
        assert!(registry.resolve(&token).is_some());

        pool.invalidate_thread("th-token");

        assert!(registry.resolve(&token).is_none());
        assert!(pool.stats().idle == 0);
    }

    #[tokio::test]
    async fn take_matching_evicts_expired_entry() {
        let _env = env_lock();
        let pool = IdlePool::new();
        let root = std::env::temp_dir().join("pult-pool-take-expired");
        let sig = mock_sig();
        let expired_at = Instant::now()
            .checked_sub(IDLE_TTL + Duration::from_secs(5))
            .unwrap();

        // Park fresh first so parking the expired entry does not sweep it away
        // before take_matching is exercised.
        let fresh_entry = spawn_idle_conn("th-fresh", "mock", &root, &sig, Instant::now());
        pool.park("th-fresh".to_string(), fresh_entry);

        let expired_entry = spawn_idle_conn("th-expired", "mock", &root, &sig, expired_at);
        let expired_conn = Arc::clone(&expired_entry.conn);
        pool.park("th-expired".to_string(), expired_entry);

        assert!(
            pool.take_matching("th-expired", "mock", &root, &sig)
                .is_none(),
            "take_matching must evict and return None for an entry older than IDLE_TTL"
        );
        let stats = pool.stats();
        assert_eq!(stats.expired, 1);
        assert_eq!(stats.idle, 1);
        wait_dead(&expired_conn).await;

        let fresh = pool.take_matching("th-fresh", "mock", &root, &sig);
        assert!(fresh.is_some(), "fresh entry must still be returned");
        assert!(!fresh.unwrap().conn.is_dead());
    }
}
