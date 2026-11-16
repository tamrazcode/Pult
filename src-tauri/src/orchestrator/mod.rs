//! App-owned orchestration plane: the loopback MCP server every ACP session
//! gets, its per-session bearer tokens, and the thin stdio bridge.
//!
//! The server is deliberately dependency-free: raw HTTP/1.1 over tokio, JSON-RPC
//! handled by hand. Tokens are 128-bit random values bound to a thread scope, so
//! a token outliving its ACP session cannot keep delegating work.

pub mod engine;
pub mod instructions;
mod mcp_server;
pub mod stdio;
mod tools;

pub use mcp_server::{OrchestratorMcpServer, ORCHESTRATOR_SERVER_NAME};
pub use tools::{is_read_only_tool, tool_specs, ORCHESTRATOR_TOOL_NAMES};

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;

/// Identity behind one bearer token: the ACP session that owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpScope {
    /// Terminal ownership token of the ACP connection.
    pub owner_token: String,
    pub thread_id: String,
    /// Delegation depth of the thread (root = 0).
    pub depth: u8,
    /// Children of a depth-capped thread may inspect but not delegate.
    pub can_orchestrate: bool,
}

impl McpScope {
    pub fn new(owner_token: impl Into<String>, thread_id: impl Into<String>, depth: u8) -> Self {
        Self {
            owner_token: owner_token.into(),
            thread_id: thread_id.into(),
            depth,
            can_orchestrate: true,
        }
    }
}

/// Result of an orchestrator tool call. Errors are surfaced as MCP `isError`
/// content, not transport failures, so the agent can react to them.
pub type ToolFuture<'a> =
    Pin<Box<dyn Future<Output = Result<serde_json::Value, String>> + Send + 'a>>;

/// Runtime side of the orchestration tools. Implemented by the engine in T05.
pub trait OrchestratorHost: Send + Sync {
    /// Live run id for a thread, if it has one right now. Write tools are
    /// rejected without it so stale sessions cannot mutate other work.
    fn active_run_id(&self, thread_id: &str) -> Option<String>;

    fn call_tool<'a>(
        &'a self,
        scope: &'a McpScope,
        run_id: Option<&'a str>,
        name: &'a str,
        arguments: &'a serde_json::Value,
    ) -> ToolFuture<'a>;
}

/// Bearer tokens, keyed by their random value. Lookup compares every token in
/// constant time so a local process cannot probe which sessions are live.
#[derive(Default)]
pub struct McpTokenRegistry {
    tokens: Mutex<HashMap<String, McpScope>>,
}

impl McpTokenRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a token for one ACP session. Re-issuing for the same owner
    /// replaces the old token, so only the newest session can act.
    pub fn issue(&self, scope: McpScope) -> String {
        let token = random_token();
        let mut tokens = self.lock();
        tokens.retain(|_, existing| existing.owner_token != scope.owner_token);
        tokens.insert(token.clone(), scope);
        token
    }

    pub fn resolve(&self, token: &str) -> Option<McpScope> {
        let tokens = self.lock();
        let mut found = None;
        for (candidate, scope) in tokens.iter() {
            if constant_time_eq(candidate.as_bytes(), token.as_bytes()) {
                found = Some(scope.clone());
            }
        }
        found
    }

    /// Drops every token issued for an ACP connection; returns the count.
    pub fn revoke(&self, owner_token: &str) -> usize {
        let mut tokens = self.lock();
        let before = tokens.len();
        tokens.retain(|_, scope| scope.owner_token != owner_token);
        before - tokens.len()
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, McpScope>> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Names users may never give their own MCP server: the orchestrator is
/// systemic and cannot be shadowed or displaced.
pub fn is_reserved_mcp_name(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "pult_orchestrator" | "pult-orchestrator" | "pult" | "orchestrator"
    )
}

/// 128-bit token, hex encoded. OS randomness keeps tokens unguessable even
/// across processes; the hash fallback only triggers if the OS source fails.
fn random_token() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        use std::hash::{BuildHasher, Hasher};
        let state = std::collections::hash_map::RandomState::new();
        let mut first = state.build_hasher();
        first.write_u64(crate::events::now_millis() as u64);
        first.write_u32(std::process::id());
        let mut second = state.build_hasher();
        second.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
        );
        bytes[..8].copy_from_slice(&first.finish().to_le_bytes());
        bytes[8..].copy_from_slice(&second.finish().to_le_bytes());
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_128_bit_hex_and_bound_to_scope() {
        let registry = McpTokenRegistry::new();
        let token = registry.issue(McpScope::new("owner-a", "th-a", 0));
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
        let scope = registry.resolve(&token).expect("token resolves");
        assert_eq!(scope.thread_id, "th-a");
        assert_eq!(scope.owner_token, "owner-a");
        assert!(registry.resolve("not-a-token").is_none());
    }

    #[test]
    fn reissuing_for_an_owner_revokes_the_old_token() {
        let registry = McpTokenRegistry::new();
        let first = registry.issue(McpScope::new("owner-a", "th-a", 0));
        let second = registry.issue(McpScope::new("owner-a", "th-a", 0));
        assert!(registry.resolve(&first).is_none());
        assert!(registry.resolve(&second).is_some());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn revoke_drops_every_token_of_one_connection() {
        let registry = McpTokenRegistry::new();
        let a = registry.issue(McpScope::new("owner-a", "th-a", 0));
        let b = registry.issue(McpScope::new("owner-b", "th-b", 0));
        assert_eq!(registry.revoke("owner-a"), 1);
        assert!(registry.resolve(&a).is_none());
        assert!(registry.resolve(&b).is_some());
        assert_eq!(registry.revoke("owner-a"), 0);
    }

    #[test]
    fn reserved_names_cannot_be_used_by_custom_servers() {
        for name in [
            "pult_orchestrator",
            " Pult_Orchestrator ",
            "pult",
            "orchestrator",
        ] {
            assert!(is_reserved_mcp_name(name), "{name} must be reserved");
        }
        for name in ["my-server", "orchestrator-extra", "pult-user"] {
            assert!(!is_reserved_mcp_name(name), "{name} must be allowed");
        }
    }

    #[test]
    fn constant_time_compare_matches_only_equal_slices() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
