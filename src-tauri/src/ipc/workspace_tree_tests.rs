use super::{has_visible_content_with_budget, walk_workspace, walk_workspace_with_limits};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_workspace(name: &str) -> PathBuf {
    let unique = format!(
        "pult-tree-{}-{}-{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_file(path: &Path) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, "x").unwrap();
}

#[test]
fn truncates_at_entry_cap_and_marks_truncated() {
    let dir = temp_workspace("cap");
    for index in 0..3 {
        write_file(&dir.join(format!("f{index}.txt")));
    }
    let tree = walk_workspace_with_limits(&dir, 3, 6).unwrap();
    assert_eq!(tree.entries.len(), 3);
    assert!(!tree.truncated);

    write_file(&dir.join("f3.txt"));
    write_file(&dir.join("node_modules/ignored.js"));
    let tree = walk_workspace_with_limits(&dir, 3, 6).unwrap();
    assert_eq!(tree.entries.len(), 3);
    assert!(tree.truncated);
    assert!(tree
        .entries
        .iter()
        .all(|entry| entry.name != "node_modules"));

    let wide = temp_workspace("wide");
    for index in 0..2001 {
        write_file(&wide.join(format!("f{index}.txt")));
    }
    let tree = walk_workspace(&wide).unwrap();
    assert_eq!(tree.entries.len(), 2000);
    assert!(tree.truncated);

    fs::remove_dir_all(&dir).unwrap();
    fs::remove_dir_all(&wide).unwrap();
}

#[test]
fn truncates_at_depth_limit_and_skips_empty_or_ignored_subtrees() {
    let dir = temp_workspace("depth");
    fs::create_dir_all(dir.join("a/b/c/d/e/f/empty_at_6")).unwrap();
    write_file(&dir.join("a/b/c/d/e/f/node_modules/x.js"));
    let tree = walk_workspace(&dir).unwrap();
    assert!(!tree.truncated);

    write_file(&dir.join("a/b/c/d/e/f/deep.txt"));
    let tree = walk_workspace(&dir).unwrap();
    assert!(tree.truncated);
    assert!(tree
        .entries
        .iter()
        .all(|entry| !entry.path.ends_with("deep.txt")));

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn probe_budget_is_iterative_and_conservative() {
    let dir = temp_workspace("probe");
    write_file(&dir.join("a/b/c/d/e/f/only_ignored/node_modules/x.js"));
    let a_b_c_d_e_f = dir.join("a/b/c/d/e/f");
    assert!(!has_visible_content_with_budget(&a_b_c_d_e_f, 50));

    write_file(&dir.join("a/b/c/d/e/f/tree/d0/d1/d2/d3/d4/d5/file.txt"));
    assert!(has_visible_content_with_budget(&a_b_c_d_e_f, 2));
    assert!(has_visible_content_with_budget(&a_b_c_d_e_f, 100));

    fs::remove_dir_all(&dir).unwrap();
}
