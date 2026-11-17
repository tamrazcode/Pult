//! MCP tool surface advertised to every ACP session. The schemas are the
//! contract the engine (T05) implements; keeping them in one place means
//! `tools/list` and argument validation never drift apart.

use serde_json::{json, Value};

pub const ORCHESTRATOR_TOOL_NAMES: [&str; 7] = [
    "orchestrator_capabilities",
    "delegate_task",
    "wait_tasks",
    "get_task",
    "list_tasks",
    "cancel_task",
    "steer_task",
];

/// Tools that read only orchestration state and therefore work even when the
/// parent turn has already finished.
pub fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "orchestrator_capabilities" | "get_task" | "list_tasks"
    )
}

pub fn tool_specs() -> Value {
    json!([
        {
            "name": "orchestrator_capabilities",
            "description": "List connected provider instances, their models and modes, remaining delegation depth, and tasks already delegated from this thread. Call this before delegating.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "delegate_task",
            "description": "Start a child agent on an independent task and return immediately with its task and thread ids. The child sees only the brief, not this conversation.",
            "inputSchema": {
                "type": "object",
                "required": ["title", "task"],
                "properties": {
                    "clientRequestId": { "type": "string", "description": "Idempotency key; repeating it returns the existing task." },
                    "title": { "type": "string", "description": "Short human-readable task title." },
                    "task": { "type": "string", "description": "Self-contained brief: goal, constraints, files, expected report." },
                    "role": { "type": "string", "enum": ["implementation", "research", "review", "test", "design", "general"] },
                    "target": {
                        "type": "object",
                        "properties": {
                            "instanceId": { "type": "string" },
                            "providerHint": { "type": "string" },
                            "model": { "type": "string" },
                            "mode": { "type": "string" },
                            "effort": { "type": "string" }
                        },
                        "additionalProperties": false
                    },
                    "isolation": { "type": "string", "enum": ["shared", "worktree"] },
                    "permissionMode": { "type": "string", "enum": ["supervised", "auto_edit", "auto", "full_access"] },
                    "timeoutSec": { "type": "integer", "minimum": 30, "maximum": 3600 }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "wait_tasks",
            "description": "Wait until a delegated task finishes, blocks on approval/input, or the timeout passes. Returns current task states; never dumps transcripts.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "taskIds": { "type": "array", "items": { "type": "string" } },
                    "mode": { "type": "string", "enum": ["all", "any"] },
                    "timeoutSec": { "type": "integer", "minimum": 1, "maximum": 240 }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "get_task",
            "description": "Read a compact slice of one delegated task: status, duration, active tool, pending request, changed files, branch, usage, error.",
            "inputSchema": {
                "type": "object",
                "required": ["taskId"],
                "properties": { "taskId": { "type": "string" } },
                "additionalProperties": false
            }
        },
        {
            "name": "list_tasks",
            "description": "List every task delegated from this parent thread.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        {
            "name": "cancel_task",
            "description": "Cancel a task and its subtree. Use force when a graceful stop is ignored.",
            "inputSchema": {
                "type": "object",
                "required": ["taskId"],
                "properties": {
                    "taskId": { "type": "string" },
                    "force": { "type": "boolean" }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "steer_task",
            "description": "Send a refinement to a running child, or start a follow-up turn in the same child thread when it already finished.",
            "inputSchema": {
                "type": "object",
                "required": ["taskId", "message"],
                "properties": {
                    "taskId": { "type": "string" },
                    "message": { "type": "string" },
                    "mode": {
                        "type": "string",
                        "enum": ["queue", "interrupt"],
                        "description": "'queue' (default) never cancels active work and delivers on the next turn; 'interrupt' cancels the current turn first."
                    },
                    "urgent": {
                        "type": "boolean",
                        "description": "Legacy alias for mode='interrupt'. Ignored if false."
                    }
                },
                "additionalProperties": false
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_cover_every_advertised_tool_once() {
        let specs = tool_specs();
        let specs = specs.as_array().expect("tool specs array");
        assert_eq!(specs.len(), ORCHESTRATOR_TOOL_NAMES.len());
        for name in ORCHESTRATOR_TOOL_NAMES {
            let matches = specs.iter().filter(|spec| spec["name"] == name).count();
            assert_eq!(matches, 1, "{name} must be advertised exactly once");
        }
    }

    #[test]
    fn read_only_tools_need_no_active_run() {
        for name in ["orchestrator_capabilities", "get_task", "list_tasks"] {
            assert!(is_read_only_tool(name), "{name} is read-only");
        }
        for name in ["delegate_task", "wait_tasks", "cancel_task", "steer_task"] {
            assert!(!is_read_only_tool(name), "{name} mutates or waits");
        }
    }
}
