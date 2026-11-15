# ADE Review Follow-Up Implementation Plan (2026-11-16)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> **Authorship & Execution Split:** Gemini authors failing tests first (TDD Red) and verifies failure; implementer applies production changes and runs verification.
> **Stack:** Tauri 2 + Rust (`pult-core`) + React 19 + Zustand + TanStack Router + Tailwind CSS v4 + Vitest + Playwright.
> **Baseline:** Review [REVIEW.md](docs/reviews/2026-11-16-ade/REVIEW.md) verified against `HEAD` (`7930f0e`). No new dependencies, no architectural rewrites, smallest complete fix per confirmed finding.

---

## Finding Verification Summary (against HEAD `7930f0e`)

| ID  | Severity | Status    | Evidence (`file:line` / function)                                                                                                                                                                                                                                                                                     |
| --- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C01 | P1       | CONFIRMED | `src-tauri/src/runtime/mod.rs:2549-2597` (`resolve_session` masks `get_session_ref` errors with `_ =>` and emits no user-visible notice when `session/load` fails)                                                                                                                                                    |
| C02 | P1       | CONFIRMED | `src-tauri/src/git/mod.rs:1004-1025` (`worktree_remove` uses `--force` + `remove_dir_all`), `src-tauri/src/ipc/mod.rs:406-443` (`threads_delete`), `src-tauri/src/runtime/mod.rs:2191` (`finalize_run` auto-dispatches queue), `src/components/layout/Sidebar.tsx:467-494`                                            |
| C03 | P1       | CONFIRMED | `src-tauri/src/store/records.rs:67-74` (`QueueItem` lacks `mode`/`config_options`), `src-tauri/src/ipc/mod.rs:468-475` (`runs_dispatch` mutates live thread settings before `send`), `src-tauri/src/runtime/mod.rs:728-777,2199-2234`                                                                                 |
| C04 | P1       | CONFIRMED | `src-tauri/src/runtime/terminals.rs:22,159-253` (`output`/`wait_for_exit`/`kill`/`release` skip owner checks; `release_session` keys on raw ACP `session_id`), `src-tauri/src/runtime/mod.rs:2014-2040`                                                                                                               |
| C05 | P1       | CONFIRMED | `src-tauri/src/runtime/mod.rs:2867-2883` (`handle_terminal_create` passes `None` cwd), `src-tauri/src/runtime/terminals.rs:76-78` (falls back to ADE process cwd)                                                                                                                                                     |
| C06 | P2       | CONFIRMED | `src-tauri/src/runtime/terminals.rs:159-171` (`output` reads `guard.exit` without calling `try_wait()`)                                                                                                                                                                                                               |
| C07 | P1       | CONFIRMED | `src-tauri/src/runtime/mod.rs:1267-1293,2726-2736` (`remembered_for` lacks project/workspace scope), `src-tauri/src/runtime/permissions.rs:116-121` (`resolve` overrides `Supervised` and ignores `option.kind`)                                                                                                      |
| C08 | P2       | CONFIRMED | `src-tauri/src/config.rs:55-67,93` (`save_instances` uses non-atomic `fs::write`; `load_instances` returns `Vec::new()` on TOML parse error, triggering mock fallback in `AgentRuntime::new`)                                                                                                                         |
| C09 | P2       | CONFIRMED | `src-tauri/src/store/queue.rs:156-190` (`pop_queue_head` deletes row via `DELETE RETURNING` before `dispatch` / `create_run` commits)                                                                                                                                                                                 |
| C10 | P2       | CONFIRMED | `src-tauri/src/runtime/mod.rs:1145-1165` (`cancel` only spawns `session/cancel` notification with no cancelling state or kill escalation)                                                                                                                                                                             |
| C11 | P2       | CONFIRMED | `src-tauri/src/runtime/ptys.rs:115` (`powershell` hardcoded), `src/lib/links.ts:56,81-82` (rejects leading `/` and joins with `\`), `src/lib/auth.ts:37-41` (POSIX `KEY=val` syntax breaks PowerShell)                                                                                                                |
| C12 | P2       | CONFIRMED | `src-tauri/src/ipc/mod.rs:350-355` (`threads_get` loads all thread events), `src/stores/runs.ts:644-666` (`hydrateThread` does O(R*E) `events.filter` per run)                                                                                                                                                        |
| D01 | P1       | CONFIRMED | `src/components/chat/ComposerControls.tsx:771-782` (`ModePill` lacks mode descriptions), `src/components/chat/MessagesTimeline.tsx:848-888` (`ApprovalCard` hides agent/workspace/persistence), `src/components/layout/Sidebar.tsx:467-471`, `src/routes/settings.general.tsx` (no remembered-permissions view/reset) |
| D02 | P2       | CONFIRMED | `src/routes/settings.tsx:85` (`w-60` nav) + `src/routes/settings.providers.tsx:282` (`w-72` list) leaves cramped detail pane at `1040×680`                                                                                                                                                                            |
| D03 | P2       | CONFIRMED | `src/routes/index.tsx:4-6` (redirects `/` -> `/chat`), `src/components/chat/NewChatEmptyState.tsx:6-28` (no missing-agent CTA or dev-mock distinction), `src/components/chat/Composer.tsx:364` (stale `"pick one in the header"` error after typing)                                                                  |
| D04 | P2       | CONFIRMED | `src/components/ui/ImageLightbox.tsx:5-51` (lacks initial focus, `Tab` trap, and focus restoration on close)                                                                                                                                                                                                          |
| D05 | P2       | CONFIRMED | `src/components/terminal/TerminalPanel.tsx:74-101` (`create`/`kill`/`list` log to `console.error`; `kill` calls `removeTerminal` even when IPC fails)                                                                                                                                                                 |
| D06 | P2       | CONFIRMED | `src/lib/providerChecks.ts:46-58` (preserves old report on failure with no error/stale marker), `src/routes/settings.providers.tsx:62-98,141-169` (`statusLine` drops `at` timestamp and shows indistinguishable `Connected`)                                                                                         |
| Q01 | P2       | CONFIRMED | `src-tauri/src/drivers/golden.rs:216-219` (hard `200ms` latency assertion inside functional happy-path test), `tests/e2e/smoke.spec.ts:31` (asserts removed `"New threads start here."` text)                                                                                                                         |
| Q02 | P2       | CONFIRMED | `README.md:128` (stops at M8, no harness capability matrix), `TODO.md:3,25-40` (claims auth/model/usage missing, stale 86/54 counts), `src-tauri/tauri.conf.json:41` (`releases.pult.local`)                                                                                                                          |

---

## Wave & Dependency Map

Ordered by risk: **Wave 1–2** (data/context loss, isolation, permissions, queue/config durability, stop escalation) → **Wave 3** (IPC boundary, portability, history scaling) → **Wave 4** (UX/a11y/status states) → **Wave 5** (test gates & docs).

- **Wave 1 (5 parallel tasks — disjoint files):** `T01`, `T02`, `T03`, `T04`, `T05`.
- **Wave 2 (2 sequential tasks — shared `runtime/mod.rs` & `runtime/tests.rs`):** `T06` (depends on `T01`, `T03`, `T05`), then `T07` (depends on `T02`, `T04`, `T06`). **Cannot run in parallel** because both modify `src-tauri/src/runtime/mod.rs` and `src-tauri/src/runtime/tests.rs`.
- **Wave 3 (4 parallel tasks — disjoint files):** `T08` (depends on `T07`), `T09` (no deps), `T10` (no deps), `T11` (depends on `T08` for IPC signatures, or runs concurrently once IPC types are agreed).
- **Wave 4 (6 parallel tasks — disjoint UI/store files):** `T12` (depends on `T08`, `T11`), `T13` (depends on `T08`, `T11`), `T14` (depends on `T08`, `T11`), `T15` (no deps), `T16` (no deps), `T17` (no deps). **Note:** `T13` owns `src/components/chat/Composer.tsx` (including fixing the stale line-364 no-provider error string from D03) so `T15` only edits `NewChatEmptyState.tsx`.
- **Wave 5 (2 parallel tasks — gates & docs):** `T18` (no code deps; run final gate after Waves 1–4), `T19` (depends on Waves 1–4 completing so counts/truth match).

---

## Wave 1 — Data Safety, Isolation & Store Foundations

### T01 — Terminal owner-token isolation and `output` exit polling (C04, C06)

- **Severity:** P1 (`C04`) / P2 (`C06`)
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/runtime/terminals.rs`: `TerminalState`, `TerminalRegistry::create`, `TerminalRegistry::output`, `TerminalRegistry::wait_for_exit`, `TerminalRegistry::kill`, `TerminalRegistry::release`, `TerminalRegistry::release_session` (add `release_owner` + `new_owner_token` or explicit `owner_token: &str`), `poll_exit` helper.
- **Concrete Change:**
  - [x] Add `owner_token: String` to `TerminalState` (replacing reliance on raw ACP `session_id` for ownership). Add `TerminalRegistry::new_owner_token(&self) -> String` using an internal atomic counter so colliding remote ACP `session_id`s from separate processes never share ownership.
  - [x] Require `owner_token: &str` on `create`, `output`, `wait_for_exit`, `kill`, `release`, and `release_owner` (keep `release_session` as a thin wrapper or update all callers in `T06`). On mismatch in `output`/`wait_for_exit`/`kill`/`release`, return `term_error(format!("unknown terminal: {terminal_id}"))`.
  - [x] Extract `poll_exit(guard: &mut TerminalState) -> Option<TerminalExitStatus>` calling `guard.child.try_wait()` when `guard.exit.is_none()`. Call `poll_exit(&mut guard)` inside `TerminalRegistry::output` (reporting `exit_status` once `guard.exit.is_some()` and `guard.pipes_left == 0` so polling-only clients see `exitCode` without losing tail bytes).
- **Acceptance Tests (`src-tauri/src/runtime/terminals.rs` `#[cfg(test)]`):**
  - `terminal_owner_isolation_blocks_foreign_access_and_colliding_session_ids`: asserts owner A's `terminal_id` returns `ERR_RESOURCE_NOT_FOUND` when queried/killed/released with owner B's token, and `release_owner(token_a)` leaves owner B's terminal alive even when both came from ACP sessions named `"sess-1"`.
  - `output_polls_exit_status_without_wait_for_exit`: spawns a short-lived command (e.g. `cmd /c echo ok` / `sh -c "echo ok"`), polls `output` until `exit_status.is_some()`, and asserts `exit_code == Some(0)` and stdout contains `"ok"` without ever calling `wait_for_exit`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::terminals` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (red): `terminal_owner_isolation_blocks_foreign_access_and_colliding_session_ids`, `output_polls_exit_status_without_wait_for_exit`

### T02 — Non-destructive Git worktree dirty inspection and safe removal (C02)

- **Severity:** P1
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/git/mod.rs`: add `WorktreeDirtyStatus`, `pub async fn worktree_dirty_status(worktree_dir: &Path) -> Result<WorktreeDirtyStatus, PultError>`, update `pub async fn worktree_remove(repo_dir: &Path, name: &str, force: bool) -> Result<(), PultError>`.
  - `src-tauri/src/git/tests.rs`: add acceptance tests.
- **Concrete Change:**
  - [x] Add `WorktreeDirtyStatus { dirty: bool, modified: usize, untracked: usize, entries: Vec<String> }` (`#[derive(Debug, Clone, Serialize)]`, `camelCase`) running `git status --porcelain=v1 -z -uall` in `worktree_dir` (counting `??` as untracked and other porcelain lines as modified/staged, returning up to 20 sample paths in `entries`).
  - [x] Change `worktree_remove(repo_dir, name, force: bool)`: when `force == false`, first check `worktree_dirty_status(&path)` (if `path.exists()`); if `dirty`, return `git_err("git.worktree_dirty", ...)` WITHOUT removing files; run `git worktree remove` WITHOUT `--force` and do NOT call `tokio::fs::remove_dir_all(&path)` when `!force`. Only pass `--force` and allow `remove_dir_all` fallback when `force == true`.
- **Acceptance Tests (`src-tauri/src/git/tests.rs`):**
  - `worktree_remove_preserves_untracked_file_unless_forced`: creates a worktree, writes an untracked file inside it, calls `worktree_remove(&repo, &name, false)` and asserts `git.worktree_dirty` error AND that the untracked file still exists on disk; then calls `worktree_remove(&repo, &name, true)` and asserts removal succeeds.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib git::tests` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (red): `worktree_remove_preserves_untracked_file_unless_forced`

### T03 — Permission policy scope & option-kind validation (C07)

- **Severity:** P1
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/runtime/permissions.rs`: `resolve`, `#[cfg(test)] mod tests`.
- **Concrete Change:**
  - [x] In `permissions::resolve`, move/gate the `request.remembered` check so:
    1. `PermissionMode::Supervised` ALWAYS returns `PolicyDecision::Ask` (never short-circuited by `remembered`).
    2. When `request.escapes_workspace(root)` is true, `remembered` does NOT auto-resolve (except in `FullAccess` which already calls `auto_allow`).
    3. The matched option in `request.options` MUST satisfy `o.option_id == option_id && o.kind.starts_with("allow")` (rejecting reused IDs whose current `kind` is `reject_once` / `reject_always`).
- **Acceptance Tests (`src-tauri/src/runtime/permissions.rs` `#[cfg(test)]`):**
  - `remembered_never_overrides_supervised_or_workspace_escape_or_reject_kind`: asserts (a) `Supervised` + `remembered: Some("always")` returns `Ask`; (b) `AutoEdit` + `remembered: Some("always")` with outside-workspace path returns `Ask`; (c) `Auto` + `remembered: Some("opt-1")` where `opt-1` now has `kind: "reject_once"` returns `Ask` / falls through instead of `AutoResolve("opt-1")`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::permissions`.
- [x] tests authored (red): `remembered_never_overrides_supervised_or_workspace_escape_or_reject_kind`

### T04 — Queue snapshot schema & crash-safe transactional claim (C03, C09)

- **Severity:** P1 (`C03`) / P2 (`C09`)
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/store/migrations.rs`: `MIGRATIONS`, `migration_5`.
  - `src-tauri/src/store/records.rs`: `QueueItem`.
  - `src-tauri/src/store/queue.rs`: `enqueue_queue_item`, `list_queue`, `pop_queue_head` -> replace/augment with `claim_queue_head`, `release_queue_claim`, `commit_claimed_queue_run`.
  - `src-tauri/src/store/runs.rs`: `reset_orphaned_run_states`.
  - `src-tauri/src/store/tests.rs`: unit tests.
- **Concrete Change:**
  - [x] Add `migration_5`: `ALTER TABLE queue_items ADD COLUMN mode TEXT; ALTER TABLE queue_items ADD COLUMN config_options TEXT NOT NULL DEFAULT '{}'; ALTER TABLE queue_items ADD COLUMN claiming_run_id TEXT;`.
  - [x] Extend `QueueItem` (`records.rs`) with `pub mode: Option<String>` and `pub config_options: BTreeMap<String, crate::protocol::types::ConfigOptionValue>` (with `#[serde(default)]` for backwards-compatible JSON).
  - [x] Update `enqueue_queue_item` and `list_queue` (`WHERE thread_id = ?1 AND claiming_run_id IS NULL`) to persist/read `mode` and `config_options`.
  - [x] Add `claim_queue_head(&self, thread_id: &str, claim_token: &str) -> Result<Option<QueueItem>, PultError>` using a single atomic `UPDATE queue_items SET claiming_run_id = ?2 WHERE id = (SELECT id FROM queue_items WHERE thread_id = ?1 AND claiming_run_id IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1) AND claiming_run_id IS NULL RETURNING ...`.
  - [x] Add `commit_claimed_queue_run(&self, queue_id: &str, run: &RunRecord, user_event: &Event) -> Result<(), PultError>` executing `create_run` + `append_event` + `DELETE FROM queue_items WHERE id = ?1` inside one `BEGIN IMMEDIATE ... COMMIT` SQLite transaction, plus `release_queue_claim(&self, queue_id: &str)` clearing `claiming_run_id = NULL` on dispatch failure.
  - [x] In `reset_orphaned_run_states` (`store/runs.rs`), also reset `UPDATE queue_items SET claiming_run_id = NULL WHERE claiming_run_id IS NOT NULL` so a crash between claim and commit restores the queued message on restart.
- **Acceptance Tests (`src-tauri/src/store/tests.rs`):**
  - `queue_item_persists_mode_and_config_snapshot_and_recovers_orphaned_claim`: enqueues item with `mode: Some("plan")` and `model = "gpt-5"`, claims it, simulates crash before `commit_claimed_queue_run`, reopens/calls `reset_orphaned_run_states`, and asserts `list_queue` still contains the item with its exact `mode` and `config_options`.
  - `commit_claimed_queue_run_atomically_persists_run_event_and_deletes_queue_row`: asserts run, `UserMessage` event, and absence from `queue_items` all commit together.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib store::` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (red): `queue_item_persists_mode_and_config_snapshot_and_recovers_orphaned_claim`, `commit_claimed_queue_run_atomically_persists_run_event_and_deletes_queue_row`

### T05 — Atomic `config.toml` persistence & explicit parse errors (C08)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/config.rs`: `load_instances`, add `load_instances_checked`, update `save_instances`.
- **Concrete Change:**
  - [x] Add `pub fn load_instances_checked(home: &Path) -> Result<Vec<InstanceSpec>, String>` returning `Ok(Vec::new())` when `config.toml` does not exist, `Ok(config.instances)` on valid TOML, and `Err(err.to_string())` on read/parse error; keep `load_instances` delegating with `tracing::warn!`.
  - [x] Update `save_instances(home, specs)`: write serialized TOML to `config.toml.tmp.<pid>`, call `file.sync_all()`, and atomically `std::fs::rename(&tmp, &path)` (cleaning up `tmp` on error so an interrupted write never truncates or corrupts `config.toml`).
- **Acceptance Tests (`src-tauri/src/config.rs` `#[cfg(test)]`):**
  - `load_instances_checked_reports_corrupt_toml_without_silent_empty`: writes invalid TOML to temp dir `config.toml`, asserts `load_instances_checked` returns `Err(...)`.
  - `save_instances_preserves_existing_file_when_toml_is_corrupt_or_write_fails`: asserts corrupt existing `config.toml` stays untouched when `save_instances` returns `Err`, and valid writes leave no `.tmp` files behind.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib config::tests`.
- [x] tests authored (red): `load_instances_checked_reports_corrupt_toml_without_silent_empty`, `save_instances_preserves_existing_file_when_toml_is_corrupt_or_write_fails`

---

## Wave 2 — Runtime Core Integration (Sequential on `runtime/mod.rs`)

### T06 — Runtime isolation, context-reset notice, project-scoped permissions & config error state (C01, C04, C05, C07, C08)

- **Severity:** P1 (`C01`, `C04`, `C05`, `C07`) / P2 (`C08`)
- **Dependencies:** `T01`, `T03`, `T05`
- **Files & Functions:**
  - `src-tauri/src/runtime/pool.rs`: `IdleConn`, `IdlePool::invalidate_thread`, `IdlePool::invalidate_instance`, `IdlePool::invalidate_root` (release `owner_token` on eviction).
  - `src-tauri/src/runtime/mod.rs`: `Inner`, `RunState`, `AgentRuntime::new`, `config_error()`, `remembered_for`, `remember_decision`, `list_remembered_permissions`, `clear_remembered_permission`, `resolve_session`, `run_turn`, `handle_terminal_create`, `surface_and_resolve_permission`.
  - `src-tauri/src/runtime/tests.rs`: runtime tests.
- **Concrete Change:**
  - [x] **C04 + C05:** Generate unique `owner_token = terminals.new_owner_token()` per spawned/warmed connection, carry it on `IdleConn` and `RunState`, pass `&owner_token` into `handle_terminal_create`, `terminals.output/wait_for_exit/kill/release`, and `terminals.release_owner(&owner_token)`. In `handle_terminal_create`, replace `None => None` with `None => Some(clean_verbatim(root.to_path_buf()))` so commands without `cwd` run in the thread's workspace root.
  - [x] **C01:** In `resolve_session`, match `runtime.store.get_session_ref(thread_id, instance_id)?` (propagating SQLite errors instead of `_ =>`); record `context_reset_reason: Option<String>` on `ResolvedSession` when `session/load` fails, when a prior session exists but `!init.agent_capabilities.load_session`, or when the thread's prior finished/failed run used a different `instance_id`. In `run_turn`, emit & persist a `Notice { level: "warning", message }` before the agent responds whenever `context_reset_reason` is `Some(...)`.
  - [x] **C07:** Scope `remembered_permissions` by `(workspace_key, instance_id, tool_kind)` where `workspace_key` is the normalized `clean_verbatim(root)` string (migrating/ignoring legacy unscoped entries cleanly). Add `list_remembered_permissions()` and `clear_remembered_permission(workspace_key, instance_id, tool_kind)` (or clear-all when `None`).
  - [x] **C08:** In `AgentRuntime::new`, call `load_instances_checked(&home)` and store `config_error: Option<String>` on `Inner` (exposed via `pub fn config_error(&self) -> Option<String>`); do not clear/overwrite `config_error` unless `set_instances` succeeds.
- **Acceptance Tests (`src-tauri/src/runtime/tests.rs`):**
  - `terminal_without_cwd_runs_in_thread_workspace_including_spaces`: runs mock/shell terminal without `cwd` in a temp workspace containing spaces and asserts stdout prints that workspace path.
  - `terminal_owner_isolation_across_concurrent_sessions`: verifies session A cannot read/kill/release session B's terminal and releasing A preserves B.
  - `resolve_session_emits_notice_on_load_failure_and_propagates_sqlite_error`: mock rejects `session/load` -> asserts persisted `Notice` event in the new run before `AgentMessageDelta`; closed/corrupt DB returns `Err` instead of silently creating a fresh session.
  - `remembered_permission_is_scoped_to_workspace_and_respects_supervised`: approves `allow_always` in project A, verifies project B still surfaces `ApprovalRequest` (`Ask`), and switching project A to `Supervised` also surfaces `Ask`.
  - `corrupt_config_toml_populates_config_error`: creates runtime with malformed `config.toml` and asserts `runtime.config_error().is_some()`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::tests` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (red): `terminal_without_cwd_runs_in_thread_workspace_including_spaces`, `resolve_session_emits_notice_on_load_failure`, `remembered_permission_is_scoped_to_workspace_and_respects_supervised`, `corrupt_config_toml_populates_config_error`

### T07 — Thread-deleting guard, snapshot queue dispatch & cancel escalation (C02, C03, C09, C10)

- **Severity:** P1 (`C02`, `C03`) / P2 (`C09`, `C10`)
- **Dependencies:** `T02`, `T04`, `T06` (**Must run after `T06`**, not in parallel, because both edit `runtime/mod.rs` and `runtime/tests.rs`.)
- **Files & Functions:**
  - `src-tauri/src/runtime/mod.rs`: `Inner::deleting_threads`, `Inner::cancelling_runs`, `begin_delete_thread`, `finish_delete_thread`, `send`, `dispatch` / `dispatch_inner`, `auto_dispatch_queue`, `finalize_run`, `cancel` / `cancel_with_force`, `run_turn`.
  - `src-tauri/src/runtime/tests.rs`: runtime tests.
- **Concrete Change:**
  - [x] **C02:** Add `deleting_threads: HashSet<String>` in `Inner` plus `begin_delete_thread(&self, thread_id: &str)` / `finish_delete_thread(&self, thread_id: &str)`. `send`, `dispatch_inner`, `finalize_run`, and `auto_dispatch_queue` check `deleting_threads` and refuse/skip starting new runs or draining the queue while deletion is in progress.
  - [x] **C03 + C09:** Extend `send(thread, text, images, instance_id, mode, config_options)` so:
    - When idle: applies/persists `mode` + `config_options` and dispatches immediately.
    - When busy (or losing race to `thread.busy`): snapshots `mode` + `config_options` into `QueueItem` WITHOUT mutating live `set_mode` or `desired_config` on the active session.
    - In `auto_dispatch_queue`: calls `store.claim_queue_head(thread_id, &claim_id)`; calls `dispatch_claimed_item(&thread, &item)` which uses `item.mode` + `item.config_options` (falling back to thread desired settings only when `item.mode`/`config_options` are empty) and commits `RunRecord` + `UserMessage` + queue-row delete via `store.commit_claimed_queue_run(...)`. On pre-commit failure, calls `store.release_queue_claim(&item.id)`.
  - [x] **C10:** Add `cancelling_runs: HashSet<String>` in `Inner` and `cancel_with_force(&self, run_id: &str, force: bool)`:
    - Marks `run_id` in `cancelling_runs` and emits `"run:cancelling"` (`{ runId, threadId }`).
    - If `force == true`, calls `conn.kill()` immediately; otherwise sends `conn.cancel(&session_id)` and spawns a grace timer (`PULT_CANCEL_GRACE_MS` env override, default `5000` ms) that calls `self.kill_run(&run_id)` if the run is still active.
    - In `run_turn`, if `cancelling_runs` contains `run_id` when `prompt_fut` finishes with `Err` (after `conn.kill()`), map `status = "cancelled"`, `stop_reason = "cancelled"`, `failure = None`, and release terminals via `terminals.release_owner(&owner_token)`. Clean `cancelling_runs` in `finalize_run`.
- **Acceptance Tests (`src-tauri/src/runtime/tests.rs`):**
  - `deleting_thread_prevents_finalize_run_from_dispatching_queued_message`: queues message B behind active run A, calls `begin_delete_thread`, finishes run A, asserts message B is NOT dispatched.
  - `queued_messages_keep_per_message_model_and_mode_without_mutating_active_run`: starts run 1 on model A, queues B with model B and C with model C while changing picker, asserts run 2 uses model B and run 3 uses model C (and active run 1 never received `set_mode`/`set_config_option` for B/C).
  - `cancel_escalates_to_kill_when_agent_ignores_cancel`: sets `PULT_CANCEL_GRACE_MS=80`, runs mock configured to ignore `session/cancel`, calls `cancel_with_force(&run_id, false)`, asserts run transitions to `"cancelled"` and releases its terminals within `< 1s`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::tests` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (red): `deleting_thread_prevents_finalize_run_from_dispatching_queued_message`, `queued_messages_keep_per_message_model_and_mode_without_mutating_active_run`, `cancel_escalates_to_kill_when_agent_ignores_cancel`

---

## Wave 3 — IPC Plumbing, Cross-Platform Fixes & History Scaling

### T08 — IPC commands for safe worktree delete, queue snapshot, permissions reset, config status, force-cancel & bounded history (C02, C03, C07, C08, C10, C12)

- **Severity:** P1 (`C02`, `C03`, `C07`) / P2 (`C08`, `C10`, `C12`)
- **Dependencies:** `T07`
- **Files & Functions:**
  - `src-tauri/src/store/threads.rs`: optional `list_runs_page` / `load_thread_events_for_runs` helper if needed for bounded `threads_get`.
  - `src-tauri/src/ipc/mod.rs`: `threads_worktree_status` (new), `threads_delete`, `runs_dispatch`, `runs_cancel`, `permissions_remembered_list` (new), `permissions_remembered_clear` (new), `providers_config_status` (new), `threads_get` (bounded history / `has_more_runs` + `threads_get_older_runs` or byte-budget cap).
  - `src-tauri/src/lib.rs`: register new commands in `tauri::generate_handler!`.
- **Concrete Change:**
  - [x] Add `threads_worktree_status(thread_id)` returning `Option<WorktreeDirtyStatus>` (`None` if thread has no worktree or dir missing).
  - [x] Update `threads_delete(thread_id, worktree_mode: Option<String>)`: wrap active-run cancel/kill + worktree cleanup in `runtime.begin_delete_thread` / `finish_delete_thread` guard; pass `force = matches!(worktree_mode.as_deref(), Some("force_remove"))` to `git::worktree_remove` when `worktree_mode != Some("keep")`. If `worktree_remove` returns `git.worktree_dirty`, propagate the error BEFORE deleting the SQLite thread row so user data is never orphaned or lost!
  - [x] Update `runs_dispatch`: pass `mode` + `config_options` directly into `runtime.send(...)` without pre-mutating `set_mode` / `merge_desired_config`.
  - [x] Update `runs_cancel(run_id, force: Option<bool>)` -> `runtime.cancel_with_force(&run_id, force.unwrap_or(false))`.
  - [x] Add `permissions_remembered_list`, `permissions_remembered_clear`, and `providers_config_status` commands and register them in `lib.rs`.
  - [x] Add total-IPC-byte budget cap (`TOTAL_EVENT_BYTES = 16_000_000`) in `cap_ui_event_payloads` (per-payload caps stay at 2 MB; the oldest payloads are trimmed to 4 KB until the whole history fits).
  - [ ] Deferred: paginated history (`limit_runs` + `has_more_runs` + `threads_get_older_runs`) once a real large-chat measurement shows the 16 MB budget is hit; the single-pass frontend hydrate is already in place.
- **Acceptance Tests (`src-tauri/src/ipc/mod.rs` `#[cfg(test)]` & `src-tauri/src/store/tests.rs`):**
  - `threads_delete_refuses_dirty_worktree_without_force_and_preserves_thread_row`: creates worktree thread + untracked file, calls delete helper without force, asserts `git.worktree_dirty` error AND thread row + untracked file remain intact; `keep` deletes thread row while preserving worktree dir.
  - `cap_ui_event_payloads_enforces_total_history_budget`: passes 20 × 1.5 MB events and verifies total serialized IPC payload stays below cap.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.
- [x] tests authored (green — production already implemented): `threads_delete_refuses_dirty_worktree_without_force_and_preserves_thread_row`, `cap_ui_event_payloads_enforces_total_history_budget`

### T09 — Platform-aware PTY default shell (C11 backend)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/runtime/ptys.rs`: `default_shell()`, `PtyRegistry::create`.
- **Concrete Change:**
  - [x] Extract `fn default_shell() -> (String, Vec<String>)`:
    - `#[cfg(windows)]`: `("powershell".to_string(), vec!["-NoLogo".to_string()])`
    - `#[cfg(not(windows))]`: read `std::env::var("SHELL")` (if non-empty) else `"/bin/sh".to_string()`, with `Vec::new()`.
  - [x] Use `default_shell()` in `PtyRegistry::create` when `params.command` is `None`/empty.
- **Acceptance Tests (`src-tauri/src/runtime/ptys.rs` `#[cfg(test)]`):**
  - `default_shell_matches_target_os`: asserts Windows returns `powershell -NoLogo` and non-Windows resolves `$SHELL` or `/bin/sh`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib runtime::ptys`.
- [x] tests authored (green — production already implemented): `default_shell_matches_target_os`

### T10 — Cross-platform Markdown workspace links & PowerShell/POSIX terminal auth command (C11 frontend)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src/lib/links.ts`: `classifyMarkdownHref`.
  - `src/lib/auth.ts`: `buildTerminalAuthCommand`, `detectDefaultAuthShell`.
  - `src/components/settings/SignInActions.tsx`: `SignInActions`.
  - `tests/markdown-links.test.tsx`, `tests/auth.test.ts`.
- **Concrete Change:**
  - [x] In `classifyMarkdownHref(rawHref, workspaceRoot, platform?)`: infer POSIX when `workspaceRoot` starts with `/` (and not `//`) or `platform === "posix"`. Allow POSIX absolute paths inside `workspaceRoot` (prefix containment check with `/`), reject paths outside `workspaceRoot`, and join `fullPath` with `/` on POSIX vs `\` on Windows.
  - [x] In `buildTerminalAuthCommand(launch, method, shell?)`: support `"posix"` (`KEY="val" cmd ...`) and `"powershell"` (`$env:KEY="val"; & "cmd" "arg"` when `env` present or command has spaces/special chars, using PowerShell escaping). Default `shell` via `detectDefaultAuthShell()` (`"powershell"` on Windows `navigator.platform`, `"posix"` otherwise) and show a compact shell selector (`PowerShell` / `sh`) in `SignInActions.tsx` beside `Copy command`.
- **Acceptance Tests (`tests/auth.test.ts`, `tests/markdown-links.test.tsx`):**
  - `tests/auth.test.ts`: `formats PowerShell env assignment and quoted path with spaces` + `formats POSIX env assignment on macOS/Linux`.
  - `tests/markdown-links.test.tsx`: `classifies POSIX absolute workspace paths and joins with forward slashes`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/auth.test.ts tests/markdown-links.test.tsx`.
- [x] tests authored (red): `formats PowerShell env assignment and quoted path with spaces`, `formats POSIX env assignment on macOS/Linux`, `classifies POSIX absolute workspace paths and joins with forward slashes`

### T11 — Frontend IPC bindings, single-pass `hydrateThread` & large-chat benchmark (C12, IPC types)

- **Severity:** P2
- **Dependencies:** `T08` (interface contract)
- **Files & Functions:**
  - `src/lib/types.ts`: `WorktreeDirtyStatus`, `RememberedPermission`, `ThreadDetail.hasMoreRuns`.
  - `src/lib/ipc.ts`: `threadsWorktreeStatus`, `threadsDelete(threadId, worktreeMode?)`, `runsCancel(runId, force?)`, `permissionsRememberedList`, `permissionsRememberedClear`, `providersConfigStatus`, `threadsGetOlderRuns`.
  - `src/stores/runs.ts`: `hydrateThread`, `cancellingRunIds`, `run:cancelling` listener in `attachRunListeners`.
  - `tests/runs-store.test.ts`: correctness + benchmark test.
- **Concrete Change:**
  - [x] Add TypeScript types & invoke wrappers in `src/lib/types.ts` and `src/lib/ipc.ts`.
  - [x] Refactor `hydrateThread` in `src/stores/runs.ts` to index `events` into a single `Map<string, RunEvent[]>` in one O(E) pass before iterating `sorted` runs (removing O(R*E) `events.filter`), and sort each run's bucket once.
  - [x] Track `cancellingByRun: Record<string, boolean>` in `useRunsStore` populated by `"run:cancelling"` and cleared on `run:finished`.
- **Acceptance Tests (`tests/runs-store.test.ts`):**
  - `hydrateThread groups 500 runs and 10000 events in single pass`: measures actual elapsed `performance.now()` and asserts correctness of all 500 run views without asserting an arbitrary flaky host threshold (logs measured ms cleanly).
  - `marks run as cancelling on run:cancelling event and clears on finish`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/runs-store.test.ts`.
- [x] tests authored (green — production already implemented): `hydrateThread groups 500 runs and 10000 events in a single pass`, `marks run as cancelling on run:cancelling event and clears on finish`

---

## Wave 4 — UX, Safety Explanations & A11y States

### T12 — Worktree-aware thread delete confirmation (C02 UI, D01)

- **Severity:** P1
- **Dependencies:** `T08`, `T11`
- **Files & Functions:**
  - `src/stores/threads.ts`: `deleteThread(id, worktreeMode?)`.
  - `src/components/layout/Sidebar.tsx`: `threadMenuItems`, inline/modal delete confirmation dialog.
  - `tests/thread-delete.test.tsx` (create).
- **Concrete Change:**
  - [x] Update `useThreadsStore.deleteThread(id, worktreeMode?)` to pass `worktreeMode` to `threadsDelete`.
  - [x] In `Sidebar.tsx`, clicking `Delete` on a thread checks `threadsWorktreeStatus(thread.id)` (when `isTauri()`). If the thread has a worktree with `dirty === true` (modified or untracked files) OR `confirmDeleteThread` is enabled, open a dedicated confirmation modal displaying: thread title, workspace path, exact modified/untracked counts + sample file names, and explicit actions: **"Delete thread & keep worktree"** (`worktreeMode: "keep"`), **"Delete thread & discard files"** (`worktreeMode: "force_remove"`, danger), and **Cancel**. Never silently delete dirty/untracked worktree files.
- **Acceptance Tests (`tests/thread-delete.test.tsx`):**
  - `shows dirty/untracked worktree warning and preserves files when keep worktree is chosen` (mocks `threadsWorktreeStatus` returning `{ dirty: true, untracked: 1, modified: 0, entries: ["draft.txt"] }`, asserts dialog shows `draft.txt` + workspace path, and clicking "Delete thread & keep worktree" calls `threadsDelete(id, "keep")`).
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/thread-delete.test.tsx tests/sidebar.test.tsx`.
- [x] tests authored (green — production already implemented in working tree): `shows workspace path and dirty entries, supports keep and force_remove, and cancels without deleting`

### T13 — Permission mode explanations, approval context, remembered-permissions manager & force-stop button (D01, C10 UI, D03 composer error fix)

- **Severity:** P1 (`D01`) / P2 (`C10`, `D03`)
- **Dependencies:** `T08`, `T11`
- **Files & Functions:**
  - `src/stores/settings.ts`: `PERMISSION_MODE_DESCRIPTIONS`.
  - `src/components/chat/ComposerControls.tsx`: `ModePill`.
  - `src/components/chat/MessagesTimeline.tsx`: `ApprovalCard`.
  - `src/components/chat/Composer.tsx`: pending approval banner, `handleStop` ("Force stop" when cancelling), `dispatchRun` line-364 no-provider error message.
  - `src/routes/settings.general.tsx`: `GeneralSettings` remembered permissions list + revoke/clear.
  - `tests/messages-timeline.test.tsx`, `tests/composer.test.tsx`, `tests/settings-pages.test.tsx`.
- **Concrete Change:**
  - [x] Export `PERMISSION_MODE_DESCRIPTIONS` in `src/stores/settings.ts` and render each mode's concise scope description in `ModePill` (`ComposerControls.tsx`).
  - [x] In `ApprovalCard` (`MessagesTimeline.tsx`) and `Composer.tsx` approval bar: display active provider displayName + workspace path, and add clear label/note on `allow_always` (`"Always (this agent & project)"`).
  - [x] In `Composer.tsx`: when `useRunsStore((s) => activeRun ? s.cancellingByRun[activeRun.id] : false)` is true, change the Stop button aria-label/title to `"Force stop"` and call `runsCancel(activeRun.id, true)`; update line-364 error from `"pick one in the header"` to `"No agent selected — pick a provider in the composer or connect one in Settings ▸ Providers"`.
  - [x] In `src/routes/settings.general.tsx`: load `permissionsRememberedList()` on mount and render a "Remembered permissions" section showing workspace, instance, tool kind, and Revoke / Clear all buttons.
- **Acceptance Tests (`tests/messages-timeline.test.tsx`, `tests/composer.test.tsx`, `tests/settings-pages.test.tsx`):**
  - `tests/messages-timeline.test.tsx`: `ApprovalCard displays active provider, workspace, and project-scoped allow_always note`.
  - `tests/composer.test.tsx`: `ModePill shows scope descriptions and Stop button switches to Force stop while cancelling`.
  - `tests/settings-pages.test.tsx`: `GeneralSettings lists and revokes remembered permissions`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/messages-timeline.test.tsx tests/composer.test.tsx tests/settings-pages.test.tsx`.
- [x] tests authored (red on `ApprovalCard` allow_always button scope label; green on `ModePill`/Force stop and `GeneralSettings` remembered permissions): `ApprovalCard displays active provider, workspace, and project-scoped allow_always note`, `ModePill shows scope descriptions and Stop button switches to Force stop while cancelling`, `GeneralSettings lists and revokes remembered permissions`

### T14 — Responsive Providers layout, stale/failed probe status & `config.toml` error banner (D02, D06, C08 UI)

- **Severity:** P2
- **Dependencies:** `T08`, `T11`
- **Files & Functions:**
  - `src/lib/providerChecks.ts`: `CachedCheck`, `preflightInstances`.
  - `src/routes/settings.tsx`: `SettingsLayout` nav width/collapse on compact viewports.
  - `src/routes/settings.providers.tsx`: `statusLine`, `ProvidersSettings` list/detail responsive layout + config-error alert.
  - `tests/provider-checks.test.ts`, `tests/provider-signin.test.tsx`, `tests/providers-empty.test.tsx`.
- **Concrete Change:**
  - [x] **D06:** Extend `CachedCheck` with `lastAttemptAt?: number` and `lastError?: string | null`. When `preflightInstances` catches an error for an instance with a prior cached report, keep `report` & `at` AND set `lastAttemptAt: Date.now()` and `lastError: ipcErrorMessage(err)` (clearing `lastError` on next success). Update `statusLine` to take `CachedCheck | undefined` and render `"Check failed · cached <rel>"` (tone `"warn"`) or `"Connected · checked <rel>"` + `"Last checked <time>"` in the Status panel instead of indistinguishable `"Connected"`.
  - [x] **D02:** Make `settings.tsx` nav compact (`w-52`, collapsible/drawer or narrow header strip below `1100px`) and in `settings.providers.tsx` replace fixed `w-72` split with responsive sizing (`w-60` / single-pane list-or-detail with `"← Providers"` back link below `1120px` so at `1040×680` and 125% text zoom the detail pane and empty state read cleanly without narrow wrapping).
  - [x] **C08:** Call `providersConfigStatus()` on mount in `ProvidersSettings` and display a prominent `role="alert"` banner with the `config.toml` parse error when present.
- **Acceptance Tests (`tests/provider-checks.test.ts`, `tests/provider-signin.test.tsx`, `tests/providers-empty.test.tsx`):**
  - `tests/provider-checks.test.ts`: `records lastError and lastAttemptAt while retaining prior cached report on probe failure`.
  - `tests/provider-signin.test.tsx`: `statusLine distinguishes fresh connected check from failed stale cached check`.
  - `tests/providers-empty.test.tsx`: `renders back-to-list navigation or readable detail layout at 1040px and surfaces config parse errors`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/provider-checks.test.ts tests/provider-signin.test.tsx tests/providers-empty.test.tsx`.
- [x] tests authored (red on `providers-empty.test.tsx` `"Back to providers"` accessible name; green on `provider-checks.test.ts` and `provider-signin.test.tsx`): `records lastError and lastAttemptAt while retaining prior cached report on probe failure, then clears lastError on success`, `statusLine distinguishes fresh connected check from failed stale cached check`, `surfaces config.toml parse errors and renders Back to providers control at 1040px width after selecting a provider`

### T15 — Non-blocking first-run / missing-agent guidance & dev-mock label (D03)

- **Severity:** P2
- **Dependencies:** None (`T13` owns `Composer.tsx` line 364)
- **Files & Functions:**
  - `src/components/chat/NewChatEmptyState.tsx`: `NewChatEmptyState`.
  - `tests/new-chat-empty.test.tsx`.
- **Concrete Change:**
  - [x] Inspect enabled instances from `useUiStore((s) => s.instances)`:
    - When `enabledInstances.length === 0`: show a concise `"No agent connected"` callout with a **"Connect an agent"** button navigating to `/settings/providers` (and secondary link to `/welcome`) so the user sees the setup requirement before typing a prompt.
    - When the only enabled instance is `driver === "mock"`: show a subtle `"Dev mock active"` pill with `"Connect a real agent"` link to `/settings/providers`, without blocking experienced users from sending immediately.
- **Acceptance Tests (`tests/new-chat-empty.test.tsx`):**
  - `shows Connect an agent CTA when no enabled providers exist` and `labels built-in dev mock without blocking chat`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/new-chat-empty.test.tsx`.
- [x] tests authored (green — production already implemented): `shows Connect an agent CTA when no enabled providers exist and navigates to /settings/providers`, `labels built-in dev mock without blocking chat and navigates to /settings/providers`, `renders neither missing-agent CTA nor dev-mock label when a real provider is enabled`

### T16 — Complete modal focus trap and focus restoration in `ImageLightbox` (D04)

- **Severity:** P2
- **Dependencies:** None (do NOT modify `CommandPalette.tsx`)
- **Files & Functions:**
  - `src/components/ui/ImageLightbox.tsx`: `ImageLightbox`.
  - `tests/image-lightbox.test.tsx` (create).
- **Concrete Change:**
  - [x] Capture `document.activeElement` on mount; focus the Close `<button>` via `ref` on mount; intercept `Tab` / `Shift+Tab` inside the lightbox so focus stays inside the dialog (wrapping cleanly on the Close button instead of escaping behind the modal); restore focus to the captured trigger element on unmount if still connected.
- **Acceptance Tests (`tests/image-lightbox.test.tsx`):**
  - `moves focus to Close button on open, traps Tab/Shift+Tab inside dialog, and restores focus on Escape close`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/image-lightbox.test.tsx tests/markdown-links.test.tsx`.
- [x] tests authored (green — production already implemented): `moves focus to Close button on mount, traps Tab/Shift+Tab inside dialog, and restores focus on Escape close`, `restores focus to previously focused element on unmount`

### T17 — Inline error banner & confirmed-only tab removal in `TerminalPanel` (D05)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src/components/terminal/TerminalPanel.tsx`: `TerminalPanel`, `create`, `kill`, `useEffect` list sync.
  - `tests/terminal-panel.test.tsx` (create).
- **Concrete Change:**
  - [x] Add `error: string | null` state (cleared on `threadId` change, Dismiss click, or successful action) rendered as an inline `role="alert"` banner with a Retry/Dismiss action.
  - [x] Surface `ipcErrorMessage(err)` when `terminalPtyList`, `terminalPtyCreate`, or `terminalPtyKill` rejects.
  - [x] Move `removeTerminal(threadId, id)` inside the `try` block of `kill()` after `await terminalPtyKill(id)` succeeds (removing on error only if the backend message explicitly indicates the terminal is already unknown/not found; otherwise keeping the tab visible alongside the inline error).
- **Acceptance Tests (`tests/terminal-panel.test.tsx`):**
  - `surfaces inline error on terminalPtyCreate rejection and preserves tab with error on terminalPtyKill rejection`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test tests/terminal-panel.test.tsx tests/terminals.test.ts`.
- [x] tests authored (green — production already implemented): `shows an inline alert with the error message when terminalPtyCreate rejects`, `keeps the tab visible and shows an alert when terminalPtyKill rejects, then removes on success`

---

## Wave 5 — Test Gates & Documentation Truth Refresh

### T18 — Stabilize golden timing gate & fix stale Playwright smoke test (Q01)

- **Severity:** P2
- **Dependencies:** Waves 1–4 complete
- **Files & Functions:**
  - `src-tauri/src/drivers/golden.rs`: `golden_happy_path_streams_expected_events`, new `#[ignore]` `golden_first_echo_latency_budget`.
  - `tests/e2e/smoke.spec.ts`: line 31 assertion.
- **Concrete Change:**
  - [x] Remove the load-sensitive `assert!(first_echo < Duration::from_millis(200), ...)` from `golden_happy_path_streams_expected_events` and move it into an explicit `#[tokio::test] #[ignore = "timing budget: run explicitly on idle host"] async fn golden_first_echo_latency_budget()`.
  - [x] Update `tests/e2e/smoke.spec.ts:31` to assert current empty-state UI (`await expect(page.getByRole("heading", { name: "What should we work on?" })).toBeVisible();` and `await expect(page.getByRole("navigation", { name: "Threads" })).toBeVisible();`).
- **Acceptance Tests:**
  - `cargo test --manifest-path src-tauri/Cargo.toml golden_happy_path_streams_expected_events` passes deterministically under load.
  - `pnpm exec playwright test tests/e2e/smoke.spec.ts` passes all 5 smoke specs (runtime acceptance when Playwright Chromium is available).
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `pnpm exec playwright test`.
- [x] tests authored/updated (green): `golden_happy_path_streams_expected_events`, `golden_first_echo_latency_budget` (`#[ignore]`), `tests/e2e/smoke.spec.ts`, plus test-maintenance updates in `tests/composer.test.tsx`, `tests/run-events.test.ts`, and `tests/thread-actions.test.tsx`

### T19 — Truthful `README.md` / `TODO.md` refresh & Harness Capability Matrix (Q02)

- **Severity:** P2
- **Dependencies:** Waves 1–4 complete
- **Files & Functions:**
  - `README.md`
  - `TODO.md`
- **Concrete Change:**
  - [x] Refresh `README.md`: update current status beyond M8 (auth sign-in, model/config pickers, `/usage`, browser panel, project widget, queue actions, dark/light/graphite/liquid themes), update verification commands, and add a **Harness Capability & Verification Matrix** table (`Agent`, `Adapter / Command`, `Auth`, `Images`, `Resume`, `Cancel`, `Model & Effort`, `Last verified`). Leave `Last verified` blank (`—`) for every harness/platform not verified end-to-end with a real signed-in account — **never invent verification dates**.
  - [x] Refresh `TODO.md`: remove stale items already implemented (in-app sign-in, model/reasoning pickers, Antigravity detection, `/usage`, "never committed" note), record actual current check status, and list remaining release blockers (`releases.pult.local` placeholder updater endpoint in `tauri.conf.json`, Windows Authenticode signing, macOS/Linux builds & notarization, real subscription harness E2E checks).
- **Acceptance Check:**
  - Inspect `README.md` and `TODO.md` to confirm zero fabricated verification dates, zero stale feature-missing claims, and explicit manual/runtime acceptance section.

---

## Testability Limits & Manual / Runtime Acceptance

Automated Vitest, Cargo, and Playwright browser smoke tests **cannot** prove the following; keep these explicitly marked as **manual / runtime acceptance**:

1. **Real subscription harnesses** (`claude-code`, `gemini-cli`, `codex`, `opencode`, `antigravity`, `dsh`): real account sign-in (`authenticate` & terminal CLI login), live `session/load` resume across app restart, capability-gated image prompts, tool-call permission prompts, `session/cancel` + force-kill on wedged real CLIs, and two concurrent real chats.
2. **Real updater & OS installers (`tauri.conf.json`)**: replacing `https://releases.pult.local/...` with a real HTTPS endpoint, Windows Authenticode signing, macOS `codesign` + `notarytool`, and Linux `deb`/`AppImage` bundling.
3. **Visual / A11y runtime checks**: Dark/Light/Graphite/Liquid themes at `1040×680` and `1440×900`, OS text-scaling (125%+), and Windows Narrator / NVDA screen-reader traversal.

---

## Out of Scope / Rejected Suggestions

1. **OS-level process sandboxing for arbitrary agent CLIs:** Rejected (C07). Agents are user-configured local processes (`npx`, `claude`, `codex`, etc.) with user privileges; promising OS sandboxing inside pult would be misleading. Fixing project/mode/kind scoping and workspace containment is the honest boundary.
2. **Replaying visual chat transcripts as synthetic prompt turns on `session/load` failure:** Rejected (C01). Auto-injecting full old transcripts on resume failure risks blowing token limits or breaking provider-specific context formats; emitting a visible `Notice` event and propagating SQLite errors gives clear, safe behavior without guessing.
3. **Full `PRODUCT.md` / `DESIGN.md` rewrite or UI redesign:** Out of scope (Q02/D01–D06). Visual identity and tokens are preserved; only missing states/explanations and responsive widths are fixed.
4. **`CommandPalette.tsx` focus refactor:** Deliberately excluded (D04) because `7930f0e` updated `CommandPalette` separately; only `ImageLightbox.tsx` is scoped here.
5. **Forcing a blocking `/welcome` onboarding wizard on every launch:** Rejected (D03). Returning users stay on fast `/chat`; new/unconfigured users get an inline non-blocking `"Connect an agent"` CTA before losing typed input.
6. **Hardcoding a real release URL or fabricating test dates:** Rejected (Q02). `releases.pult.local` requires an owner-supplied release domain and signing keys; unverified matrix cells stay blank (`—`).
