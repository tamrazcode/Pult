//! Permission modes (§5.5): pult resolves `session/request_permission`
//! locally when the active mode allows it, before surfacing to the UI.
//! `supervised` always asks; the auto modes resolve by tool kind and file
//! location; `full_access` allows everything. Every auto resolution is
//! traced (never silent) and "allow_always" decisions are remembered per
//! (instance, tool class).

use serde::{Deserialize, Serialize};

/// The four permission modes (settings key `permission_mode`, §5.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    Supervised,
    AutoEdit,
    Auto,
    FullAccess,
}

impl PermissionMode {
    /// Settings default when nothing is stored.
    pub fn default_mode() -> Self {
        Self::Supervised
    }

    pub fn from_settings_value(value: &serde_json::Value) -> Option<Self> {
        serde_json::from_value(value.clone()).ok()
    }

    /// Capability rank: a child may never exceed its parent's mode.
    pub fn rank(self) -> u8 {
        match self {
            Self::Supervised => 0,
            Self::AutoEdit => 1,
            Self::Auto => 2,
            Self::FullAccess => 3,
        }
    }

    pub fn min(self, other: Self) -> Self {
        if self.rank() <= other.rank() {
            self
        } else {
            other
        }
    }
}

/// What the policy decided for one permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyDecision {
    /// Resolve without the UI; the value is the ACP option id to send.
    AutoResolve(String),
    /// Surface to the user (supervised, or the auto modes are out of scope).
    Ask,
}

/// One ACP `PermissionOption` as pult sees it (already normalized upstream).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyOption {
    pub option_id: String,
    /// ACP kind: allow_once | allow_always | reject_once | reject_always.
    pub kind: String,
}

/// Inputs the policy reads from the permission request (§5.5).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicyRequest<'a> {
    /// ACP `ToolKind` of the pending tool call ("edit", "delete", …).
    pub tool_kind: &'a str,
    /// Absolute paths the tool call touches (locations); empty when unknown.
    pub paths: &'a [String],
    /// The agent's offered options, in offer order.
    pub options: &'a [PolicyOption],
    /// Decisions remembered for this (instance, tool class), optionId keyed
    /// by tool class. `Some(id)` auto-resolves when a matching option exists.
    pub remembered: Option<&'a str>,
}

impl<'a> PolicyRequest<'a> {
    /// Any path outside the caller's workspace root?
    fn escapes_workspace(&self, root: &std::path::Path) -> bool {
        self.paths.iter().any(|p| !in_workspace(root, p))
    }

    fn find_kind(&self, prefix: &str) -> Option<&'a PolicyOption> {
        self.options.iter().find(|o| o.kind == prefix)
    }

    fn find_kind_starts_with(&self, prefix: &str) -> Option<&'a PolicyOption> {
        self.options.iter().find(|o| o.kind.starts_with(prefix))
    }
}

/// A path is "within the workspace" when it is inside `root` (or relative).
/// Absolute POSIX paths from agents whose cwd IS the workspace count as
/// inside (they are remapped by the fs sandbox, §5.5); `..` anywhere in such
/// a path means an escape attempt.
fn in_workspace(root: &std::path::Path, path: &str) -> bool {
    use std::path::Component;
    let candidate = std::path::Path::new(path);
    // Dispatch on the FIRST component. On Windows a rootless POSIX path
    // (/repo/..) reports is_relative()==true while still meaning an
    // absolute-from-cwd path for the agent, so the RootDir case must be
    // handled before any is_relative shortcut.
    match candidate.components().next() {
        // Drive/UNC-qualified: containment against the real root. Canonicalize
        // both sides so `\\?\` verbatim prefixes do not fail the comparison.
        Some(Component::Prefix(_)) => match (candidate.canonicalize(), root.canonicalize()) {
            (Ok(real), Ok(base)) => real.starts_with(base),
            // Unresolvable absolute path: conservatively outside.
            _ => false,
        },
        // POSIX-rootless (/repo/...): the sandbox maps it under the
        // workspace; any ParentDir component is an escape attempt.
        Some(Component::RootDir) => {
            let mut comps = candidate.components().skip(1);
            !comps.any(|c| c == Component::ParentDir)
        }
        // Relative: joined with the root by the sandbox, so `..` is an escape.
        _ => !candidate.components().any(|c| c == Component::ParentDir),
    }
}

/// Resolve a permission request under the active mode (§5.5). Remembered
/// decisions (allow_always) auto-resolve only outside `supervised`, while
/// the request stays inside the workspace, and while the remembered option
/// is still offered with an allow kind.
pub fn resolve(
    mode: PermissionMode,
    root: &std::path::Path,
    request: &PolicyRequest<'_>,
) -> PolicyDecision {
    // A remembered allow_always short-circuits the mode scope only when the
    // mode is not supervised, nothing escapes the workspace, and the option
    // still maps to an allow kind (never a reused reject id).
    if mode != PermissionMode::Supervised && !request.escapes_workspace(root) {
        if let Some(option_id) = request.remembered {
            if request
                .options
                .iter()
                .any(|o| o.option_id == option_id && o.kind.starts_with("allow"))
            {
                return PolicyDecision::AutoResolve(option_id.to_string());
            }
        }
    }
    match mode {
        PermissionMode::Supervised => PolicyDecision::Ask,
        PermissionMode::AutoEdit => {
            if request.tool_kind == "edit" && !request.escapes_workspace(root) {
                auto_allow(request)
            } else {
                PolicyDecision::Ask
            }
        }
        PermissionMode::Auto => {
            if request.tool_kind == "delete" || request.escapes_workspace(root) {
                PolicyDecision::Ask
            } else {
                auto_allow(request)
            }
        }
        PermissionMode::FullAccess => auto_allow(request),
    }
}

/// Pick the allow option: allow_once if offered, else the first allow-*.
fn auto_allow(request: &PolicyRequest<'_>) -> PolicyDecision {
    if let Some(option) = request.find_kind("allow_once") {
        return PolicyDecision::AutoResolve(option.option_id.clone());
    }
    if let Some(option) = request.find_kind_starts_with("allow") {
        return PolicyDecision::AutoResolve(option.option_id.clone());
    }
    // No allow option offered: the agent insists on asking.
    PolicyDecision::Ask
}

/// Should this decision be remembered after the user picks it?
pub fn is_rememberable(kind: &str) -> bool {
    kind == "allow_always"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> std::path::PathBuf {
        std::env::temp_dir().join("pult-m3-policy")
    }

    fn opts() -> Vec<PolicyOption> {
        vec![
            PolicyOption {
                option_id: "allow".into(),
                kind: "allow_once".into(),
            },
            PolicyOption {
                option_id: "always".into(),
                kind: "allow_always".into(),
            },
            PolicyOption {
                option_id: "reject".into(),
                kind: "reject_once".into(),
            },
        ]
    }

    fn req<'a>(
        kind: &'a str,
        paths: &'a [String],
        options: &'a [PolicyOption],
        remembered: Option<&'a str>,
    ) -> PolicyRequest<'a> {
        PolicyRequest {
            tool_kind: kind,
            paths,
            options,
            remembered,
        }
    }

    #[test]
    fn supervised_always_asks_but_remembers_short_circuit() {
        let paths = vec!["/repo/src/main.rs".to_string()];
        let options = opts();
        let r = req("edit", &paths, &options, None);
        assert_eq!(
            resolve(PermissionMode::Supervised, &root(), &r),
            PolicyDecision::Ask
        );

        // Supervised ALWAYS asks even with a remembered allow_always.
        let r2 = req("edit", &paths, &options, Some("always"));
        assert_eq!(
            resolve(PermissionMode::Supervised, &root(), &r2),
            PolicyDecision::Ask
        );

        // Remembered allow_always short-circuits outside Supervised inside the workspace
        // when the remembered option id still maps to an allow* kind.
        let r_auto_del = req("delete", &paths, &options, Some("always"));
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &r_auto_del),
            PolicyDecision::AutoResolve("always".into())
        );

        // Remembered option id that now maps to a reject* kind must not auto-resolve.
        let reject_now = vec![PolicyOption {
            option_id: "always".into(),
            kind: "reject_once".into(),
        }];
        let r_reject = req("edit", &paths, &reject_now, Some("always"));
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &r_reject),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn auto_edit_allows_edit_kind_inside_workspace_only() {
        let inside = vec!["/repo/src/main.rs".to_string()];
        let options = opts();
        let r = req("edit", &inside, &options, None);
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r),
            PolicyDecision::AutoResolve("allow".into())
        );
        // different tool kind → ask
        let r2 = req("execute", &inside, &options, None);
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r2),
            PolicyDecision::Ask
        );
        // drive-qualified path outside the workspace → ask
        let outside = vec!["C:\\Windows\\system32\\config.sys".to_string()];
        let r3 = req("edit", &outside, &options, None);
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r3),
            PolicyDecision::Ask
        );
        // ../ escape inside the path → ask
        let sneaky = vec!["/repo/../../etc/passwd".to_string()];
        let r4 = req("edit", &sneaky, &options, None);
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r4),
            PolicyDecision::Ask
        );
        // relative ../ escape (the agent edits it outside the fs sandbox) → ask
        let relative = vec!["..\\..\\Windows\\System32\\drivers\\etc\\hosts".to_string()];
        let r5 = req("edit", &relative, &options, None);
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r5),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn auto_mode_allows_non_destructive_and_asks_for_delete() {
        let paths = vec!["/repo/src/main.rs".to_string()];
        let options = opts();
        let read = req("read", &paths, &options, None);
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &read),
            PolicyDecision::AutoResolve("allow".into())
        );
        let del = req("delete", &paths, &options, None);
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &del),
            PolicyDecision::Ask
        );
        let outside = vec!["C:\\Windows\\temp\\x.txt".to_string()];
        let write_outside = req("edit", &outside, &options, None);
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &write_outside),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn full_access_allows_everything_but_never_silently() {
        let paths = vec!["C:\\anywhere\\file.txt".to_string()];
        let options = opts();
        let r = req("delete", &paths, &options, None);
        assert_eq!(
            resolve(PermissionMode::FullAccess, &root(), &r),
            PolicyDecision::AutoResolve("allow".into())
        );
    }

    #[test]
    fn no_allow_option_falls_back_to_asking() {
        let reject_only = vec![PolicyOption {
            option_id: "reject".into(),
            kind: "reject_once".into(),
        }];
        let paths = vec!["/repo/src/main.rs".to_string()];
        let r = req("edit", &paths, &reject_only, None);
        assert_eq!(
            resolve(PermissionMode::FullAccess, &root(), &r),
            PolicyDecision::Ask
        );
    }

    #[test]
    fn allow_always_kind_is_rememberable() {
        assert!(is_rememberable("allow_always"));
        assert!(!is_rememberable("allow_once"));
    }

    #[test]
    fn min_never_escalates_a_child_above_its_parent() {
        use PermissionMode::*;
        assert_eq!(Supervised.min(FullAccess), Supervised);
        assert_eq!(FullAccess.min(Supervised), Supervised);
        assert_eq!(AutoEdit.min(Auto), AutoEdit);
        assert_eq!(Auto.min(AutoEdit), AutoEdit);
        assert_eq!(FullAccess.min(FullAccess), FullAccess);
        assert!(Supervised.rank() < AutoEdit.rank());
        assert!(AutoEdit.rank() < Auto.rank());
        assert!(Auto.rank() < FullAccess.rank());
    }

    #[test]
    fn mode_parses_from_settings_value() {
        assert_eq!(
            PermissionMode::from_settings_value(&serde_json::json!("auto_edit")),
            Some(PermissionMode::AutoEdit)
        );
        assert_eq!(
            PermissionMode::from_settings_value(&serde_json::json!("nope")),
            None
        );
        assert_eq!(PermissionMode::default_mode(), PermissionMode::Supervised);
    }

    #[test]
    fn remembered_never_overrides_supervised_or_workspace_escape_or_reject_kind() {
        let inside = vec!["/repo/src/main.rs".to_string()];
        let outside = vec!["/repo/../../etc/passwd".to_string()];
        let options = opts();

        // (a) Supervised always asks even with remembered allow_always.
        let r_supervised = req("edit", &inside, &options, Some("always"));
        assert_eq!(
            resolve(PermissionMode::Supervised, &root(), &r_supervised),
            PolicyDecision::Ask
        );

        // (b) AutoEdit with workspace escape asks even with remembered allow_always.
        let r_escape = req("edit", &outside, &options, Some("always"));
        assert_eq!(
            resolve(PermissionMode::AutoEdit, &root(), &r_escape),
            PolicyDecision::Ask
        );

        // (c) Auto with remembered option whose current kind starts with "reject" must not auto-resolve to it.
        let reject_only = vec![PolicyOption {
            option_id: "opt-1".into(),
            kind: "reject_once".into(),
        }];
        let r_reject_only = req("edit", &inside, &reject_only, Some("opt-1"));
        assert_eq!(
            resolve(PermissionMode::Auto, &root(), &r_reject_only),
            PolicyDecision::Ask
        );

        let mixed = vec![
            PolicyOption {
                option_id: "opt-1".into(),
                kind: "reject_always".into(),
            },
            PolicyOption {
                option_id: "opt-allow".into(),
                kind: "allow_once".into(),
            },
        ];
        let r_mixed = req("edit", &inside, &mixed, Some("opt-1"));
        assert_ne!(
            resolve(PermissionMode::Auto, &root(), &r_mixed),
            PolicyDecision::AutoResolve("opt-1".into())
        );
    }
}
