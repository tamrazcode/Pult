# M9 — Chat, Thread Lifecycle & Navigation Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the real hydration bugs, broken UI promises and TS↔Rust contract holes in the daily loop "pick a thread → compose → stream → navigate", so pult feels finished without new external dependencies.

**Architecture:** Extend the existing Rust `AgentRuntime` / IPC bridge and the zustand stores. No SQLite schema migrations: thread-scoped preferences use the existing `settings` KV. UI remains a projection of the stores.

**Tech Stack:** Tauri 2 (Rust, Tokio, rusqlite, serde), React 19, TypeScript strict, TanStack Router, zustand, Tailwind v4, Vitest + Testing Library, Playwright (msedge), cargo test/clippy.

**Spec:** The original §-spec is not in the repo; the de-facto spec is `README.md` (user promises) plus the per-milestone `DEVLOG.md` entries (decisions, known gaps) and `CHANGELOG.md`. Audit of 2026-11-14 (Gemini, low) is the source of the task list below.

**Status 2026-11-14:** Tasks 1–7 done (`a4ec67a` … `665d24f`), plus review fixes (`d1c6d47`) and the vitest include fix (`34728e4`). Found on the way: `vitest.config.ts` never ran `*.test.tsx` (3 suites silently skipped). Open item: the Playwright smoke assertion is written but not verified — the local Vite dev server hangs at dependency optimization.

## Global Constraints

- No `PRAGMA user_version` bump / no new tables: thread-scoped mode/permission state goes through the existing `settings` KV; existing `~/.pult/pult.db` must keep working.
- TypeScript stays `strict`; no `any`, no suppression comments. IPC errors keep the `PultError { code, message }` shape.
- Every path/URL crossing IPC is validated in Rust: `workspace_files` must not escape the workspace; `open_external_url` accepts `http://`/`https://` only, no shell metacharacter interpretation.
- No regression in existing gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy --all-targets -- -D warnings`.
- All copy follows the repo's unslop voice: no em-dash constructions, no milestone jargon in UI strings.

## Review Focus

1. **Switching threads during an active stream:** launch in th-1, open th-2, come back — the live run must stay `running` and keep its streamed items/pending approval, not flip to a fake crash.
2. **Esc vs overlays:** Esc must close the topmost overlay (palette, elicitation, slash/@ menu, agent pickers) without cancelling the run; it cancels the run only when nothing else claimed the key.
3. **`@` completion on huge repos:** workspace with `node_modules`/`target`/`.git` and symlinks must not block the Tauri worker or return paths outside the root.
4. **Offline mode selection:** a mode picked on `/chat` or between turns must survive into the next run and must not leak into another thread; an agent rejecting the mode must not kill the send.
5. **Deleting the active thread (or one with a live run/worktree):** UI must cancel/clean up, drop store state and land on `/chat` without a dangling 404 banner.

---

## Git baseline (pre-flight, one commit)

The repo has zero commits and the whole tree is untracked. Before Task 1:

- [ ] Extend `.gitignore` with `test-results/`, `playwright-report/`, `blob-report/`, `playwright/.cache/`, `coverage/`, `fixtures/mock-repo/`, `fixtures/mock-remote.git/`, `fixtures/gh-mock-log.txt` (real fixtures `fixtures/mock-acp-agent.mjs`, `fixtures/tui-demo.mjs`, `fixtures/bin/gh.cmd` stay tracked).
- [ ] `git status --short` shows no `dist/`, `src-tauri/target/`, `node_modules/`, `test-results/`, `fixtures/mock-repo/`.
- [ ] `git add -A && git commit -m "chore: initial baseline import (M0-M8)"`.

---

### Task 1: Thread hydration keeps live runs alive

**Files:**

- Modify: `src/routes/thread.$threadId.tsx`
- Modify: `src/stores/runs.ts` (no signature change; behaviour only)
- Modify: `src/stores/ui.ts`, `src/lib/ipc.ts` (pass `detail` through)
- Modify: `src/routes/settings.diagnostics.tsx` (status dot), `src/components/chat/MessagesTimeline.tsx` (retry error)
- Test: `tests/runs-store.test.ts`, `tests/ui-store.test.ts`

**Interfaces:**

- Consumes: `ThreadDetail.activeRunId` (`src/lib/types.ts:136`), `AgentProcessPayload.detail` (`types.ts:240`).
- Produces: `UiState.applyProcessEvent(instanceId: string, kind: string, detail?: string | null): void` — appends `{ at, kind, detail }` to `processEvents[instanceId]`.

- [ ] **Step 1: Write the failing tests**

`tests/runs-store.test.ts`:

```ts
it("keeps a run the backend reports as active streaming", () => {
  useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [], [], "r1");
  expect(useRunsStore.getState().runsByThread["th"][0].status).toBe("running");
  expect(useRunsStore.getState().viewsByRun["r1"].streaming).toBe(true);
});

it("still marks a DB-running run with no live runtime as failed", () => {
  useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [], [], null);
  const failed = useRunsStore.getState().runsByThread["th"][0];
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatch(/restarted/);
});
```

`tests/ui-store.test.ts`:

```ts
it("keeps the process event detail", () => {
  useUiStore.setState({ processEvents: {} });
  useUiStore.getState().applyProcessEvent("mock", "crashed", "exit code 1");
  expect(useUiStore.getState().processEvents["mock"]).toEqual([
    expect.objectContaining({ kind: "crashed", detail: "exit code 1" }),
  ]);
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `pnpm vitest run tests/runs-store.test.ts tests/ui-store.test.ts`
Expected: FAIL (`streaming` false / `status` failed on the first test; `detail` undefined on the second).

- [ ] **Step 3: Implement**

Pass `detail.activeRunId` at the `hydrateThread` call. Thread the third `detail` argument through `onAgentProcess` → `applyProcessEvent` and persist it in the ring. In diagnostics, color the dot from the last kind (`crashed` → danger, `spawned`/`running` → success, `starting` → warning). In `retryLastMessage`, replace `console.error` with `useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) })`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `pnpm vitest run tests/runs-store.test.ts tests/ui-store.test.ts && pnpm typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

`git add -A && git commit -m "fix(threads): keep live runs streaming across thread switches"`

---

### Task 2: Composer stops the run on Esc, inserts slashes, exposes allow_always

**Files:**

- Modify: `src/components/chat/Composer.tsx`
- Test: `tests/composer.test.tsx`

**Interfaces:**

- Produces: `formatSlashInsertion(command: CommandInfo): string` → `` `/${command.name} ` ``; exported from `Composer.tsx` for the test.
- Produces: Escape handling at the composer level: if the slash menu is open → close it (`preventDefault`); else if a run is active → `runsCancel(activeRun.id)`; overlays keep precedence via their own `defaultPrevented`.

- [ ] **Step 1: Write the failing test** in `tests/composer.test.tsx`

```tsx
it("inserts the leading slash for a picked command", () => {
  expect(formatSlashInsertion({ name: "commit", description: "" })).toBe("/commit ");
});
```

Rendering the full composer is heavy; the second assertion uses `shouldCancelOnEscape({ runActive: true, slashOpen: false, overlayOpen: false }) === true` and `=== false` with `slashOpen` or `overlayOpen`.

- [ ] **Step 2: Run it, verify it fails**

Run: `pnpm vitest run tests/composer.test.tsx`
Expected: FAIL (exports missing).

- [ ] **Step 3: Implement**

`pickSlash` uses `formatSlashInsertion`; approval bar renders every standard option present in `pendingApproval.options` (once/always/reject) with the existing keyboard hints. Esc in the composer keydown: `if (slashOpen) { preventDefault; close; return }` then `if (activeRun?.status === "running") { preventDefault; runsCancel(...) }`; do not cancel while `activeElicitation` is set or the palette is open.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run tests/composer.test.tsx && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add -A && git commit -m "fix(composer): Esc stops the run, slash picks keep their slash, allow_always is clickable"`

---

### Task 3: `@` file mentions from the workspace

**Files:**

- Modify: `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`
- Create: `src-tauri/src/workspace.rs` (listing + validation + tests)
- Modify: `src/lib/ipc.ts`, `src/components/chat/Composer.tsx`
- Test: Rust module tests; `tests/composer.test.tsx`

**Interfaces:**

- Rust: `pub fn list_workspace_files(root: &Path, query: &str, limit: usize) -> Result<Vec<String>, PultError>` — POSIX-relative paths, skips `.git`, `node_modules`, `target`, `dist`, `.pult`, `.vite`, hard caps 3000 visited / 200 returned.
- IPC: `workspace_files(thread_id: Option<String>, workspace: Option<String>, query: Option<String>) -> Result<Vec<String>, PultError>`.
- TS: `workspaceFiles(params: { threadId?: string; workspace?: string; query?: string }): Promise<string[]>`.
- TS pure: `extractMentionQuery(text: string, caret: number): { start: number; query: string } | null` (ignores `foo@bar.com`).

- [ ] **Step 1: Rust failing test** — tempdir with `src/main.rs`, `node_modules/a.js`, `.git/HEAD`, `target/debug/bin`; expect exactly `["src/main.rs"]`; query filter and limit assertions.
- [ ] **Step 2: Run it** — `cargo test --manifest-path src-tauri/Cargo.toml list_workspace_files` → FAIL (module missing).
- [ ] **Step 3: Implement** the listing (iterative walk, depth/size caps, `spawn_blocking` at the IPC boundary), register the command, add the TS wrapper.
- [ ] **Step 4: Vitest tests** for `extractMentionQuery` (email ignored, mid-text token) and for picking an item (inserts `@path `, keeps surrounding text).
- [ ] **Step 5: Verify** — `cargo test --manifest-path src-tauri/Cargo.toml workspace` and `pnpm vitest run tests/composer.test.tsx && pnpm typecheck`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(composer): @ file mentions backed by workspace_files"`.

---

### Task 4: Session mode survives between turns and per thread

**Files:**

- Modify: `src-tauri/src/runtime/mod.rs` (`set_mode`, `dispatch`, `RunRecord.mode`), `src-tauri/src/ipc/mod.rs` (`ThreadDetail`, `runs_dispatch` mode arg)
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/runs.ts`, `src/components/chat/ComposerControls.tsx`
- Test: Rust runtime test; `tests/runs-store.test.ts`

**Interfaces:**

- `AgentRuntime::set_mode(&self, thread_id: &str, mode_id: &str)` persists `thread_mode:<threadId>` in the settings table and applies `conn.set_mode` only when a run is live; never errors when idle.
- `RunRecord.mode: Option<String>` is set from the persisted value at dispatch, before `session/prompt`.
- `ThreadDetail.desiredMode?: string | null`.

- [ ] **Step 1: Rust failing test** — `set_mode_before_run_persists_and_applies_on_next_mock_run`: call `set_mode` idle, dispatch against the mock, assert `RunRecord.mode == Some("architect")` and a `mode_change` event.
- [ ] **Step 2: Run it** — `cargo test --manifest-path src-tauri/Cargo.toml set_mode_before_run` → FAIL.
- [ ] **Step 3: Implement** persistence + apply-at-dispatch; a rejected mode logs `warn` and emits a notice, send still proceeds.
- [ ] **Step 4: Vitest** — mode picker on `/chat` remembers the choice; another thread keeps its own.
- [ ] **Step 5: Verify** — `cargo test --manifest-path src-tauri/Cargo.toml mode` and `pnpm vitest run tests/runs-store.test.ts && pnpm typecheck`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat(chat): remember session mode per thread before a run starts"`.

---

### Task 5: Thread management in the UI

**Files:**

- Modify: `src/components/chat/ChatHeader.tsx`, `src/components/layout/Sidebar.tsx`, `src/stores/threads.ts`, `src/stores/runs.ts`
- Test: `tests/threads.test.ts`, new `tests/thread-actions.test.tsx`

**Interfaces:**

- `useRunsStore.dropThreadState(threadId: string): void` removes `runsByThread`, its views and queue rows.
- ChatHeader: inline rename (trimmed, Esc cancels), actions Pin/Unpin, Snooze, Mark settled, Delete (two-step inline confirm, warns when `worktreeName` is set).
- Deleting the active thread: cancel live run, `threadsDelete`, `dropThreadState`, navigate `/chat`.
- `SHELF_TARGET.working` no longer accepts drops (`working` stays derived from run state).

- [ ] **Step 1: Failing tests** — delete removes thread + clears store + navigates; rename trims; `working` drop is ignored.
- [ ] **Step 2: Run** — `pnpm vitest run tests/threads.test.ts tests/thread-actions.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the controls; no `window.confirm` (use inline confirm state).
- [ ] **Step 4: Verify** — same command + `pnpm typecheck`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(sidebar): rename, pin, snooze, delete threads"`.

---

### Task 6: Honest navigation and labels

**Files:**

- Create: `src/lib/breadcrumbs.ts`
- Modify: `src/components/layout/Topbar.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/chat/ChatColumn.tsx`, `src/components/terminal/TerminalPanel.tsx`
- Test: `tests/breadcrumbs.test.ts`, `tests/e2e/smoke.spec.ts`

**Interfaces:**

- `resolveBreadcrumbs(pathname: string, threads: Array<{ id: string; title: string; workspace?: string | null }>): Array<{ label: string; to?: string }>` with the mappings: `/chat` → pult / New thread; `/thread/$id` → pult / thread title; `/pull-requests` → pult / Pull requests; `/settings/x` → pult / Settings / section; `/welcome` → pult / Setup.
- Sidebar "Add project" becomes an honest workspace menu (recent workspaces from threads → `/chat` with the field focused); TerminalPanel title uses the active terminal's title and the workspace folder name.

- [ ] **Step 1: Failing test** — mapping table for all five routes, asserting no static `pult / chat`.
- [ ] **Step 2: Run** — `pnpm vitest run tests/breadcrumbs.test.ts` → FAIL.
- [ ] **Step 3: Implement** and add the Playwright assertion on `/settings/keybindings`.
- [ ] **Step 4: Verify** — `pnpm vitest run tests/breadcrumbs.test.ts`, `pnpm typecheck`, `pnpm exec playwright test`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "fix(nav): route-aware breadcrumbs and honest labels"`.

---

### Task 7: External links really open (elicitation URL mode, PR links)

**Files:**

- Modify: `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`
- Modify: `src/components/chat/ElicitationModal.tsx`, `src/components/diff/DiffPanel.tsx`, `src/routes/pull-requests.tsx`
- Test: Rust unit test; `tests/elicitation-modal.test.tsx`

**Interfaces:**

- Rust: `pub fn validate_external_url(url: &str) -> Result<(), PultError>` (http/https only, non-empty, no control chars) and `pub fn open_external_url(url: String) -> Result<(), PultError>` which validates then launches the OS opener without a shell (`rundll32 url.dll,FileProtocolHandler <url>` / `open` / `xdg-open`).
- TS: `openExternalUrl(url: string): Promise<void>` (`window.open` fallback outside Tauri).
- `ElicitationModal`'s "Open URL" calls the opener first; on failure it shows an inline error and does not silently accept.

- [ ] **Step 1: Rust failing test** — accepts `https://example.com/auth?a=1`; rejects `file:///C:/Windows`, `javascript:alert(1)`, `""`.
- [ ] **Step 2: Run** — `cargo test --manifest-path src-tauri/Cargo.toml validate_external_url` → FAIL.
- [ ] **Step 3: Implement** Rust + TS wrapper; wire the three call sites.
- [ ] **Step 4: Vitest** — open button invokes the opener, error is surfaced.
- [ ] **Step 5: Verify** — Rust test + `pnpm vitest run tests/elicitation-modal.test.tsx && pnpm typecheck`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "fix(links): open elicitation and PR URLs in the system browser"`.

---

## Out of scope (M10/M11)

- Shiki code-splitting and syntax highlighting inside the diff panel; the >500 kB chunk warning.
- PR history persistence, `gh pr view` status, checkpoint/rollback UI, `config_options` pickers, tauri-specta bindings.
- In-app WebView OAuth sheet (M9 only fixes honest external opening).
- Composer key rebinding, per-thread panel widths, `/settings/projects`, live OpenCode verification, Windows signing / mac+Linux bundles.

## Definition of done

- `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy --all-targets -- -D warnings` green.
- Playwright smoke green, including the breadcrumb assertion.
- Live pass in the real window (WebView2 + mock agent): switch thread mid-run (no fake crash), Esc cancels a run, `/`→commit produces `/commit `, `@` lists workspace files, mode picked before a run is applied, rename/delete works, breadcrumbs match the route, "Open URL" opens the browser.
- `git status` clean apart from ignored artifacts; no `test-results/`, `dist/`, `target/`, `fixtures/mock-repo/` tracked.
