//! Git module tests against real `git` in throwaway repos.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;

static SEQ: AtomicU64 = AtomicU64::new(0);

/// Blocking git helper for fixture setup (tests only).
fn git_sync(dir: &Path, args: &[&str]) -> String {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .expect("git spawn");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

struct Fixture(PathBuf);

impl Fixture {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn fixture_root() -> Fixture {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("pult-git-test-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("mkdir fixture");
    Fixture(dir)
}

/// A committed repo: tracked.txt + sub/nested.txt.
async fn fixture_repo() -> Fixture {
    let fx = fixture_root();
    git_sync(fx.path(), &["init", "-q", "-b", "main"]);
    git_sync(fx.path(), &["config", "user.email", "t@t"]);
    git_sync(fx.path(), &["config", "user.name", "t"]);
    git_sync(fx.path(), &["config", "core.autocrlf", "false"]);
    std::fs::write(fx.path().join("tracked.txt"), "line1\nline2\nline3\n").unwrap();
    std::fs::create_dir_all(fx.path().join("sub")).unwrap();
    std::fs::write(fx.path().join("sub").join("nested.txt"), "alpha\nbeta\n").unwrap();
    git_sync(fx.path(), &["add", "."]);
    git_sync(fx.path(), &["commit", "-q", "-m", "base"]);
    fx
}

/// Manual byte-exact reference: scratch index + intent-to-add + git diff.
fn reference_diff(repo: &Path, extra: &[&str]) -> String {
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    let idx = repo.parent().unwrap().join(format!("ref-index-{n}"));
    let _ = std::fs::remove_file(&idx);
    std::fs::copy(repo.join(".git").join("index"), &idx).expect("copy reference index");
    run_with_index(repo, &["add", "-N", "."], Some(&idx));
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-renames"];
    args.extend_from_slice(extra);
    let out = run_with_index(repo, &args, Some(&idx));
    let _ = std::fs::remove_file(&idx);
    out
}

fn run_with_index(repo: &Path, args: &[&str], index: Option<&Path>) -> String {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(repo).env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(idx) = index {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    let out = cmd.output().expect("git spawn");
    assert!(
        out.status.success(),
        "reference git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

#[tokio::test]
async fn diff_byte_exact_tracked_only() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "line1\nCHANGED\nline3\n").unwrap();
    let ours = diff(fx.path(), None).await.unwrap();
    let expected = reference_diff(fx.path(), &["HEAD"]);
    assert_eq!(ours.raw, expected, "diff must match `git diff HEAD` byte-exact");
    assert_eq!(ours.base, "HEAD");
    assert_eq!(ours.files.len(), 1);
    assert_eq!(ours.files[0].path, "tracked.txt");
    assert_eq!(ours.files[0].added, 1);
    assert_eq!(ours.files[0].removed, 1);
    assert_eq!(ours.files[0].status, "modified");
}

#[tokio::test]
async fn diff_byte_exact_includes_untracked() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "line1\nline2\nCHANGED\n").unwrap();
    let deep = fx.path().join("notes");
    std::fs::create_dir_all(&deep).unwrap();
    std::fs::write(deep.join("new.txt"), "brand new\nsecond line\nthird\n").unwrap();
    let ours = diff(fx.path(), None).await.unwrap();
    let expected = reference_diff(fx.path(), &["HEAD"]);
    assert_eq!(ours.raw, expected, "diff must include untracked files byte-exact");
    assert_eq!(ours.files.len(), 2);
    let new_file = ours.files.iter().find(|f| f.path == "notes/new.txt").unwrap();
    assert_eq!(new_file.status, "added");
    assert_eq!(new_file.added, 3);
    assert!(new_file.raw.contains("new file mode 100644"));
}

#[tokio::test]
async fn diff_fresh_repo_without_commits() {
    let fx = fixture_root();
    git_sync(fx.path(), &["init", "-q", "-b", "main"]);
    git_sync(fx.path(), &["config", "user.email", "t@t"]);
    git_sync(fx.path(), &["config", "user.name", "t"]);
    std::fs::write(fx.path().join("only.txt"), "hello\n").unwrap();
    let ours = diff(fx.path(), None).await.unwrap();
    assert_eq!(ours.base, "worktree");
    assert_eq!(ours.files.len(), 1);
    assert_eq!(ours.files[0].path, "only.txt");
    assert_eq!(ours.files[0].status, "added");
}

#[tokio::test]
async fn diff_against_explicit_base() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "line1\nline2\nline3\nv2\n").unwrap();
    git_sync(fx.path(), &["add", "."]);
    git_sync(fx.path(), &["commit", "-q", "-m", "second"]);
    std::fs::write(fx.path().join("tracked.txt"), "v3\n").unwrap();
    let ours = diff(fx.path(), Some("HEAD~1")).await.unwrap();
    assert_eq!(ours.base, "HEAD~1");
    // vs HEAD~1: both the committed change and the new edit appear.
    assert!(ours.files.iter().any(|f| f.path == "tracked.txt"));
    assert!(ours.files[0].added >= 1);
}

#[tokio::test]
async fn diff_file_slices_concatenate_to_raw() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "one\n").unwrap();
    std::fs::write(fx.path().join("sub").join("nested.txt"), "ALPHA\n").unwrap();
    let ours = diff(fx.path(), None).await.unwrap();
    let joined: String = ours.files.iter().map(|f| f.raw.as_str()).collect();
    assert_eq!(joined, ours.raw);
}

#[tokio::test]
async fn status_parses_branch_and_entries() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "edited\n").unwrap();
    std::fs::write(fx.path().join("untracked.txt"), "u\n").unwrap();
    let st = status(fx.path()).await.unwrap();
    assert_eq!(st.branch.as_deref(), Some("main"));
    assert_eq!(st.ahead, 0);
    let tracked = st.entries.iter().find(|e| e.path == "tracked.txt").unwrap();
    assert_eq!(tracked.worktree_status, "M");
    assert!(st.entries.iter().any(|e| e.path == "untracked.txt"));
}

#[tokio::test]
async fn commit_roundtrip_then_nothing_to_commit() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "line1\nline2\nline3\nv2\n").unwrap();
    let outcome = commit(fx.path(), "feat: v2").await.unwrap();
    assert_eq!(outcome.sha.len(), 40);
    assert_eq!(outcome.files_committed, 1);
    let log = git_sync(fx.path(), &["log", "-1", "--pretty=%s"]);
    assert_eq!(log.trim(), "feat: v2");
    let err = commit(fx.path(), "empty").await.unwrap_err();
    assert_eq!(err_code(&err), "git.nothing_to_commit");
    let st = status(fx.path()).await.unwrap();
    assert!(st.entries.is_empty());
}

fn err_code(err: &PultError) -> String {
    match err {
        PultError::Git { code, .. } => code.clone(),
        other => format!("not-git: {other}"),
    }
}

#[tokio::test]
async fn push_to_bare_remote_and_upstream() {
    let fx = fixture_repo().await;
    let remote = fixture_root();
    git_sync(remote.path(), &["init", "-q", "--bare", "-b", "main"]);
    git_sync(
        fx.path(),
        &["remote", "add", "origin", remote.path().to_string_lossy().as_ref()],
    );
    std::fs::write(fx.path().join("tracked.txt"), "pushed\n").unwrap();
    let pushed = commit(fx.path(), "to push").await.unwrap();
    push(fx.path()).await.unwrap();
    let ls = git_sync(remote.path(), &["rev-parse", "main"]);
    assert_eq!(ls.trim(), pushed.sha);
    // Upstream is now set: a second push goes through the plain path.
    std::fs::write(fx.path().join("tracked.txt"), "pushed2\n").unwrap();
    commit(fx.path(), "second").await.unwrap();
    push(fx.path()).await.unwrap();
    let st = status(fx.path()).await.unwrap();
    assert_eq!(st.ahead, 0);
}

#[tokio::test]
async fn push_without_remote_is_typed_error() {
    let fx = fixture_repo().await;
    let err = push(fx.path()).await.unwrap_err();
    assert_eq!(err_code(&err), "git.no_remote");
}

#[tokio::test]
async fn worktree_create_remove_roundtrip() {
    let fx = fixture_repo().await;
    let wt = worktree_create(fx.path(), "Fix_Login!").await.unwrap();
    assert!(wt.branch.starts_with("pult/fix-login-"));
    let wt_path = PathBuf::from(&wt.path);
    assert!(wt_path.join(".git").exists());
    // `.pult/` is excluded from status in the parent repo.
    let exclude = std::fs::read_to_string(fx.path().join(".git").join("info").join("exclude"))
        .unwrap_or_default();
    assert!(exclude.lines().any(|l| l.trim() == ".pult/"));
    // Changes inside the worktree stay isolated.
    std::fs::write(wt_path.join("tracked.txt"), "worktree change\n").unwrap();
    let wt_diff = diff(&wt_path, None).await.unwrap();
    assert_eq!(wt_diff.files.len(), 1);
    let parent_diff = diff(fx.path(), None).await.unwrap();
    assert!(parent_diff.files.is_empty());
    // Removal cleans both the dir and the registration.
    let name = wt_path.file_name().unwrap().to_string_lossy().into_owned();
    worktree_remove(fx.path(), &name).await.unwrap();
    assert!(!wt_path.exists());
    let list = git_sync(fx.path(), &["worktree", "list", "--porcelain"]);
    assert!(!list.contains("worktrees/"));
}

#[tokio::test]
async fn checkpoint_ref_writes_commit() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "checkpointed\n").unwrap();
    let sha = checkpoint(fx.path(), "run-123").await.unwrap();
    assert_eq!(sha.len(), 40);
    let at_ref = git_sync(fx.path(), &["rev-parse", "refs/pult/checkpoints/run-123"]);
    assert_eq!(at_ref.trim(), sha);
    let msg = git_sync(fx.path(), &["log", "-1", "--pretty=%s", &sha]);
    assert_eq!(msg.trim(), "pult checkpoint run-123");
    // Real index untouched: the working change is still unstaged.
    let st = status(fx.path()).await.unwrap();
    let tracked = st.entries.iter().find(|e| e.path == "tracked.txt").unwrap();
    assert_eq!(tracked.index_status, " ");
    assert_eq!(tracked.worktree_status, "M");
}

#[tokio::test]
async fn pr_create_uses_pult_gh_override() {
    let fx = fixture_repo().await;
    // Mock gh script: responds to --version and pr create.
    let bin = fixture_root();
    let script = bin.path().join("pult-mock-gh.cmd");
    std::fs::write(
        &script,
        "@echo off\r\nif \"%1\"==\"--version\" (\r\n  echo gh version 2.0.0-mock\r\n  exit /b 0\r\n)\r\nif \"%1\"==\"pr\" (\r\n  echo Creating pull request for branch...\r\n  echo https://github.local/mock/repo/pull/42\r\n  exit /b 0\r\n)\r\necho unexpected: %*\r\nexit /b 1\r\n",
    )
    .unwrap();
    // Single-threaded env write; other tests only read PATH, never PULT_GH.
    std::env::set_var("PULT_GH", &script);
    assert!(gh_available().await);
    let pr = pr_create(fx.path(), "title", "body").await.unwrap();
    assert_eq!(pr.url, "https://github.local/mock/repo/pull/42");
    std::env::remove_var("PULT_GH");
}

#[tokio::test]
async fn non_repo_directory_is_typed_error() {
    let fx = fixture_root();
    let err = status(fx.path()).await.unwrap_err();
    assert_eq!(err_code(&err), "git.not_a_repo");
}

#[tokio::test]
async fn slugify_strips_unusable_names() {
    assert_eq!(super::slugify("Fix Login!!"), "fix-login");
    assert_eq!(super::slugify("###"), "");
    assert_eq!(super::slugify("уже-было"), "");
}

#[tokio::test]
async fn diff_summary_matches_diff_counts_and_changes_patch_hash_on_edit() {
    use std::collections::HashMap;

    let fx = fixture_repo().await;
    // Stage one edit, leave one unstaged edit, and add one untracked file.
    std::fs::write(fx.path().join("tracked.txt"), "line1\nSTAGED\nline3\n").unwrap();
    git_sync(fx.path(), &["add", "tracked.txt"]);
    std::fs::write(fx.path().join("sub").join("nested.txt"), "alpha\nUNSTAGED\n").unwrap();
    std::fs::write(fx.path().join("untracked.txt"), "u1\nu2\n").unwrap();

    let full = diff(fx.path(), None).await.unwrap();
    let summary: GitDiffSummary = diff_summary(fx.path(), None).await.unwrap();

    assert_eq!(summary.repo_root, full.repo_root);
    assert_eq!(summary.base, full.base);
    assert_eq!(summary.files.len(), full.files.len());

    let expected_added: u64 = full.files.iter().map(|f| f.added).sum();
    let expected_removed: u64 = full.files.iter().map(|f| f.removed).sum();
    assert_eq!(summary.total_added, expected_added);
    assert_eq!(summary.total_removed, expected_removed);

    let mut hashes: HashMap<String, String> = HashMap::new();
    for f in &full.files {
        let s: &DiffFileSummary = summary
            .files
            .iter()
            .find(|sf| sf.path == f.path)
            .expect("summary missing file from diff()");
        assert_eq!(s.old_path, f.old_path);
        assert_eq!(s.added, f.added);
        assert_eq!(s.removed, f.removed);
        assert_eq!(s.binary, f.binary);
        assert_eq!(s.status, f.status);
        assert!(!s.patch_hash.is_empty(), "patch_hash must be populated");
        hashes.insert(s.path.clone(), s.patch_hash.clone());
    }

    // Same-byte-length edit to tracked.txt ("STAGED" -> "STAGE2").
    std::fs::write(fx.path().join("tracked.txt"), "line1\nSTAGE2\nline3\n").unwrap();
    let summary2 = diff_summary(fx.path(), None).await.unwrap();
    assert_eq!(summary2.files.len(), 3);

    for s in &summary2.files {
        let prev = hashes.get(&s.path).expect("unexpected path after edit");
        if s.path == "tracked.txt" {
            assert_ne!(&s.patch_hash, prev, "patch_hash must change on same-size edit");
        } else {
            assert_eq!(&s.patch_hash, prev, "untouched file patch_hash must not change");
        }
    }
}

#[tokio::test]
async fn diff_summary_works_on_no_head_repo() {
    let fx = fixture_root();
    git_sync(fx.path(), &["init", "-q", "-b", "main"]);
    git_sync(fx.path(), &["config", "user.email", "t@t"]);
    git_sync(fx.path(), &["config", "user.name", "t"]);
    git_sync(fx.path(), &["config", "core.autocrlf", "false"]);

    std::fs::write(fx.path().join("staged.txt"), "one\ntwo\n").unwrap();
    git_sync(fx.path(), &["add", "staged.txt"]);
    std::fs::write(fx.path().join("untracked.txt"), "three\n").unwrap();

    let summary = diff_summary(fx.path(), None).await.unwrap();
    assert_eq!(summary.base, "worktree");
    assert_eq!(summary.files.len(), 2);
    assert_eq!(summary.total_added, 3);
    assert_eq!(summary.total_removed, 0);

    let staged = summary.files.iter().find(|f| f.path == "staged.txt").unwrap();
    assert_eq!(staged.added, 2);
    assert_eq!(staged.removed, 0);
    assert_eq!(staged.status, "added");
    assert!(!staged.patch_hash.is_empty());

    let untracked = summary.files.iter().find(|f| f.path == "untracked.txt").unwrap();
    assert_eq!(untracked.added, 1);
    assert_eq!(untracked.removed, 0);
    assert_eq!(untracked.status, "added");
    assert!(!untracked.patch_hash.is_empty());
}

#[tokio::test]
async fn diff_file_matches_full_diff_slice_byte_exact() {
    let fx = fixture_repo().await;
    std::fs::write(fx.path().join("tracked.txt"), "line1\nCHANGED\nline3\n").unwrap();
    let notes = fx.path().join("notes");
    std::fs::create_dir_all(&notes).unwrap();
    std::fs::write(notes.join("new.txt"), "brand new\nsecond line\nthird\n").unwrap();

    let full = diff(fx.path(), None).await.unwrap();
    for path in ["tracked.txt", "notes/new.txt"] {
        let one = diff_file(fx.path(), path, None).await.unwrap();
        let expected = full.files.iter().find(|f| f.path == path).unwrap();
        assert_eq!(one.raw, expected.raw);
        assert_eq!(one.added, expected.added);
        assert_eq!(one.removed, expected.removed);
        assert_eq!(one.status, expected.status);
    }
}

#[tokio::test]
async fn diff_file_rejects_absolute_parent_and_outside_paths() {
    let fx = fixture_repo().await;
    for bad_path in [
        "/etc/passwd",
        "C:\\Windows\\win.ini",
        "../outside.txt",
        "sub/../../outside.txt",
        "bad\0path",
    ] {
        let err = diff_file(fx.path(), bad_path, None).await.unwrap_err();
        assert_eq!(
            err_code(&err),
            "git.invalid_path",
            "expected git.invalid_path for {bad_path:?}"
        );
    }

    let err = diff_file(fx.path(), "tracked.txt", Some("--ext-diff"))
        .await
        .unwrap_err();
    assert_eq!(err_code(&err), "git.invalid_base");
}

/// `git diff` must not accept option-shaped refs: `--output=…` would let the
/// caller write the diff anywhere on disk.
#[tokio::test]
async fn diff_rejects_option_like_base() {
    let fx = fixture_repo().await;
    let err = diff(fx.path(), Some("--output=pwned.txt")).await.unwrap_err();
    assert_eq!(err_code(&err), "git.invalid_base");
    assert!(!fx.path().join("pwned.txt").exists());
}

#[tokio::test]
async fn diff_file_rejects_symlink_escape_when_supported() {
    let fx = fixture_repo().await;
    let outside = fixture_root();
    let outside_file = outside.path().join("secret.txt");
    std::fs::write(&outside_file, "secret\n").unwrap();
    let link_path = fx.path().join("escape.txt");

    #[cfg(unix)]
    let link_res = std::os::unix::fs::symlink(&outside_file, &link_path);
    #[cfg(windows)]
    let link_res = std::os::windows::fs::symlink_file(&outside_file, &link_path);

    if link_res.is_err() {
        return;
    }

    let err = diff_file(fx.path(), "escape.txt", None).await.unwrap_err();
    assert_eq!(err_code(&err), "git.invalid_path");
}

#[tokio::test]
async fn diff_parses_unquoted_empty_file_path_with_spaces() {
    let fx = fixture_repo().await;
    std::fs::create_dir_all(fx.path().join("space dir")).unwrap();
    std::fs::write(fx.path().join("space dir").join("empty file.txt"), "").unwrap();

    let full = diff(fx.path(), None).await.unwrap();
    let file = full
        .files
        .iter()
        .find(|file| file.path == "space dir/empty file.txt")
        .expect("empty spaced file must keep its path from the diff header");
    assert_eq!(file.status, "added");
    assert_eq!(file.added, 0);
    assert_eq!(file.removed, 0);
}

#[tokio::test]
async fn diff_file_handles_spaces_and_unicode_paths() {
    let fx = fixture_repo().await;
    let rel = "dir with spaces/café résumé.txt";
    let dir = fx.path().join("dir with spaces");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("café résumé.txt"), "bonjour\nmonde\n").unwrap();

    let full = diff(fx.path(), None).await.unwrap();
    assert_eq!(full.files.len(), 1);

    let summary = diff_summary(fx.path(), None).await.unwrap();
    let sf = summary
        .files
        .iter()
        .find(|f| f.path == rel)
        .expect("summary must return unquoted spaces/unicode path");
    assert_eq!(sf.added, 2);
    assert_eq!(sf.removed, 0);
    assert_eq!(sf.status, "added");

    let one = diff_file(fx.path(), rel, None).await.unwrap();
    assert_eq!(one.path, rel);
    assert_eq!(one.raw, full.files[0].raw);
}

