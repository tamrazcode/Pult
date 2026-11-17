//! Background health checks for custom MCP servers: bounded concurrency, never
//! on the chat critical path. Failures only update the row's status.

use std::sync::Arc;

use futures::StreamExt;

use crate::store::Store;

use super::probe;

const MAX_CONCURRENT_PROBES: usize = 4;

/// Probes every enabled server with at most four connections in flight.
pub async fn check_all(store: Arc<Store>) {
    let servers = match store.list_custom_mcp_servers() {
        Ok(servers) => servers,
        Err(error) => {
            tracing::warn!(target: "pult::mcp", error = %error, "MCP health check skipped");
            return;
        }
    };
    let probe_store = Arc::clone(&store);
    futures::stream::iter(servers.into_iter().filter(|server| server.enabled))
        .map(|server| {
            let store = Arc::clone(&probe_store);
            async move {
                let _ = probe::test_connection(&store, &server).await;
            }
        })
        .buffer_unordered(MAX_CONCURRENT_PROBES)
        .collect::<Vec<()>>()
        .await;
}
