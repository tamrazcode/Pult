//! MCP tool surface advertised to every ACP session. The schemas are the
//! contract the engine (T05) implements; keeping them in one place means
//! `tools/list` and argument validation never drift apart.

use serde_json::{json, Value};

pub const ORCHESTRATOR_TOOL_NAMES: [&str; 10] = [
    "orchestrator_capabilities",
    "delegate_task",
    "wait_tasks",
    "get_task",
    "list_tasks",
    "cancel_task",
    "steer_task",
    "run_background",
    "background_status",
    "cancel_background",
];

/// Tools that read only orchestration state and therefore work even when the
/// parent turn has already finished.
pub fn is_read_only_tool(name: &str) -> bool {
    matches!(
        name,
        "orchestrator_capabilities" | "get_task" | "list_tasks" | "background_status"
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
                            "providerHint": { "type": "string", "description": "Provider id, display name, or driver to use when instanceId is omitted; the child errors if no provider or several providers match." },
                            "model": { "type": "string" },
                            "mode": { "type": "string", "description": "Session mode id for the child thread (see modes in orchestrator_capabilities)." },
                            "effort": { "type": "string", "description": "Reasoning effort value for the child thread; mapped to the provider's effort config option." }
                        },
                        "additionalProperties": false
                    },
                    "isolation": { "type": "string", "enum": ["shared", "worktree"] },
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
        },
        {
            "name": "run_background",
            "description": "Start a shell command in the background and return immediately with its jobId. Use this for long builds, tests, or checks, then end your turn; Pult wakes this thread with the exit status and output tail when it finishes or times out. Requires FullAccess permission mode.",
            "inputSchema": {
                "type": "object",
                "required": ["cmd"],
                "properties": {
                    "cmd": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 16384,
                        "description": "Shell command string executed via cmd /d /s /c (Windows) or sh -c (Unix)."
                    },
                    "cwd": {
                        "type": "string",
                        "description": "Working directory inside the thread workspace. Defaults to the thread workspace."
                    },
                    "label": {
                        "type": "string",
                        "maxLength": 120,
                        "description": "Short human-readable label for status and wake notifications."
                    },
                    "timeoutSec": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 3600,
                        "description": "Hard timeout in seconds (default 1800, max 3600)."
                    }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "background_status",
            "description": "Read status and the capped output tail for background commands owned by this thread. Omit jobId to list every tracked job for this thread.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "jobId": { "type": "string", "description": "Background job id. If omitted, lists the thread's jobs." },
                    "includeOutput": { "type": "boolean", "description": "Include outputTail (defaults to true with jobId, false when listing)." }
                },
                "additionalProperties": false
            }
        },
        {
            "name": "cancel_background",
            "description": "Kill a running background command owned by this thread and its process tree. Cancelled jobs do not wake the thread.",
            "inputSchema": {
                "type": "object",
                "required": ["jobId"],
                "properties": { "jobId": { "type": "string" } },
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
        for name in [
            "orchestrator_capabilities",
            "get_task",
            "list_tasks",
            "background_status",
        ] {
            assert!(is_read_only_tool(name), "{name} is read-only");
        }
        for name in [
            "delegate_task",
            "wait_tasks",
            "cancel_task",
            "steer_task",
            "run_background",
            "cancel_background",
        ] {
            assert!(!is_read_only_tool(name), "{name} mutates or waits");
        }
    }
}
