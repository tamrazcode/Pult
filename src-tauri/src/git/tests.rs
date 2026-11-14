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
