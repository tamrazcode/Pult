# Files Surface & Provider Update Feedback Polish

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **Authorship & Execution Split:** Author failing tests for each task (Step 1) and verify failure (Step 2) before implementing production changes (Step 3) and running verification (Step 4).

**Goal:** Complete the two remaining polish areas after commit `1d18867`: (A) show `M/A/D/R/U/?` git status decorations on file and ancestor folder rows, add a non-remounting manual refresh button with spinner, and surface the backend `workspace_tree` cap (`entries` + `truncated` notice) in `FilesPanel`; (B) show per-provider progress (`Updating Codex 0.169.0 -> 0.170.0`), preserve failed updates with visible error messages, and re-run `providersUpdateCheck` after `installUpdates` in `Sidebar`.

**Architecture:** Four bite-sized TDD tasks layered onto the existing Tauri 2 + React 19 + TypeScript (`strict: true`) + Zustand 5 + Tailwind CSS v4 codebase with zero new npm or Cargo dependencies:

- **Task 1 (`workspace_tree` truncation contract):** Replace the raw `Vec<WorkspaceEntry>` return of `workspace_tree` in `src-tauri/src/ipc/mod.rs` with a camelCase `WorkspaceTree { entries, truncated }` serde struct, track both the 2,000-entry and depth-6 caps accurately, update `src/lib/ipc.ts` + the existing `tests/editors.test.tsx` mock, and test truncation in Rust.
- **Task 2 (`FilesPanel` git badges, refresh, truncation notice):** Add pure status-mapping and folder-propagation helpers in `src/lib/fileGitStatus.ts`, wire `useGitStore((s) => s.byThread[threadId]?.status)` into `src/components/files/FilesPanel.tsx`, add a toolbar `RefreshCw` button that re-fetches `workspaceTree(threadId)` without remounting or clearing `filePreview`, and render a one-line `text-xs` truncation notice when `truncated` is `true`.
- **Task 3 (`Sidebar` provider update progress & error retention):** Export `formatUpdateProgress` and update `installUpdates` / `refresh` / footer UI in `src/components/layout/Sidebar.tsx` to track `activeUpdate` and per-instance errors, keep failed `ProviderUpdate` items in state across the post-loop `providersUpdateCheck()`, and render inline `text-xs` progress/error text plus tooltip feedback while keeping existing icon-only button `aria-label`s intact.
- **Task 4 (Verification & `DEVLOG.md`):** Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, and `cargo clippy`, then record verification results in `DEVLOG.md`.

**Tech Stack:** Rust / Tauri 2 (`serde`), React 19, TypeScript (`strict: true`), Zustand 5, Tailwind CSS v4 (semantic CSS tokens, `text-xs` >= 12px), Lucide React (`RefreshCw`), Vitest + Testing Library (`jsdom`).

---

## Global Constraints

- **Zero new npm or Cargo dependencies:** Use existing Rust stdlib (`std::env::temp_dir`, `std::fs`), `lucide-react`, `useGitStore`, and existing Tailwind CSS v4 theme tokens (`text-warning`, `text-success`, `text-danger`, `text-info`, `text-text-tertiary`).
- **Do not touch backend self-updaters or run them live:** `providers_update_check`, `providers_update_install`, `codex update`, and `opencode upgrade` in `src-tauri/src/ipc/mod.rs` MUST NOT be modified or executed live.
- **Preserve existing test & font contracts:**
  - Never introduce `text-[9px]` / `text-[10px]` / `text-[11px]` (`tests/fonts.test.ts` enforces >= `12px` / `text-xs`).
  - Keep `<button aria-label="Refresh">` in `Sidebar`'s footer icon-only (`btn.textContent?.trim() === ""`) with `"Check provider updates"` tooltip when idle (`tests/sidebar.test.tsx`).
- **Keep current file preview on refresh:** `FilesPanel` refresh MUST NOT reset `useUiStore.filePreview`, `preview`, or `image`, and MUST NOT call `useGitStore.refresh()` unnecessarily (which would break isolated tests that only mock `workspaceTree`).

## Review Focus

1. **Exact truncation boundary:** `walk_workspace` sets `truncated = true` only when a non-ignored entry or non-empty non-ignored subdirectory at depth > 6 is actually skipped—never on an exact 2,000-entry directory, an empty depth-6 directory, or an ignored directory like `node_modules`.
2. **Git decoration priority & ancestor propagation:** File rows map porcelain `indexStatus` / `worktreeStatus` to `M/A/D/R/U/?`; ancestor folder rows derive their badge from all changed descendants (including deleted files not present in `workspaceTree`) via deterministic priority `U > D > M > A > R > ?`.
3. **Request-race & preview preservation:** Rapid or overlapping `workspaceTree(threadId)` refreshes ignore stale responses via a request counter, spin `RefreshCw` only while loading, and leave `selected`, `preview`, and `image` intact.
4. **Update failure retention:** If `providersUpdateInstall` fails for one provider while another succeeds, `Sidebar` re-runs `providersUpdateCheck()`, preserves any failed provider + its error text in the footer and tooltip even if the re-check omits it or throws, and clears errors once a subsequent install/check succeeds.

---

## Tasks

### Task 1: Backend `workspace_tree` `{ entries, truncated }` payload and truncation tests

**Design Decision:** Introduce `WorkspaceTree { entries, truncated }` in `src-tauri/src/ipc/mod.rs` and mirror it in `src/lib/ipc.ts`. Factor `walk_workspace(root)` into `walk_workspace_with_limits(root, max_entries, max_depth)` with constants `MAX_TREE_ENTRIES = 2000` and `MAX_TREE_DEPTH = 6`: check `out.len() >= max_entries` _after_ skipping `TREE_IGNORE` so an ignored sibling does not trigger false truncation, and when `depth > max_depth` mark `truncated = true` only if `dir` contains at least one non-ignored entry. Keep `FilesPanel.tsx` and `tests/editors.test.tsx` compiling and green in the same task since `workspaceTree()` changes return shape.

**Files:**

- Modify: `src-tauri/src/ipc/mod.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `src/components/files/FilesPanel.tsx` (minimal destructure `const { entries } = await workspaceTree(threadId)` until Task 2 adds the notice)
- Modify: `tests/editors.test.tsx` (update `workspaceTree` mock return value to `{ entries: [...], truncated: false }`)

**Interfaces:**

- `src-tauri/src/ipc/mod.rs`:
  ```rust
  #[derive(serde::Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct WorkspaceTree {
      pub entries: Vec<WorkspaceEntry>,
      pub truncated: bool,
  }

  const MAX_TREE_ENTRIES: usize = 2000;
  const MAX_TREE_DEPTH: usize = 6;

  fn walk_workspace(root: &std::path::Path) -> Result<WorkspaceTree, PultError>;
  fn walk_workspace_with_limits(
      root: &std::path::Path,
      max_entries: usize,
      max_depth: usize,
  ) -> Result<WorkspaceTree, PultError>;

  #[tauri::command]
  pub async fn workspace_tree(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: String,
  ) -> Result<WorkspaceTree, PultError>;
  ```
- `src/lib/ipc.ts`:
  ```ts
  export interface WorkspaceTree {
    entries: WorkspaceEntry[];
    truncated: boolean;
  }

  export function workspaceTree(threadId: string): Promise<WorkspaceTree> {
    return invokeRequired<WorkspaceTree>("workspace_tree", { threadId });
  }
  ```

**Steps:**

- [x] **Step 1: Write failing Rust tests**
      Add `mod workspace_tree_tests` in `src-tauri/src/ipc/mod.rs` calling `walk_workspace` and `walk_workspace_with_limits`:
  1. `truncates_at_entry_cap_and_marks_truncated`:
     - Creates a unique temp dir under `std::env::temp_dir()` with 3 files; asserts `walk_workspace_with_limits(&dir, 3, 6)` returns `entries.len() == 3` and `truncated == false`.
     - Adds a 4th file (plus a `node_modules/ignored.js` entry); asserts `walk_workspace_with_limits(&dir, 3, 6)` returns `entries.len() == 3`, `truncated == true`, and excludes `node_modules`.
     - Creates a 2001-file temp dir; asserts `walk_workspace(&dir)` returns `entries.len() == 2000` and `truncated == true` (cleans up temp dirs afterward).
  2. `truncates_at_depth_limit_and_skips_empty_or_ignored_subtrees`:
     - Creates `a/b/c/d/e/f/empty_at_6` (depth 6, empty) and `a/b/c/d/e/f/node_modules/x.js` (ignored at depth 6); asserts `walk_workspace(&dir).truncated == false`.
     - Adds `a/b/c/d/e/f/deep.txt` (depth 7); asserts `walk_workspace(&dir).truncated == true` and `deep.txt` is omitted.
- [x] **Step 2: Run Rust tests to verify failure**
      Run `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_tree_tests` → FAIL (`WorkspaceTree`, `walk_workspace_with_limits`, and `.truncated` do not exist).
- [x] **Step 3: Implement `WorkspaceTree` in Rust and update IPC types**
      Implement `WorkspaceTree`, `walk_workspace_with_limits`, and `workspace_tree` in `src-tauri/src/ipc/mod.rs`; update `WorkspaceTree` and `workspaceTree` in `src/lib/ipc.ts`; update `FilesPanel.tsx` to read `res.entries` and `tests/editors.test.tsx` mock to return `{ entries: [...], truncated: false }`.
- [x] **Step 4: Run verification**
      Run:
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace_tree_tests` → PASS
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS
  - `pnpm typecheck && pnpm test tests/editors.test.tsx` → PASS

---

### Task 2: `FilesPanel` git status decorations, manual refresh, and truncation notice

**Design Decision:** Put pure git-status classification and ancestor-folder propagation in `src/lib/fileGitStatus.ts` so it is unit-testable without DOM overhead and reusable. In `FilesPanel.tsx`, read `useGitStore((s) => (threadId ? s.byThread[threadId]?.status : undefined))` reactively (populated by thread load and `scheduleGitRefresh`), render a right-aligned `text-xs font-mono font-medium` badge on modified/added/deleted/renamed/unmerged/untracked files and their ancestor folders, add a `<button aria-label="Refresh files">` with `<RefreshCw size={13} className={loadingTree ? "animate-spin" : ""} />` in the toolbar that re-runs `workspaceTree(threadId)` without remounting or clearing `filePreview`, and render a one-line `text-xs` notice (`role="status"`, `data-truncated-notice`) when `truncated` is `true`.

**Files:**

- Create: `src/lib/fileGitStatus.ts`
- Modify: `src/components/files/FilesPanel.tsx`
- Create test: `tests/files-panel.test.tsx`

**Interfaces:**

- `src/lib/fileGitStatus.ts`:
  ```ts
  import type { GitStatus, GitStatusEntry } from "./types";

  export type FileGitCode = "M" | "A" | "D" | "R" | "U" | "?";

  export interface FileGitDecoration {
    code: FileGitCode;
    label: string;
    colorClass: string;
  }

  export function classifyGitEntry(entry: GitStatusEntry): FileGitCode | null;
  export function buildFileGitStatusMap(
    status: GitStatus | null | undefined,
  ): Map<string, FileGitDecoration>;
  ```
  - Code mapping & tokens:
    - `"U"` → `{ code: "U", label: "Unmerged", colorClass: "text-danger" }` (matches `indexStatus === "U"`, `worktreeStatus === "U"`, or unmerged porcelain pairs `AA`, `DD`, `AU`, `UA`, `DU`, `UD`)
    - `"?"` → `{ code: "?", label: "Untracked", colorClass: "text-text-tertiary" }`
    - `"D"` → `{ code: "D", label: "Deleted", colorClass: "text-danger" }`
    - `"R"` → `{ code: "R", label: "Renamed", colorClass: "text-info" }`
    - `"A"` → `{ code: "A", label: "Added", colorClass: "text-success" }` (also maps `"C"` copied → `"A"`)
    - `"M"` → `{ code: "M", label: "Modified", colorClass: "text-warning" }`
  - Ancestor propagation priority (highest wins on folder rows): `U > D > M > A > R > ?`.
- `src/components/files/FilesPanel.tsx`:
  - Toolbar button: `<button type="button" aria-label="Refresh files" title="Refresh files" disabled={loadingTree} onClick={() => void refreshTree()}>` rendering `<RefreshCw size={13} className={loadingTree ? "animate-spin" : undefined} />`.
  - Row badge: `<span data-git-status={git.code} title={git.label} aria-label={git.label} className={`ml-auto shrink-0 font-mono text-xs font-medium ${git.colorClass}`}>{git.code}</span>`.
  - Truncation banner (below tree list or at top of tree pane when `truncated` is `true`): `<p role="status" data-truncated-notice className="border-t border-border-subtle px-2 py-1 text-xs text-text-tertiary">Showing first 2,000 entries (depth 6)</p>`.

**Steps:**

- [x] **Step 1: Write failing tests**
      Create `tests/files-panel.test.tsx` (mocking `isTauri: () => true`, `workspaceTree`, `workspaceReadText`, `readImageDataUrl`, `openInEditor`):
  1. `"classifies M/A/D/R/U/? entries and propagates highest-priority status to ancestor folders"`:
     - Unit-tests `classifyGitEntry` for `M`, `A`, `D`, `R`, `U` (including `UU`/`AU`), `?`, `C`, and clean `" "`/`" "`.
     - Calls `buildFileGitStatusMap` with entries `src/a.ts` (`M`), `src/sub/b.ts` (`?`), `src/sub/c.ts` (`U`), `docs/gone.md` (`D`); asserts `"src/a.ts"` is `M`, `"src/sub"` is `U`, `"src"` is `U`, `"docs"` is `D`.
  2. `"renders git status badges on file and folder rows from useGitStore"`:
     - Seeds `useGitStore` (`byThread["th"].status.entries`) with `M`, `A`, `R`, `?`, `U` entries; renders `<FilesPanel threadId="th" />`.
     - Asserts file rows display `[data-git-status="M"]` (`text-warning`), `[data-git-status="A"]` (`text-success`), `[data-git-status="R"]` (`text-info`), `[data-git-status="?"]` (`text-text-tertiary`), and parent folder row `"src"` displays its derived `[data-git-status]` badge.
  3. `"refreshes workspaceTree on button click without remounting or clearing preview"`:
     - Sets `useUiStore.setState({ filePreview: "src/app.ts" })`; renders `<FilesPanel threadId="th" />` and waits for initial `workspaceTree` and `workspaceReadText`.
     - Returns a deferred promise on the 2nd `workspaceTree` call; clicks `Refresh files`, asserts button is disabled and `<svg>` carries `animate-spin`, while `"const x = 1;"` preview remains visible.
     - Resolves the 2nd call with an added file `"src/added.ts"`; asserts `"src/added.ts"` appears, spinner stops, `useUiStore.getState().filePreview` is still `"src/app.ts"`, and `workspaceTree` was called twice.
  4. `"shows a one-line notice only when workspaceTree reports truncated: true"`:
     - Renders with `truncated: false` → `queryByRole("status")` / `[data-truncated-notice]` is null.
     - Re-renders (or refreshes) with `truncated: true` → `[data-truncated-notice]` is visible with `"Showing first 2,000 entries (depth 6)"`.
- [x] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/files-panel.test.tsx` → FAIL (`src/lib/fileGitStatus.ts` does not exist; `FilesPanel` lacks refresh button, status badges, and truncation notice).
- [x] **Step 3: Implement `fileGitStatus.ts` and update `FilesPanel.tsx`**
      Create `src/lib/fileGitStatus.ts`; update `src/components/files/FilesPanel.tsx` with `useGitStore` subscription, status badges, `refreshTree` + `loadingTree` + `RefreshCw` toolbar button, and `truncated` notice.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/files-panel.test.tsx tests/editors.test.tsx tests/fonts.test.ts` → PASS.

---

### Task 3: Provider update progress, error retention, and post-loop re-check in `Sidebar`

**Design Decision:** Keep the `<button aria-label="Refresh">` icon-only so existing `tests/sidebar.test.tsx` footer checks stay green. Add pure formatter `formatUpdateProgress(update: ProviderUpdate): string` and track `activeUpdate: ProviderUpdate | null` plus `updateErrors: Record<string, string>` in `Sidebar`. During `installUpdates()`, set `activeUpdate` before each `providersUpdateInstall(update.instanceId)`, collect any failed `ProviderUpdate` + `ipcErrorMessage(err)` instead of swallowing to `console.error`, then await `providersUpdateCheck()` and merge any failed items back in (so failed updates remain visible and retryable even if `providersUpdateCheck()` omits them or fails). Render inline `text-xs` progress/error feedback in `<footer>` and reflect both in the Refresh/Update `<Tooltip label>` and button `title`.

**Files:**

- Modify: `src/components/layout/Sidebar.tsx`
- Create test: `tests/sidebar-updates.test.tsx`

**Interfaces:**

- `src/components/layout/Sidebar.tsx`:
  ```ts
  export function formatUpdateProgress(update: ProviderUpdate): string;
  ```
  - Returns:
    - `` `Updating ${update.displayName} ${update.current} -> ${update.latest}` `` when `update.current && update.latest`
    - `` `Updating ${update.displayName} to ${update.latest}` `` when `!update.current && update.latest`
    - `` `Updating ${update.displayName}…` `` otherwise.
  - Inline footer status area (rendered below the icon button row inside `<footer>` only when `activeUpdate` or `errorEntries.length > 0`):
    - While updating: `<p role="status" data-update-progress className="truncate text-xs text-text-secondary" title={progressText}>{progressText}</p>`.
    - When `errorEntries.length > 0` (and not currently installing, or alongside errors): `<p role="alert" data-update-error className="truncate text-xs text-danger" title={fullErrorText}>{firstErrorSummary}</p>` where `fullErrorText` joins `${displayName}: ${message}` lines.
  - Tooltip & `title` on the footer refresh/update button:
    - `installing && activeUpdate` → `formatUpdateProgress(activeUpdate)`
    - `installing` → `"Updating providers…"`
    - `errorEntries.length > 0` → `fullErrorText`
    - `updates.length > 0` → `` `Update ${updates.length} provider${updates.length === 1 ? "" : "s"}` ``
    - else → `"Check provider updates"`

**Steps:**

- [x] **Step 1: Write failing tests**
      Create `tests/sidebar-updates.test.tsx` (mocking `isTauri: () => true`, `providersUpdateCheck`, `providersUpdateInstall`, `@tanstack/react-router`, and store loaders; never running `codex update` / `opencode upgrade` live):
  1. `"formats and displays per-provider progress text while installing sequential updates"`:
     - Asserts `formatUpdateProgress({ instanceId: "codex", displayName: "Codex", package: "@openai/codex", current: "0.169.0", latest: "0.170.0", managed: true })` equals `"Updating Codex 0.169.0 -> 0.170.0"`.
     - Mocks `providersUpdateCheck` returning Codex (`0.169.0` -> `0.170.0`) and OpenCode (`1.0.0` -> `1.1.0`), clicks `Refresh` to populate updates, then clicks `Refresh` again to install with deferred `providersUpdateInstall` promises.
     - Asserts `[data-update-progress]` shows `"Updating Codex 0.169.0 -> 0.170.0"` while the first install is pending, then switches to `"Updating OpenCode 1.0.0 -> 1.1.0"` while the second install is pending.
     - Resolves the second install and mocks post-loop `providersUpdateCheck` returning `[]`; asserts progress disappears and tooltip returns to `"Check provider updates"`.
  2. `"keeps failed updates with visible error message and re-runs providersUpdateCheck after the loop"`:
     - Mocks `providersUpdateCheck` initially returning `[Codex, OpenCode]`; `providersUpdateInstall("codex")` rejects with `new Error("codex update failed: permission denied")` while `providersUpdateInstall("opencode")` resolves; post-loop `providersUpdateCheck` resolves with `[Codex]`.
     - Clicks update button; asserts `providersUpdateCheck` was called a second time (after the loop), `[data-update-error]` (`role="alert"`) displays `"Codex: codex update failed: permission denied"`, the update badge (`bg-accent` dot) remains on the button for retry, and hovering the button shows the error in its tooltip.
  3. `"retains failed update in list even if post-loop providersUpdateCheck returns empty or rejects"`:
     - Mocks `providersUpdateInstall("codex")` rejecting with `"network timeout"` and post-loop `providersUpdateCheck` rejecting; asserts Codex remains in the failed state (`[data-update-error]` contains `"network timeout"`, update dot stays visible) instead of clearing `updates`.
- [x] **Step 2: Run tests to verify failure**
      Run `pnpm test tests/sidebar-updates.test.tsx` → FAIL (`formatUpdateProgress` is not exported; `Sidebar` clears `updates` and renders no progress or error elements).
- [x] **Step 3: Update `Sidebar.tsx`**
      Export `formatUpdateProgress`, track `activeUpdate` and `updateErrors`, update `installUpdates` and `refresh` to preserve failed items and await `providersUpdateCheck()`, and render the inline `text-xs` progress/error block + tooltip label inside `<footer>` without altering the icon-only button `aria-label` or idle tooltip text.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/sidebar-updates.test.tsx tests/sidebar.test.tsx tests/fonts.test.ts` → PASS.

---

### Task 4: Full verification gates and `DEVLOG.md`

**Goal:** Verify all frontend and Rust gates pass cleanly with zero new dependencies and record the completed work in `DEVLOG.md`.

**Files:**

- Modify: `DEVLOG.md`

**Steps:**

- [x] **Step 1: Run all frontend and Rust verification gates**
      Run:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
    Verify zero warnings/errors and record exact test counts.
- [x] **Step 2: Confirm scope boundaries**
      Run `git diff --stat` and verify:
  - `package.json`, `pnpm-lock.yaml`, `src-tauri/Cargo.toml`, and `src-tauri/Cargo.lock` are untouched.
  - `providers_update_check` and `providers_update_install` in `src-tauri/src/ipc/mod.rs` are untouched.
- [x] **Step 3: Update `DEVLOG.md`**
      Append a concise entry documenting:
  - `workspace_tree` `{ entries, truncated }` contract + Rust truncation tests.
  - `FilesPanel` git status badges (`src/lib/fileGitStatus.ts`), manual refresh button, and truncation notice.
  - `Sidebar` per-provider update progress, error retention, and post-loop `providersUpdateCheck`.
  - Exact `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, and `cargo clippy` pass counts.

---

## Execution notes (2026-11-15)

- Gemini authored/rewrote `tests/sidebar-updates.test.tsx` and `tests/files-panel.test.tsx`; the Rust truncation cases follow Gemini's plan. DeepSeek implemented only production code.
- `workspace_tree` returns `{ entries, truncated }`; truncation requires a real non-ignored file under the cut, so exact-cap, empty, and ignored subtrees do not raise a false notice.
- Files refresh uses a request counter, so stale responses cannot overwrite a newer tree, and it never clears `filePreview`.
- Sidebar install progress names the provider; failures stay in the update list with an inline `data-update-error` message and retry dot; the post-loop check result is merged with failures.
- Verification: 276/276 TS, 160/160 Rust, typecheck/lint/clippy clean, `pnpm tauri build --no-bundle` pass.
