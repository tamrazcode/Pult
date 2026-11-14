//! Git integration (§4.4): shells out to real `git` — never the git2 crate.
//! All paths are absolute; every operation resolves the repo toplevel first.
//!
//! The diff projection uses a throwaway index: copy the real index into a
//! temp file, mark untracked files intent-to-add, then `git diff` (or
//! `git diff HEAD`). The user's real index is never mutated, yet the output
//! is byte-exact `git diff` output including untracked files.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::events::now_millis;
use crate::PultError;

/// Temp-index counter so concurrent diffs never share a scratch file.
static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    /// Rename/copy source when applicable.
    pub orig_path: Option<String>,
    /// Porcelain index status (X): ' ' staged-clean, M/A/D/R/C/U/?/!.
    pub index_status: String,
    /// Porcelain worktree status (Y).
    pub worktree_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: i64,
    pub behind: i64,
    pub entries: Vec<StatusEntry>,
}

/// One `diff --git` section, split verbatim out of the raw diff text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    /// Exact substring of the raw diff for this file (byte-exact rendering).
    pub raw: String,
    pub added: u64,
    pub removed: u64,
    pub binary: bool,
    /// added | deleted | renamed | modified.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub repo_root: String,
    /// The ref the diff was taken against ("HEAD" or an explicit base).
    pub base: String,
    /// Full raw `git diff` output (byte-exact acceptance target).
    pub raw: String,
    pub files: Vec<DiffFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub sha: String,
    pub files_committed: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub output: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrOutcome {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOutcome {
    pub path: String,
    pub branch: String,
}

pub fn git_err(code: &str, message: impl Into<String>) -> PultError {
    PultError::Git {
        code: code.to_string(),
        message: message.into(),
    }
}


/// Windows: git/gh are console apps — without this flag every call pops a
/// console window on top of the user's screen (GUI parent, no console).
#[cfg(windows)]
fn hide_console(cmd: &mut tokio::process::Command) {
    cmd.creation_flags(0x0800_0000);
}
#[cfg(not(windows))]
fn hide_console(_cmd: &mut tokio::process::Command) {}

fn internal(message: impl Into<String>) -> PultError {
    PultError::internal(message)
}

/// `git commit` reports "nothing to commit" on *stdout*, so both streams are
/// folded into the failure detail.
async fn run_commit(repo: &Path, message: &str) -> Result<String, PultError> {
    let mut cmd = tokio::process::Command::new("git");
    hide_console(&mut cmd);
    cmd.args(["commit", "-m", message])
        .current_dir(repo)
        .env("GIT_OPTIONAL_LOCKS", "0");
    let out = cmd
        .output()
        .await
        .map_err(|e| internal(format!("git spawn failed: {e}")))?;
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(internal(format!("git commit failed: {}", combined.trim())));
    }
    Ok(combined)
}

/// Runs `git` with `args` in `dir`; returns stdout. `index_file` sets
/// `GIT_INDEX_FILE` for scratch-index operations.
async fn git_run(
    dir: &Path,
    args: &[std::ffi::OsString],
    index_file: Option<&Path>,
) -> Result<String, PultError> {
    let mut cmd = tokio::process::Command::new("git");
    hide_console(&mut cmd);
    cmd.args(args).current_dir(dir).env("GIT_OPTIONAL_LOCKS", "0");
    if let Some(idx) = index_file {
        cmd.env("GIT_INDEX_FILE", idx);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| internal(format!("git spawn failed: {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let first = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        return Err(internal(format!("git {first} failed: {stderr}")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

async fn git(dir: &Path, args: &[&str], index_file: Option<&Path>) -> Result<String, PultError> {
    let owned: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
    git_run(dir, &owned, index_file).await
}

/// True when `dir` sits inside a git work tree.
pub async fn is_repo(dir: &Path) -> bool {
    resolve_repo(dir).await.is_ok()
}

/// Resolves the repo toplevel containing `dir` (absolute paths only, §4.4).
pub async fn resolve_repo(dir: &Path) -> Result<PathBuf, PultError> {
    let dir = dir
        .canonicalize()
        .map_err(|e| git_err("git.not_a_repo", format!("{}: {e}", dir.display())))?;
    let raw = git(&dir, &["rev-parse", "--show-toplevel"], None)
        .await
        .map_err(|_| {
            git_err(
                "git.not_a_repo",
                format!("{} is not inside a git repository", dir.display()),
            )
        })?;
    let top = PathBuf::from(raw.trim());
    if !top.is_absolute() {
        // MSYS/git rarely returns relative here, but guard anyway.
        return Ok(dir.canonicalize().unwrap_or(dir));
    }
    Ok(top)
}

/// Scratch index: copy of the real index, or an empty one when the repo has
/// no index yet (fresh `git init` with nothing staged).
async fn temp_index_for(repo: &Path) -> Result<(PathBuf, bool), PultError> {
    let git_dir_raw = git(repo, &["rev-parse", "--absolute-git-dir"], None).await?;
    let git_dir = PathBuf::from(git_dir_raw.trim());
    let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let temp = std::env::temp_dir().join(format!(
        "pult-index-{}-{}-{seq}",
        std::process::id(),
        now_millis()
    ));
    let real = git_dir.join("index");
    let copied = real.exists();
    if copied {
        tokio::fs::copy(&real, &temp)
            .await
            .map_err(|e| internal(format!("copy scratch index: {e}")))?;
    } else {
        let owned: Vec<std::ffi::OsString> = ["read-tree", "--empty"].iter().map(Into::into).collect();
        git_run(repo, &owned, Some(&temp)).await?;
    }
    Ok((temp, copied))
}

async fn drop_temp_index(temp: &Path) {
    let _ = tokio::fs::remove_file(temp).await;
}

/// Worktree-vs-HEAD diff rendered by git itself through a scratch index, so
/// untracked files appear and the bytes match `git diff` exactly.
pub async fn diff(dir: &Path, base: Option<&str>) -> Result<GitDiff, PultError> {
    let repo = resolve_repo(dir).await?;
    let (temp, _copied) = temp_index_for(&repo).await?;
    let result = diff_with_temp_index(&repo, &temp, base).await;
    drop_temp_index(&temp).await;
    result
}

async fn diff_with_temp_index(
    repo: &Path,
    temp: &Path,
    base: Option<&str>,
) -> Result<GitDiff, PultError> {
    git(repo, &["add", "-N", "."], Some(temp)).await?;
    let head_ok = git(repo, &["rev-parse", "--verify", "-q", "HEAD"], None)
        .await
        .is_ok();
    let base = match base {
        Some(b) if !b.trim().is_empty() => b.trim().to_string(),
        _ if head_ok => "HEAD".to_string(),
        // Fresh repo without commits: plain `git diff` (index vs worktree)
        // renders every file as a new-file diff.
        _ => String::new(),
    };
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "--no-renames"];
    if !base.is_empty() {
        args.push(&base);
    }
    let raw = git(repo, &args, Some(temp)).await?;
    let resolved_base = if base.is_empty() { "worktree".to_string() } else { base };
    let files = parse_diff_files(&raw);
    Ok(GitDiff {
        repo_root: repo.to_string_lossy().into_owned(),
        base: resolved_base,
        raw,
        files,
    })
}

/// Splits raw `git diff` output into per-file verbatim slices.
fn parse_diff_files(raw: &str) -> Vec<DiffFile> {
    let mut files: Vec<DiffFile> = Vec::new();
    let mut current: Option<DiffFile> = None;
    let mut in_hunks = false;
    for line in raw.split_inclusive('\n') {
        let trimmed = line.strip_suffix('\n').unwrap_or(line);
        let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
        if trimmed.starts_with("diff --git ") {
            if let Some(done) = current.take() {
                files.push(done);
            }
            in_hunks = false;
            let mut file = DiffFile {
                path: String::new(),
                old_path: None,
                raw: String::new(),
                added: 0,
                removed: 0,
                binary: false,
                status: "modified".to_string(),
            };
            if let Some(paths) = trimmed.strip_prefix("diff --git a/") {
                // Fallback identity; refined by ---/+++ lines below.
                if let Some((a, b)) = paths.split_once(" b/") {
                    file.path = b.to_string();
                    file.old_path = Some(a.to_string());
                }
            }
            current = Some(file);
        }
        let Some(file) = current.as_mut() else {
            continue;
        };
        file.raw.push_str(line);
        if let Some(rest) = trimmed.strip_prefix("+++ b/") {
            if rest != "/dev/null" {
                file.path = rest.to_string();
            }
        } else if let Some(rest) = trimmed.strip_prefix("--- a/") {
            if rest != "/dev/null" {
                file.old_path = Some(rest.to_string());
            }
        } else if trimmed.starts_with("new file mode") {
            file.status = "added".to_string();
        } else if trimmed.starts_with("deleted file mode") {
            file.status = "deleted".to_string();
        } else if let Some(rest) = trimmed.strip_prefix("rename from ") {
            file.old_path = Some(rest.to_string());
            file.status = "renamed".to_string();
        } else if let Some(rest) = trimmed.strip_prefix("rename to ") {
            file.path = rest.to_string();
        } else if trimmed.starts_with("Binary files ") || trimmed.starts_with("GIT binary patch") {
            file.binary = true;
        } else if trimmed.starts_with("@@") {
            in_hunks = true;
        } else if in_hunks {
            if trimmed.starts_with('+') && !trimmed.starts_with("+++") {
                file.added += 1;
            } else if trimmed.starts_with('-') && !trimmed.starts_with("---") {
                file.removed += 1;
            }
        }
    }
    if let Some(done) = current.take() {
        files.push(done);
    }
    files
}

/// Porcelain v1 status with branch/ahead/behind (NUL-delimited, rename-safe).
pub async fn status(dir: &Path) -> Result<GitStatus, PultError> {
    let repo = resolve_repo(dir).await?;
    let raw = git(&repo, &["status", "--porcelain=v1", "-z", "--branch"], None).await?;
    parse_status(&repo, &raw)
}

fn parse_status(repo: &Path, raw: &str) -> Result<GitStatus, PultError> {
    let mut branch = None;
    let mut upstream = None;
    let mut ahead = 0i64;
    let mut behind = 0i64;
    let mut entries: Vec<StatusEntry> = Vec::new();
    let tokens = raw.split('\0').filter(|t| !t.is_empty());
    let mut expect_orig_path = false;
    for token in tokens {
        if let Some(branch_line) = token.strip_prefix("## ") {
            // "## main...origin/main [ahead 1, behind 2]" or "## HEAD (no branch)"
            let head = branch_line.split(" [").next().unwrap_or(branch_line);
            let (b, u) = head.split_once("...").unwrap_or((head, ""));
            branch = Some(b.trim().to_string());
            if !u.is_empty() {
                upstream = Some(u.trim().to_string());
            }
            if let Some(idx) = branch_line.find("ahead ") {
                ahead = branch_line[idx + 6..]
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .and_then(|d| d.parse().ok())
                    .unwrap_or(0);
            }
            if let Some(idx) = branch_line.find("behind ") {
                behind = branch_line[idx + 7..]
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .and_then(|d| d.parse().ok())
                    .unwrap_or(0);
            }
            continue;
        }
        if expect_orig_path {
            // The token after a rename/copy record is the original path.
            if let Some(last) = entries.last_mut() {
                last.orig_path = Some(token.to_string());
            }
            expect_orig_path = false;
            continue;
        }
        if token.len() < 4 {
            continue;
        }
        let x = token.as_bytes()[0] as char;
        let y = token.as_bytes()[1] as char;
        let path = token[3..].to_string();
        if x == 'R' || x == 'C' || y == 'R' || y == 'C' {
            expect_orig_path = true;
        }
        entries.push(StatusEntry {
            path,
            orig_path: None,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
        });
    }
    Ok(GitStatus {
        repo_root: repo.to_string_lossy().into_owned(),
        branch,
        upstream,
        ahead,
        behind,
        entries,
    })
}

/// Stages everything (matching what the diff panel shows) and commits.
pub async fn commit(dir: &Path, message: &str) -> Result<CommitOutcome, PultError> {
    let repo = resolve_repo(dir).await?;
    let message = message.trim();
    if message.is_empty() {
        return Err(git_err("git.empty_message", "commit message is empty"));
    }
    git(&repo, &["add", "-A", "."], None).await?;
    let commit_result = run_commit(&repo, message).await;
    let stdout = match commit_result {
        Ok(out) => out,
        Err(err) => {
            if err.to_string().contains("nothing to commit") {
                return Err(git_err("git.nothing_to_commit", "nothing to commit"));
            }
            return Err(err);
        }
    };
    let sha = git(&repo, &["rev-parse", "HEAD"], None)
        .await?
        .trim()
        .to_string();
    // `git commit` short summary line, e.g. "3 files changed, 10 insertions(+)".
    let files_committed = stdout
        .lines()
        .find(|l| l.contains("file") && l.contains("changed"))
        .and_then(|l| l.split_whitespace().next())
        .and_then(|n| n.parse().ok())
        .unwrap_or(0);
    Ok(CommitOutcome { sha, files_committed })
}

/// Pushes the current branch; creates upstream via origin when missing.
pub async fn push(dir: &Path) -> Result<PushOutcome, PultError> {
    let repo = resolve_repo(dir).await?;
    let upstream_ok = git(
        &repo,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{u}",
        ],
        None,
    )
    .await
    .is_ok();
    let args: Vec<String> = if upstream_ok {
        vec!["push".into()]
    } else {
        vec!["push".into(), "-u".into(), "origin".into(), "HEAD".into()]
    };
    let owned: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
    let mut cmd = tokio::process::Command::new("git");
    hide_console(&mut cmd);
    cmd.args(&owned)
        .current_dir(&repo)
        .env("GIT_OPTIONAL_LOCKS", "0");
    let out = cmd
        .output()
        .await
        .map_err(|e| internal(format!("git push spawn: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        let combined = format!("{stdout}{stderr}");
        if combined.contains("does not appear to be a git repository")
            || combined.contains("No configured push destination")
            || combined.contains("No such remote")
        {
            return Err(git_err(
                "git.no_remote",
                "no remote to push to (origin is not configured)",
            ));
        }
        return Err(git_err(
            "git.push_failed",
            format!("git push failed: {}", combined.trim()),
        ));
    }
    Ok(PushOutcome {
        output: format!("{}{}", stdout, stderr).trim().to_string(),
    })
}

/// `gh pr create` with a title/body; resolves the PR URL from stdout.
pub async fn pr_create(dir: &Path, title: &str, body: &str) -> Result<PrOutcome, PultError> {
    let repo = resolve_repo(dir).await?;
    if !gh_available().await {
        return Err(git_err(
            "git.gh_missing",
            "gh CLI not found on PATH — install GitHub CLI to open PRs",
        ));
    }
    let mut cmd = tokio::process::Command::new(gh_program());
    hide_console(&mut cmd);
    cmd.args(["pr", "create", "--title", title, "--body", body])
        .current_dir(&repo);
    let out = cmd
        .output()
        .await
        .map_err(|e| internal(format!("gh spawn: {e}")))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() {
        return Err(git_err(
            "git.pr_failed",
            format!("gh pr create failed: {}", stderr.trim()),
        ));
    }
    let url = stdout
        .lines()
        .rev()
        .find(|l| l.trim().starts_with("http"))
        .map(|l| l.trim().to_string())
        .ok_or_else(|| git_err("git.pr_failed", "gh pr create printed no PR URL"))?;
    Ok(PrOutcome { url })
}

/// `PULT_GH` overrides the gh program (tests / wrapper scripts).
fn gh_program() -> String {
    std::env::var("PULT_GH").unwrap_or_else(|_| "gh".to_string())
}

pub async fn gh_available() -> bool {
    let mut gh_cmd = tokio::process::Command::new(gh_program());
    hide_console(&mut gh_cmd);
    gh_cmd
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let trimmed = slug.trim_matches('-').to_string();
    trimmed.chars().take(32).collect()
}

/// Worktree per thread (§8 M4): `git worktree add` under `<repo>/.pult/worktrees/`.
pub async fn worktree_create(repo_dir: &Path, name: &str) -> Result<WorktreeOutcome, PultError> {
    let repo = resolve_repo(repo_dir).await?;
    let slug = slugify(name);
    if slug.is_empty() {
        return Err(git_err("git.bad_name", "worktree name has no usable characters"));
    }
    let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let worktree_name = format!("{slug}-{seq}");
    let path = repo.join(".pult").join("worktrees").join(&worktree_name);
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| internal(format!("create worktrees dir: {e}")))?;
    }
    ensure_pult_ignored(&repo).await?;
    let branch = format!("pult/{worktree_name}");
    let branch_exists = git(
        &repo,
        &["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")],
        None,
    )
    .await
    .is_ok();
    let path_string = path.to_string_lossy().into_owned();
    let args: Vec<String> = if branch_exists {
        vec!["worktree".into(), "add".into(), path_string, branch.clone()]
    } else {
        vec!["worktree".into(), "add".into(), "-b".into(), branch.clone(), path_string]
    };
    let owned: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
    git_run(&repo, &owned, None)
        .await
        .map_err(|e| {
            let msg = e.to_string();
            if msg.contains("already exists") {
                git_err("git.worktree_exists", format!("worktree already exists: {worktree_name}"))
            } else {
                e
            }
        })?;
    let canonical = path.canonicalize().unwrap_or(path);
    Ok(WorktreeOutcome {
        path: canonical.to_string_lossy().into_owned(),
        branch,
    })
}

/// `.pult/` stays invisible to `git status`/`add` via the repo-local exclude
/// file (never touches the user's `.gitignore`).
async fn ensure_pult_ignored(repo: &Path) -> Result<(), PultError> {
    let info_dir = repo.join(".git").join("info");
    tokio::fs::create_dir_all(&info_dir)
        .await
        .map_err(|e| internal(format!("create .git/info: {e}")))?;
    let exclude = info_dir.join("exclude");
    let existing = tokio::fs::read_to_string(&exclude).await.unwrap_or_default();
    if existing.lines().any(|l| l.trim() == ".pult/") {
        return Ok(());
    }
    let mut content = existing;
    if !content.is_empty() && !content.ends_with('\n') {
        content.push('\n');
    }
    content.push_str(".pult/\n");
    tokio::fs::write(&exclude, content)
        .await
        .map_err(|e| internal(format!("write .git/info/exclude: {e}")))?;
    Ok(())
}

/// Removes the worktree and prunes its registration; the branch is kept
/// (checkpoints and any commits made inside remain reachable).
pub async fn worktree_remove(repo_dir: &Path, name: &str) -> Result<(), PultError> {
    let repo = resolve_repo(repo_dir).await?;
    let path = repo.join(".pult").join("worktrees").join(name);
    let abs = path.canonicalize().unwrap_or(path.clone());
    let result = git(
        &repo,
        &["worktree", "remove", "--force", &abs.to_string_lossy()],
        None,
    )
    .await;
    if result.is_err() {
        // Directory gone but still registered (or vice versa) — prune handles both.
        git(&repo, &["worktree", "prune"], None).await?;
        if path.exists() {
            tokio::fs::remove_dir_all(&path)
                .await
                .map_err(|e| internal(format!("remove worktree dir: {e}")))?;
        }
        return Ok(());
    }
    git(&repo, &["worktree", "prune"], None).await?;
    Ok(())
}

/// Hidden checkpoint ref `refs/pult/checkpoints/<run_id>` (§4.4) — commit-tree
/// through a scratch index so the user's real index is untouched.
pub async fn checkpoint(dir: &Path, run_id: &str) -> Result<String, PultError> {
    let repo = resolve_repo(dir).await?;
    let (temp, _copied) = temp_index_for(&repo).await?;
    let outcome = checkpoint_with_temp_index(&repo, &temp, run_id).await;
    drop_temp_index(&temp).await;
    outcome
}

async fn checkpoint_with_temp_index(
    repo: &Path,
    temp: &Path,
    run_id: &str,
) -> Result<String, PultError> {
    git(repo, &["add", "-A", "."], Some(temp)).await?;
    let tree = git(repo, &["write-tree"], Some(temp))
        .await?
        .trim()
        .to_string();
    let head_ok = git(repo, &["rev-parse", "--verify", "-q", "HEAD"], None)
        .await
        .is_ok();
    let message = format!("pult checkpoint {run_id}");
    let sha = if head_ok {
        git(
            repo,
            &[
                "-c",
                "user.name=pult",
                "-c",
                "user.email=pult@local",
                "commit-tree",
                &tree,
                "-p",
                "HEAD",
                "-m",
                &message,
            ],
            None,
        )
        .await?
    } else {
        git(
            repo,
            &[
                "-c",
                "user.name=pult",
                "-c",
                "user.email=pult@local",
                "commit-tree",
                &tree,
                "-m",
                &message,
            ],
            None,
        )
        .await?
    }
    .trim()
    .to_string();
    git(
        repo,
        &["update-ref", &format!("refs/pult/checkpoints/{run_id}"), &sha],
        None,
    )
    .await?;
    Ok(sha)
}

#[cfg(test)]
mod tests;
