//! Workspace file listing for composer `@` mentions. Paths are relative to
//! the workspace root and always joined from directory-entry names, never
//! from user input, so a result can't escape the root.

use std::collections::VecDeque;
use std::path::Path;

use crate::PultError;

/// Directories that never belong in a mention list (VCS, build output, pult).
const IGNORED_DIRS: [&str; 11] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "test-results",
    ".pult",
    ".vite",
    "coverage",
    "build",
    ".next",
    "vendor",
];

/// Upper bound on directory entries visited per query.
const MAX_VISITED: usize = 3000;

/// Upper bound on returned paths (the menu shows a truncated tail anyway).
pub const MAX_RESULTS: usize = 200;

/// Lists workspace files whose relative path contains `query` (case-insensitive).
pub fn list_workspace_files(
    root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<String>, PultError> {
    if !root.is_dir() {
        return Err(PultError::internal(format!(
            "workspace {} not found",
            root.display()
        )));
    }
    let needle = query.trim().to_lowercase();
    let limit = limit.clamp(1, MAX_RESULTS);
    let mut out: Vec<String> = Vec::new();
    // Breadth-first: the top levels (src/, docs/) must not lose the visit
    // budget to one deep subtree on a big repo.
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut visited = 0usize;

    'walk: while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if visited >= MAX_VISITED {
                break 'walk;
            }
            visited += 1;
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                let name = entry.file_name();
                if IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
                    continue;
                }
                queue.push_back(entry.path());
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let rel = entry
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            if !needle.is_empty() && !rel.to_lowercase().contains(&needle) {
                continue;
            }
            out.push(rel);
            if out.len() >= limit {
                break 'walk;
            }
        }
    }

    out.sort();
    out.truncate(limit);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pult-workspace-{}-{}-{name}",
            std::process::id(),
            crate::events::now_millis()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_relative_paths_and_skips_ignored_dirs() {
        let root = temp_root("listing");
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/a.js"), "x").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join("target/debug/bin"), "x").unwrap();

        let files = list_workspace_files(&root, "", MAX_RESULTS).unwrap();
        assert_eq!(files, vec!["src/main.rs".to_string()]);

        let filtered = list_workspace_files(&root, "MAIN", MAX_RESULTS).unwrap();
        assert_eq!(filtered, vec!["src/main.rs".to_string()]);
        assert!(list_workspace_files(&root, "nothing-here", MAX_RESULTS)
            .unwrap()
            .is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_a_missing_root_and_respects_the_limit() {
        let missing = std::env::temp_dir().join("pult-workspace-missing-xyz");
        assert!(list_workspace_files(&missing, "", MAX_RESULTS).is_err());

        let root = temp_root("limit");
        for i in 0..5 {
            std::fs::write(root.join(format!("f{i}.txt")), "x").unwrap();
        }
        let files = list_workspace_files(&root, "", 2).unwrap();
        assert_eq!(files.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }
}
