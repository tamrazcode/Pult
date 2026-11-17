//! Agent drivers. `acp` is the universal driver; `pi_rpc` is Pi's native
//! JSONL protocol. The runtime talks to both through `AgentConn`.

pub mod acp;
pub mod pi_rpc;

#[cfg(test)]
mod golden;

use std::sync::Arc;

use tokio::sync::mpsc;

use crate::events::EventKind;
use crate::protocol::jsonrpc::RequestId;
use crate::protocol::types::{
    AuthenticateResult, ConfigOptionValue, ContentBlock, InitializeResult, LoadSessionResult,
    NewSessionResult, PromptResult, SetConfigOptionResult,
};

use acp::{AcpConn, ClientReply, ClientRequest, DriverError, SpawnConfig};

pub struct AgentStreams {
    pub events_rx: mpsc::UnboundedReceiver<EventKind>,
    pub client_requests_rx: mpsc::UnboundedReceiver<ClientRequest>,
}

/// One live agent process: ACP for most providers, native RPC for Pi.
pub enum AgentConn {
    Acp(Arc<AcpConn>),
    Pi(Arc<pi_rpc::PiRpcConn>),
}

impl AgentConn {
    pub fn spawn(config: &SpawnConfig) -> Result<(Self, AgentStreams), DriverError> {
        if config.driver == "pi_rpc" {
            let (conn, streams) = pi_rpc::PiRpcConn::spawn(config)?;
            Ok((
                Self::Pi(Arc::new(conn)),
                AgentStreams {
                    events_rx: streams.events_rx,
                    client_requests_rx: streams.client_requests_rx,
                },
            ))
        } else {
            let (conn, streams) = AcpConn::spawn(config)?;
            Ok((
                Self::Acp(Arc::new(conn)),
                AgentStreams {
                    events_rx: streams.events_rx,
                    client_requests_rx: streams.client_requests_rx,
                },
            ))
        }
    }

    pub fn diagnostics_frames(&self) -> Vec<String> {
        match self {
            Self::Acp(conn) => conn.diagnostics_frames(),
            Self::Pi(conn) => conn.diagnostics_frames(),
        }
    }

    pub fn pid(&self) -> Option<u32> {
        match self {
            Self::Acp(conn) => conn.pid(),
            Self::Pi(conn) => conn.pid(),
        }
    }

    pub fn is_dead(&self) -> bool {
        match self {
            Self::Acp(conn) => conn.is_dead(),
            Self::Pi(conn) => conn.is_dead(),
        }
    }

    pub fn died_on_own(&self) -> bool {
        match self {
            Self::Acp(conn) => conn.died_on_own(),
            Self::Pi(conn) => conn.died_on_own(),
        }
    }

    pub fn kill(&self) {
        match self {
            Self::Acp(conn) => conn.kill(),
            Self::Pi(conn) => conn.kill(),
        }
    }

    pub async fn initialize(&self) -> Result<InitializeResult, DriverError> {
        match self {
            Self::Acp(conn) => conn.initialize().await,
            Self::Pi(conn) => conn.initialize().await,
        }
    }

    pub async fn authenticate(&self, method_id: &str) -> Result<AuthenticateResult, DriverError> {
        match self {
            Self::Acp(conn) => conn.authenticate(method_id).await,
            Self::Pi(conn) => conn.authenticate(method_id).await,
        }
    }

    pub async fn new_session_with_mcp(
        &self,
        cwd: &str,
        mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<NewSessionResult, DriverError> {
        match self {
            Self::Acp(conn) => conn.new_session_with_mcp(cwd, mcp_servers).await,
            Self::Pi(conn) => conn.new_session_with_mcp(cwd, mcp_servers).await,
        }
    }

    pub async fn new_session(&self, cwd: &str) -> Result<NewSessionResult, DriverError> {
        self.new_session_with_mcp(cwd, Vec::new()).await
    }

    pub async fn load_session_with_mcp(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<crate::protocol::types::McpServer>,
    ) -> Result<LoadSessionResult, DriverError> {
        match self {
            Self::Acp(conn) => {
                conn.load_session_with_mcp(session_id, cwd, mcp_servers)
                    .await
            }
            Self::Pi(conn) => {
                conn.load_session_with_mcp(session_id, cwd, mcp_servers)
                    .await
            }
        }
    }

    pub async fn prompt(
        &self,
        session_id: &str,
        content: Vec<ContentBlock>,
    ) -> Result<PromptResult, DriverError> {
        match self {
            Self::Acp(conn) => conn.prompt(session_id, content).await,
            Self::Pi(conn) => conn.prompt(session_id, content).await,
        }
    }

    pub async fn cancel(&self, session_id: &str) -> Result<(), DriverError> {
        match self {
            Self::Acp(conn) => conn.cancel(session_id).await,
            Self::Pi(conn) => conn.cancel(session_id).await,
        }
    }

    pub async fn set_mode(
        &self,
        session_id: &str,
        mode_id: &str,
    ) -> Result<serde_json::Value, DriverError> {
        match self {
            Self::Acp(conn) => conn.set_mode(session_id, mode_id).await,
            Self::Pi(conn) => conn.set_mode(session_id, mode_id).await,
        }
    }

    pub async fn set_config_option(
        &self,
        session_id: &str,
        config_id: &str,
        value: ConfigOptionValue,
    ) -> Result<SetConfigOptionResult, DriverError> {
        match self {
            Self::Acp(conn) => conn.set_config_option(session_id, config_id, value).await,
            Self::Pi(conn) => conn.set_config_option(session_id, config_id, value).await,
        }
    }

    pub async fn respond_client(
        &self,
        request_id: RequestId,
        reply: ClientReply,
    ) -> Result<(), DriverError> {
        match self {
            Self::Acp(conn) => conn.respond_client(request_id, reply).await,
            Self::Pi(conn) => conn.respond_client(request_id, reply).await,
        }
    }
}
