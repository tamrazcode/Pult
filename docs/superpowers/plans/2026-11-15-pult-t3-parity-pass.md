# Pult T3 Parity Pass

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Authorship & Execution Split:** **Gemini** authors the failing tests for each task (Step 1) and verifies failure (Step 2) before **DeepSeek** implements the production changes (Step 3) and runs verification (Step 4). **User-mandated execution protocol:** the plan is written first; then work proceeds one item at a time. Every item (including Tasks 17–24 and every later addition) is marked done only after Gemini has authored/updated its tests and those tests pass. Commit after each item, then continue without asking.

## Execution status (2026-11-15)

**Shipped:** 3 (bundled provider SVGs), 4 (startup bounded-parallel preflight + cache), 7 (Copy / Branch / HH:MM hover; Branch = real new thread + composer prefill), 8 (flat grouped tool/thought rows + “Working for Ns”), 9 (token line removed), 12 (neutral focus/selection/user bubble), 13 (icon-only footer, Search placeholder, hover tooltips foundation), 15 (optimistic user bubble), 17 (right-edge chevrons, tinted project badges), 18 (composer status line removed), 19 (provider tabs, model search, favorites, shortcuts, effort dots), 20 (queue rows + queue send icon), 21 (readable tool details), 22 (outside-click dismissal), 23 (larger app-icon mark), 24 (living theme-colored ASCII), 25 (General / Chat / Diffs / Projects settings pages), 26 (performance/size/freeze audit), 27 (Files surface: workspace tree, previews, in-chat links), 28 (file context menu + persisted editor choice), 29 (re-centered icon), 31 (Tab accepts slash/mention suggestions), plus 2’s Pull requests surface and 14’s provider pre-warm.

**Next:** all planned tasks are implemented; only acceptance polish remains (`Task 16`).

**Partial:** 1–2 (project card + Files/Diff/Terminal surfaces; project scripts and PR surface pending), 5–6 (ACP image blocks + tool-payload image rendering; live Codex fixture pending), 10 (editable/selection/link + existing thread menus; extended thread items pending), 11 (new empty state + flat composer; permission mode still in overflow), 25 (General/Chat/Projects pages; more real settings pages pending).

**Acceptance:** Task 16 remains open until the remaining partial items are taken or explicitly dropped. A freeze-hardening follow-up (historical event payload caps in `threads_get`, project-switch warmup disabled, image caps, smaller project-badge type) is implemented and verified against the user's 8 MB imagegen thread.

**Goal:** Bring `pult` substantially closer to T3 Code in daily ergonomics, visual polish, and responsiveness without rewriting the Tauri 2 + ACP architecture: add a T3-style Right Panel project card and `+` surface switcher, replace hand-drawn provider logos with real bundled SVG brand marks, run bounded-parallel startup provider preflight with cached instant display and warm reuse, project/persist/render agent-generated images (including Codex imagegen), add message hover Copy / Branch / `HH:MM` timestamps, flatten thinking/tool rows into grouped inline lines with live `"Working for Ns"`, strip the transcript token usage footer while keeping `/usage`, replace WebView default context menus app-wide with real custom menus, streamline the empty state and composer controls, neutralize loud focus/selection/bubble accents, convert sidebar footer + icon-only buttons to tooltipped compact controls, and pre-warm sessions + optimistic sends so warm first-token latency hits `<= 2s`.

**Architecture:** Sixteen focused, independently committable tasks (14 implementation tasks, 1 protocol spike, and 1 final acceptance pass) layered cleanly onto the existing Tauri 2 + React 19 + Zustand 5 + TanStack Router + Tailwind CSS v4 codebase:

- **Right Panel Surfaces & Project Card (Tasks 1–2):** Add `open_in_editor` IPC and persisted per-project scripts (`settings` key `project_scripts`), build a `ProjectCard` header inside `RightPanel` (project name, Open in editor, Add/run project script via PTY, git branch + publish state, uncommitted `+N -N`, previous agent/run counts), extract shared `PullRequestsList` from `/pull-requests`, generalize `RightPanelTab` + `rightPanelSurfaces` in `src/stores/ui.ts`, and add a `+` `"Open a surface"` menu for `Files`, `Diff`, `Terminal`, and `Pull requests`.
- **Real Provider Icons & Auto Preflight (Tasks 3–4):** Bundle compressed SVG brand marks (`claude`, `codex`, `gemini`, `opencode`, `fallback`) in `src/assets/providers/` with `LICENSES.md`, wire `ProviderLogo.tsx` and `src/routes/settings.providers.tsx`, persist preflight status + `checkedAt` in SQLite `settings`, run bounded-parallel startup preflight in `lib.rs` `.setup()`, and reuse live/warm connections for faster repeat checks.
- **Agent-Generated Images (Tasks 5–6):** Run a short spike against `codex-acp` / ACP schema to lock the exact imagegen wire shape and add a `mock-acp-agent.mjs` fixture; project `ContentBlock::Image`, `ResourceLink`, and `ToolCallContent` images into `EventKind::AgentImage` / `UserMessage.images`, resolve workspace-relative paths in `read_image_data_url` + `Markdown.tsx` `LocalImage`, and render zoomable inline images in `MessagesTimeline.tsx`.
- **Transcript UX & Timeline Flatness (Tasks 7–9):** Record `ts` on user/assistant items, implement transactional `threads_branch` in Rust SQLite + hover `Copy` / `Branch` / `HH:MM` in `MessagesTimeline.tsx`, remove `"Completed · Nk / Mk tokens"` from `FinishDivider` while keeping `/usage`, convert `ThoughtGroup` and `ToolRow` into borderless inline lines, group consecutive tool runs into expandable natural-language summaries, and add live `"Working for Ns"` streaming timers.
- **Context Menus, Composer, Neutral Theme & Tooltips (Tasks 10–13):** Suppress native WebView2 context menus globally in `__root.tsx`, add custom `ContextMenu` handlers for editable inputs (Cut/Copy/Paste/Select All), text selections (Copy), thread/project rows (including real `Filter by project`, skipping unsupported `Regenerate title`), and timeline messages; strip `asciiBackdrop()` and giant `PultLogo` from `NewChatEmptyState` (`"What should we work on?"`), make `ProviderModelPicker` and `ModePill` flat inline composer controls, neutralize `--focus-ring` / `::selection` / user bubble `bg-mention-bg`, and add a shared `Tooltip` component across all icon-only buttons plus `"Search"` placeholder and icon-only sidebar footer.
- **Turn Latency & Optimistic UI (Tasks 14–15):** Profile cold/warm latency with `scripts/perf-turn.mjs`, generalize `IdlePool` to support pre-warmed unassigned connections (`providers_warmup` at startup and provider switch) so a thread's very first turn hits a warm session (`<= 2s` first delta), and render optimistic user bubbles + instant `"Working for 0s"` on send.

**Tech Stack:** Tauri 2 (Rust, Tokio, `rusqlite`, `portable-pty`, `git` CLI), React 19, TypeScript (`strict: true`), Zustand 5, TanStack Router, Tailwind CSS v4, Vitest + Testing Library, `cargo test` / `cargo clippy`.

---

## Global Constraints

- **No production edits during planning; commit cleanly per task during execution:** Each task follows strict TDD: failing tests first -> verify failure -> minimal implementation -> verify all gates -> commit.
- **No new runtime dependencies unless essential:** `Tooltip`, `ContextMenu` extensions, `ProjectCard`, and SVG asset imports use existing React/Tailwind/Lucide/Vite primitives.
- **No remote runtime asset fetching:** Provider SVGs live locally under `src/assets/providers/` with a `LICENSES.md` attribution file; no CDN or runtime `<img src="https://...">`.
- **No dead controls:** Every surface, menu item, editor button, script runner, branch action, and tooltip must map to a real handler. Explicitly skip any T3 item lacking a real backend primitive (specifically `Regenerate title` in the thread context menu) and document why.
- **Strict TypeScript, Rust & test gates on every task:**
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- **Explicit test updates:** Whenever an existing test assertion breaks due to an intentional T3 parity change (e.g., removing `"Completed · …"` usage text, changing `"Search threads"` to `"Search"`, moving `ModePill` out of overflow, changing `RightPanel` active tab styling), update the test in the same task and document the reason in the task's Steps.

## Review Focus

1. **Right panel & project context resolution:** `RightPanel` must resolve project metadata cleanly both on `/thread/$threadId` (via `thread.projectId`) and `/chat` (via `projectsStore.selectedProjectId`), keep `DiffPanel` / `TerminalPanel` state intact across surface switches, and validate `open_in_editor` paths against canonical directories with no shell interpolation.
2. **Preflight boundedness & warm pool safety:** Startup preflight must never block `lib.rs` window creation, must bound concurrency (`<= 3`) and per-provider timeout (`20s`), and `IdlePool` pre-warmed slots must check `spawn_sig`, `instance_id`, `root`, `!conn.is_dead()`, and `IDLE_TTL` before reuse.
3. **Image sandbox & memory safety:** `read_image_data_url` must confine relative workspace paths via canonical `starts_with` inside the thread/project workspace (rejecting `..` escapes, UNC paths, and `> 20 MB` files), and inline base64 images must persist losslessly in SQLite `events`.
4. **Native context menu & selection preservation:** Capturing selection ranges _before_ rendering the custom `ContextMenu` prevents button focus from wiping `textarea.selectionStart`/`selectionEnd` or `window.getSelection()`.
5. **Warm latency & optimistic reconciliation:** Optimistic user turns in `useRunsStore` must never duplicate the real `user_message` event when `run:started` and `run:event` arrive, and must roll back cleanly on IPC error.

---

## Tasks

### Task 1: Right Panel project card, `open_in_editor` IPC, and project scripts

**Design Decision:** Store per-project custom scripts in the existing SQLite `settings` table under key `project_scripts` (`Record<string, ProjectScript[]>`) via `settings_get` / `settings_set` so zero SQLite schema migrations are required. Add a safe `open_in_editor` Rust command (canonical directory check, no shell interpolation, `CREATE_NO_WINDOW` on Windows, trying `code` -> `cursor` -> OS file explorer fallback). Clicking a script or adding a script opens/focuses the Terminal surface and runs it in a real PTY (`terminal_pty_create` + `terminal_pty_write` or direct `command` arg).

**Files:**

- Modify: `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/types.ts`, `src/components/layout/RightPanel.tsx`, `src/components/diff/DiffPanel.tsx`, `src/components/terminal/TerminalPanel.tsx`
- Create: `src/components/layout/ProjectCard.tsx`
- Create tests: `tests/right-panel-project-card.test.tsx`

**Interfaces:**

- `src-tauri/src/ipc/mod.rs`:
  ```rust
  #[tauri::command]
  pub fn open_in_editor(path: String, editor: Option<String>) -> Result<(), PultError>;
  ```
  - Validates `path` is non-empty, non-UNC (`!starts_with("\\\\")`), canonicalizes to an existing directory/file, strips `\\?\`, and spawns an allowed editor binary (`code`, `cursor`, `zed`, or OS opener `explorer.exe` / `open` / `xdg-open`) as direct argv without a shell.
- `src/lib/types.ts`:
  ```ts
  export interface ProjectScript {
    id: string;
    name: string;
    command: string;
  }
  ```
- `src/lib/ipc.ts`:
  ```ts
  export const openInEditor = (path: string, editor?: string) =>
    invoke<void>("open_in_editor", { path, editor });
  ```
- `src/components/layout/ProjectCard.tsx`:
  ```ts
  export function ProjectCard(props: { threadId: string | null }): ReactElement | null;
  ```
  - Resolves `project` from `activeThread.projectId` or `useProjectsStore.selectedProjectId`.
  - Displays: project color badge + `project.name`, **Open in editor** button (`openInEditor(workspacePath)`), **Add project script** button + popover (`name`, `command`) saving to `settingsSet("project_scripts", ...)` and runnable script chips (invoking `runProjectScript` which sets `rightPanelTab` to `"terminal"` and spawns a PTY running the script command in `TerminalPanel` / `useTerminalsStore`), **Git branch** + **publish state** (`status.upstream ? "Published" : "Local only"` + ahead/behind badge), **Changes Uncommitted** `+totalAdded -totalRemoved` button (switches to `"diff"` surface), and **Previous agents** counts (unique `instanceId` labels + total run count across `threads` belonging to `project.id`).

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/ipc/mod.rs` (`mod open_editor_tests`): test that `validate_editor_target` rejects empty paths, UNC paths (`\\server\share`), and missing paths, and accepts an existing temp directory.
  - In `tests/right-panel-project-card.test.tsx`:
    1. `"renders project name, branch, publish state, uncommitted +N -N, and previous agents count"` — seeds a project `"Alpha"`, active thread with `gitStatus` (`branch: "feat/ui"`, `upstream: null`), `gitDiffSummary` (`totalAdded: 14, totalRemoved: 3`), and 2 past runs (`claude-code`, `codex`); asserts `"Alpha"`, `"feat/ui"`, `"Local only"` (unpublished), `"+14"`, `"-3"`, and agent counts appear.
    2. `"calls openInEditor when Open in editor is clicked"` — clicks `"Open in editor"` and asserts `openInEditor` was called with the project/thread workspace path.
    3. `"saves and runs a project script in Terminal"` — clicks `"Add project script"`, submits name `"Test"` and command `"pnpm test"`, verifies `settingsSet("project_scripts", ...)` is called, clicks the new `"Test"` script chip, and asserts `rightPanelTab === "terminal"` and `terminalPtyCreate` is invoked with `command`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/right-panel-project-card.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml open_editor_tests` → FAIL (`ProjectCard` and `open_in_editor` do not exist).
- [ ] **Step 3: Implement backend `open_in_editor` + `ProjectCard` and wire into `RightPanel` (DeepSeek)**
  - Implement `validate_editor_target` and `open_in_editor` in `src-tauri/src/ipc/mod.rs`, register in `src-tauri/src/lib.rs`.
  - Add `ProjectScript` and `openInEditor` in `src/lib/types.ts` / `src/lib/ipc.ts`.
  - Create `src/components/layout/ProjectCard.tsx` and render `<ProjectCard threadId={activeThreadId} />` above the tabs/surfaces in `src/components/layout/RightPanel.tsx`.
  - Ensure `DiffPanel.tsx` uses `useGitStore` summary updates already synced with `ProjectCard`, and `TerminalPanel.tsx` picks up any pending/created PTY from `useTerminalsStore`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(right-panel): add T3 project card, open-in-editor IPC, and project scripts`

---

### Task 2: Generalize Right Panel surface model (`+` Open a surface menu + Pull Requests surface)

**Design Decision:** Replace the fixed 3-tab list in `RightPanel.tsx` with a composable open-surface list in `useUiStore` (`rightPanelSurfaces: RightPanelTab[]`) where `RightPanelTab = "diff" | "files" | "terminal" | "pull-requests"`. Extract `PullRequestsList` from `src/routes/pull-requests.tsx` so the `"pull-requests"` surface renders real PR history (matching `/pull-requests`), and add a `+` (`aria-label="Open a surface"`) menu listing only the 4 real surfaces (`Files`, `Diff`, `Terminal`, `Pull requests`). Keep `DiffPanel` and `TerminalPanel` intact. Wire `Mod+Alt+1..4` or command-palette surface commands cleanly in `src/lib/commands.ts` and ensure `__root.tsx` passes layout resize cleanly.

**Files:**

- Create: `src/components/git/PullRequestsList.tsx`
- Modify: `src/routes/pull-requests.tsx`, `src/stores/ui.ts`, `src/components/layout/RightPanel.tsx`, `src/routes/__root.tsx`, `src/lib/commands.ts`
- Modify tests: `tests/ui-store.test.ts`, `tests/shell-layout.test.tsx`

**Interfaces:**

- `src/stores/ui.ts`:
  ```ts
  export type RightPanelTab = "diff" | "files" | "terminal" | "pull-requests";

  // In UiState:
  rightPanelSurfaces: RightPanelTab[]; // default: ["diff", "files", "terminal"]
  openRightPanelSurface: (surface: RightPanelTab) => void;
  closeRightPanelSurface: (surface: RightPanelTab) => void;
  ```
  - `setRightPanelTab(tab)` adds `tab` to `rightPanelSurfaces` if missing, selects it, and sets `rightPanelOpen: true`.
  - `closeRightPanelSurface(surface)`: removes `surface`; if it was active, selects the adjacent remaining surface; if none remain, closes `rightPanelOpen` and resets `rightPanelSurfaces` to `[surface]` or keeps default `["diff"]`.
- `src/components/layout/RightPanel.tsx`:
  - Renders tab buttons for `rightPanelSurfaces` plus a `+` button (`aria-label="Open a surface"`, `aria-haspopup="menu"`) opening `[data-escape-layer]` menu with items: `Files`, `Diff`, `Terminal`, `Pull requests`. Clicking an item calls `openRightPanelSurface(id)`.

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/ui-store.test.ts`: test `openRightPanelSurface("pull-requests")` adds `"pull-requests"` to `rightPanelSurfaces`, activates it, and opens `rightPanelOpen`; test `closeRightPanelSurface("terminal")` removes it and falls back to remaining surface.
  - In `tests/shell-layout.test.tsx`:
    - Add test `"opens Pull requests surface from the RightPanel '+' Open a surface menu"` — renders `<RightPanel width={420} />` with seeded `useGitStore.prHistory`, clicks button `aria-label="Open a surface"`, asserts menu lists `"Files"`, `"Diff"`, `"Terminal"`, `"Pull requests"` (no inert placeholder items), clicks `"Pull requests"`, and asserts the PR item renders inside `RightPanel`.
    - Keep/adjust existing `RightPanel` active-tab assertion to work alongside open tabs and `+` button (`getByRole("button", { name: /^diff$/i })` etc.).
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/ui-store.test.ts tests/shell-layout.test.tsx` → FAIL (`openRightPanelSurface` and `"Open a surface"` menu do not exist).
- [ ] **Step 3: Implement shared `PullRequestsList`, generalized `ui.ts` surfaces, and `RightPanel` `+` menu (DeepSeek)**
  - Create `src/components/git/PullRequestsList.tsx` and use it in both `src/routes/pull-requests.tsx` and `src/components/layout/RightPanel.tsx`.
  - Update `src/stores/ui.ts`, `src/components/layout/RightPanel.tsx`, `src/lib/commands.ts` (add `view.panel.files` and `view.panel.prs`), and verify `__root.tsx` handles right-panel width/auto-collapse seamlessly.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(right-panel): generalize surface tabs and add Open a surface menu with Pull requests`

---

### Task 3: Real bundled Provider Icons (`src/assets/providers/`) + Providers Settings

**Design Decision:** Replace the hand-drawn placeholder SVGs in `ProviderLogo.tsx` with actual official / Simple Icons / LobeHub brand SVGs stored locally under `src/assets/providers/` (`claude.svg`, `codex.svg`, `gemini.svg`, `opencode.svg`, `fallback.svg`) with `src/assets/providers/LICENSES.md` crediting upstream sources/licenses (MIT / Apache-2.0 / CC0 as applicable). Import them locally at build time (`?raw` or Vite asset URLs — use clean Vite `?raw` or static local asset `<img>` + `currentColor` monochrome handling for OpenAI Codex/fallback so theme contrast is preserved in Dark, Light, Graphite, and Liquid themes with zero runtime remote requests). Also display `<ProviderLogo instance={info} />` in `src/routes/settings.providers.tsx` list rows and detail header.

**Files:**

- Create: `src/assets/providers/claude.svg`, `src/assets/providers/codex.svg`, `src/assets/providers/gemini.svg`, `src/assets/providers/opencode.svg`, `src/assets/providers/fallback.svg`, `src/assets/providers/LICENSES.md`
- Modify: `src/components/chat/ProviderLogo.tsx`, `src/routes/settings.providers.tsx`
- Modify/Create tests: `tests/composer.test.tsx`, `tests/provider-logo.test.tsx`

**Interfaces:**

- `src/components/chat/ProviderLogo.tsx`:
  ```ts
  export type ProviderBrand = "claude" | "codex" | "gemini" | "opencode" | "mock" | "custom";
  export function detectProviderBrand(
    inst: Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args">,
  ): ProviderBrand;
  export function ProviderLogo(props: {
    instance:
      Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args"> | null | undefined;
    className?: string;
  }): ReactElement;
  ```
  - Renders an element carrying `data-provider-logo={brand}` backed by the local asset under `src/assets/providers/`.

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - Create `tests/provider-logo.test.tsx`:
    1. Asserts `src/assets/providers/` contains `claude.svg`, `codex.svg`, `gemini.svg`, `opencode.svg`, `fallback.svg`, and `LICENSES.md` (via `node:fs` check), and no SVG contains external `<image href="http...">` or `<script>`.
    2. Asserts `detectProviderBrand` maps `"claude-code"` / `"@zed-industries/claude-code-acp"` -> `"claude"`, `"codex"` / `"openai"` / `"@agentclientprotocol/codex-acp"` -> `"codex"`, `"gemini-cli"` / `"antigravity"` -> `"gemini"`, `"opencode"` -> `"opencode"`, `"mock"` -> `"mock"`, and unknown CLI -> `"custom"`.
    3. Renders `<ProviderLogo />` for each brand and verifies `data-provider-logo` and rendered `<img>` / `<svg>` has no remote `https://` URL.
    4. Renders `ProvidersSettings` (or list row helper) with seeded instances and asserts `data-provider-logo="claude"` / `"codex"` renders in the provider list and detail panel.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/provider-logo.test.tsx` → FAIL (`src/assets/providers/` files do not exist and `settings.providers.tsx` does not render `ProviderLogo`).
- [ ] **Step 3: Fetch/save compressed brand SVGs locally and wire `ProviderLogo` + `settings.providers.tsx` (DeepSeek)**
  - Fetch official / `@lobehub/icons` / `simple-icons` SVGs for Anthropic/Claude, OpenAI Codex, Google Gemini, OpenCode, and a neutral cube/terminal fallback; optimize/compress SVGs cleanly into `src/assets/providers/*.svg` and document licenses in `src/assets/providers/LICENSES.md`.
  - Update `src/components/chat/ProviderLogo.tsx` to render from the local assets (`?raw` sanitized SVG or static local asset `<img>` with neutral tint support) and update `src/routes/settings.providers.tsx` list items and detail card header to render `<ProviderLogo instance={info} />`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(providers): bundle real local SVG provider brand marks and render in settings`

---

### Task 4: Startup auto-preflight checks, cached status/timestamps, and fast warm re-checks

**Design Decision:** Persist preflight results (`CachedPreflightEntry` with `checkedAt`, `agentVersion`, `authRequired`, `authHint`, capabilities, options, modes) in SQLite `settings` (`"provider_preflight_cache"`) so `AgentRuntime::new()` loads cached state immediately on boot without waiting for child processes. In `src-tauri/src/lib.rs` `.setup()`, spawn a background task calling `AgentRuntime::preflight_startup(runtime)` that probes enabled instances (bounded concurrency `3` via `tokio::sync::Semaphore`, per-provider timeout `20s`) and emits `"agent:caps"` + `"agent:process"` as each finishes. For repeat checks (`providers_preflight`), check if a live warm connection for that `instance_id` already exists in `IdlePool` (or warm standby slot) and reuse/refresh its capabilities without respawning unless `force` or the connection is dead; after a fresh handshake, park an unassigned warm connection when appropriate.

**Files:**

- Modify: `src-tauri/src/runtime/mod.rs`, `src-tauri/src/runtime/pool.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts`, `src/routes/settings.providers.tsx`
- Modify/Create tests: `tests/provider-signin.test.tsx`, `src-tauri/src/runtime/tests.rs` (or inline module tests in `runtime/mod.rs`)

**Interfaces:**

- `src-tauri/src/runtime/mod.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct CachedPreflightEntry {
      pub status: String,
      pub auth_required: bool,
      pub auth_hint: Option<String>,
      pub agent_version: Option<String>,
      pub prompt_image: bool,
      pub load_session: bool,
      pub modes: Vec<crate::protocol::types::SessionMode>,
      pub config_options: Vec<SessionConfigOption>,
      pub auth_methods: Vec<crate::protocol::types::AuthMethod>,
      pub checked_at: i64,
  }
  ```
  - Add `pub checked_at: Option<i64>` and `pub agent_version: Option<String>` to `InstanceInfo` and `checked_at: i64` to `PreflightReport`.
  - Add `pub async fn preflight_startup(runtime: Arc<AgentRuntime>)` using `tokio::sync::Semaphore::new(3)` + `tokio::time::timeout(Duration::from_secs(20), ...)`.
  - Add `force: Option<bool>` parameter on `providers_preflight(instance_id, force)` (defaults to `false`): if `!force` and a live warm connection exists in `pool` for `(instance_id, global_root)`, return fast warm report (`< 50ms`) without killing/respawning.
- `src/lib/types.ts`: add `checkedAt?: number | null` and `agentVersion?: string | null` to `InstanceInfo` and `checkedAt?: number` to `PreflightReport`.
- `src/routes/settings.providers.tsx`:
  - `statusLine(...)` formats `"Checked Xm ago"` (or `"Just now"`) from `report?.checkedAt ?? info.checkedAt` alongside `"Connected · <version>"` and shows cached status immediately on mount while `"Checking connection…"` runs in background (`refreshing` badge if cached state already exists).

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In Rust (`src-tauri/src/runtime/tests.rs` / `runtime/mod.rs`):
    1. `startup_loads_cached_preflight_immediately_without_spawning`: pre-seeds `provider_preflight_cache` in in-memory `Store`, creates `AgentRuntime::new()`, asserts `runtime.instances()` immediately reports `prompt_image`, `config_options`, `checked_at`, and `status` before any preflight runs.
    2. `preflight_startup_runs_enabled_only_and_persists_cache`: configures one enabled mock + one disabled bogus command, runs `preflight_startup`, asserts disabled instance is skipped, mock succeeds, and `store.get_setting("provider_preflight_cache")` is populated with `checkedAt > 0`.
    3. `repeat_preflight_reuses_warm_connection_fast`: runs `preflight("mock")` twice; asserts the second call reuses warm state without spawning a fresh process when `force` is false.
  - In `tests/provider-signin.test.tsx`: add unit test for `statusLine` verifying cached `checkedAt` timestamp renders immediately (`"Connected · …"`) even before a fresh `PreflightReport` arrives.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib preflight` and `pnpm test tests/provider-signin.test.tsx` → FAIL.
- [ ] **Step 3: Implement cached preflight, startup bounded-parallel probe, warm check, and Settings timestamp UI (DeepSeek)**
  - Implement cache load/save, `preflight_startup`, warm preflight reuse, and `checked_at` / `agent_version` fields in `src-tauri/src/runtime/mod.rs`, `pool.rs`, `ipc/mod.rs`, and spawn `preflight_startup` in `src-tauri/src/lib.rs` `.setup(...)`.
  - Update `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts` (apply `checkedAt`/`agentVersion` from `"agent:caps"`), and `src/routes/settings.providers.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(providers): add cached startup preflight checks and warm connection reuse`

---

### Task 5: Spike — Confirm Codex (`codex-acp`) imagegen wire shape and add fixture

**Design Decision:** Before changing `EventKind` or UI projection, run a short verification spike to confirm the exact ACP wire JSON emitted by `@agentclientprotocol/codex-acp` (and `src-tauri/src/protocol/types.rs`) when Codex produces an image (`AgentMessageChunk` `ContentBlock::Image`, `ToolCallUpdate` `ToolCallContent::Content`, or workspace file path / `ResourceLink`). Capture the exact schema in `fixtures/mock-acp-agent.mjs` and document the finding in `DEVLOG.md`.

**Files:**

- Inspect: `src-tauri/src/protocol/types.rs`, installed `@agentclientprotocol/codex-acp` package / `codex` binary output or schema
- Modify: `fixtures/mock-acp-agent.mjs`, `DEVLOG.md`

**Steps:**

- [ ] **Step 1: Inspect `codex-acp` schema / run a minimal imagegen probe (Gemini / DeepSeek)**
  - Check `src-tauri/src/protocol/types.rs` (`ContentBlock`, `ToolCallContent`) and inspect `@agentclientprotocol/codex-acp` JS/TS bundle (via `npx -y @agentclientprotocol/codex-acp --help` / local npm cache or running one minimal `session/prompt` fixture probe) to confirm whether Codex emits `session/update` with:
    - `agent_message_chunk` containing `{ "type": "image", "data": "...", "mimeType": "image/png" }`, OR
    - `tool_call_update` containing `content: [{ "type": "content", "content": { "type": "image", ... } }]`, OR
    - workspace image file + markdown/resource link.
- [ ] **Step 2: Record confirmed shape in `DEVLOG.md` and add deterministic scenario to `fixtures/mock-acp-agent.mjs`**
  - Add a prompt keyword trigger (e.g. `MOCK_IMAGE` / `"generate image"`) in `fixtures/mock-acp-agent.mjs` emitting the exact confirmed ACP image chunk (plus a tool-embedded image case if supported by ACP `ToolCallContent`).
- [ ] **Step 3: Commit**
  - `chore(spike): document codex-acp imagegen wire shape and add mock fixture scenario`

---

### Task 6: Project, persist, and render agent-generated images + workspace-relative `LocalImage`

**Design Decision:** Never drop `ContentBlock::Image` or image `ResourceLink` in `drivers/acp.rs`. Emit `EventKind::AgentImage` (persisted as JSON in SQLite `events` just like all `EventKind` variants), populate `UserMessage.images` from `UserMessageChunk`, and extract embedded images from `ToolCallUpdate` `content` (`ToolCallContent::Content { content: ContentBlock::Image }`) when present. On the frontend, render `AgentImageChatItem` inline inside `MessagesTimeline.tsx` with click-to-zoom lightbox + Open/Copy, and extend `read_image_data_url` + `Markdown.tsx` `LocalImage` to resolve workspace-relative image paths (e.g. `generated/chart.png`) cleanly via the active thread's workspace.

**Files:**

- Modify: `src-tauri/src/events.rs`, `src-tauri/src/drivers/acp.rs`, `src-tauri/src/ipc/mod.rs`, `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/runs.ts`, `src/components/chat/MessagesTimeline.tsx`, `src/components/chat/Markdown.tsx`
- Modify/Create tests: `tests/runs-reducer.test.ts`, `tests/messages-timeline.test.tsx`, `tests/markdown.test.tsx`

**Interfaces:**

- `src-tauri/src/events.rs`:
  ```rust
  AgentImage {
      data: Option<String>,
      mime_type: String,
      path: Option<String>,
      alt: Option<String>,
  },
  ```
- `src-tauri/src/ipc/mod.rs`:
  ```rust
  #[tauri::command]
  pub async fn read_image_data_url(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      path: String,
      thread_id: Option<String>,
  ) -> Result<String, PultError>
  ```
  - If `path` is relative, resolves against `thread_git_dir(&runtime, &tid)` (or `global_workspace_root()`) before canonicalize + workspace containment check (still rejecting UNC paths, `..` traversal outside roots, and `> 20 MB`).
- `src/stores/runs.ts`:
  ```ts
  export interface AgentImageChatItem {
    type: "agent_image";
    data?: string;
    mimeType: string;
    path?: string;
    alt?: string;
  }
  ```
  - Add `"agent_image"` case in `applyRunEvent` and also extract image blocks from `tool_call_update` `content` arrays (`item.type === "content" && item.content?.type === "image"` -> append `AgentImageChatItem` or expose on `ToolRow`).
- `src/components/chat/Markdown.tsx`:
  - Accept optional `workspaceThreadId?: string` prop on `<Markdown />` (or `MarkdownThreadContext`) so `LocalImage` resolves relative paths (`!/^(?:https?:|data:|blob:)/i.test(src)`) via `readImageDataUrl(path, threadId)`.

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/drivers/acp.rs` (`mod tests`): test `project_update` maps `SessionUpdate::AgentMessageChunk` with `ContentBlock::Image` to `EventKind::AgentImage`, `SessionUpdate::UserMessageChunk` with `ContentBlock::Image` to `EventKind::UserMessage { images: [...] }`, and `ToolCallUpdate` with embedded `ToolCallContent::Content` `Image` yields image projection.
  - In `src-tauri/src/ipc/mod.rs` (`mod image_tests`): test relative path resolution inside a temp workspace passes while `../secret.png` traversal fails.
  - In `tests/runs-reducer.test.ts`: test `applyRunEvent` handles `agent_image` and persists it into `view.items`.
  - In `tests/messages-timeline.test.tsx`: test `AgentImageChatItem` renders an `<img>` (`data:image/png;base64,...`) and clicking opens a zoom lightbox dialog (`[data-escape-layer]`, closable with `Escape` or Close button).
  - In `tests/markdown.test.tsx`: mock `readImageDataUrl`, render `<Markdown text="![chart](out/chart.png)" />` with active thread context, assert `readImageDataUrl("out/chart.png", ...)` is called and renders the returned `data:image/png;base64,...` image.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib projection` and `pnpm test tests/runs-reducer.test.ts tests/messages-timeline.test.tsx tests/markdown.test.tsx` → FAIL.
- [ ] **Step 3: Implement Rust image projection/resolution and frontend rendering + lightbox (DeepSeek)**
  - Update `src-tauri/src/events.rs`, `src-tauri/src/drivers/acp.rs`, `src-tauri/src/ipc/mod.rs`.
  - Update `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/runs.ts`, `src/components/chat/Markdown.tsx`, and `src/components/chat/MessagesTimeline.tsx` (inline image thumbnail + zoom lightbox modal with `data-escape-layer` and open/copy actions).
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(images): project, persist, and render agent-generated and workspace-relative images`

---

### Task 7: Message timestamps, hover actions (`Copy`, `Branch`), and transactional `threads_branch`

**Design Decision:** Implement real branching cleanly without dead controls: add `threads_branch(source_thread_id, up_to_ts)` in Rust SQLite that creates a new thread in the same `project_id` and `workspace` (or creates a worktree if `project.worktree_strategy == "worktree"`), titled `"Branch: <source title>"`, and copies `runs` + `events` with `ts <= up_to_ts` (inclusive of that message's event span) in a single transaction. On the frontend, record `ts?: number` on `UserChatItem` and `AssistantChatItem` inside `applyRunEvent` so every user and assistant row displays a subtle hover toolbar with `HH:MM`, **Copy**, and **Branch**.

**Files:**

- Modify: `src-tauri/src/store/threads.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/stores/threads.ts`, `src/stores/runs.ts`, `src/components/chat/MessagesTimeline.tsx`
- Modify tests: `tests/runs-reducer.test.ts`, `tests/messages-timeline.test.tsx`, `tests/threads.test.ts`

**Interfaces:**

- `src-tauri/src/store/threads.rs`:
  ```rust
  pub fn branch_thread(
      &self,
      source_thread_id: &str,
      new_id: &str,
      new_title: &str,
      new_workspace: Option<&str>,
      new_main_repo: Option<&str>,
      new_worktree_name: Option<&str>,
      up_to_ts: Option<i64>,
  ) -> Result<ThreadRecord, PultError>;
  ```
- `src-tauri/src/ipc/mod.rs`:
  ```rust
  #[tauri::command]
  pub async fn threads_branch(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: String,
      up_to_ts: Option<i64>,
  ) -> Result<ThreadRecord, PultError>;
  ```
- `src/stores/runs.ts`:
  - Add `ts?: number` to `UserChatItem` and `AssistantChatItem` (populated from `event.ts` in `applyRunEvent`).
- `src/stores/threads.ts`:
  - Add `branchThread: (sourceThreadId: string, upToTs?: number) => Promise<Thread>`.
- `src/components/chat/MessagesTimeline.tsx`:
  - Add `formatMessageTime(ts?: number): string` (`HH:MM` 24h local time, e.g. `"14:05"`).
  - Add `MessageHoverActions` (`group` + `opacity-0 group-hover:opacity-100 focus-within:opacity-100`) on `UserRow` and `TextRow` with `HH:MM`, `Copy` button (writes `text` to `navigator.clipboard`), and `Branch` button (calls `useThreadsStore.getState().branchThread(threadId, ts)` and navigates to `/thread/$threadId`).

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/store/tests.rs` (or `threads.rs` tests): test `branch_thread` copies runs and events with `e.ts <= up_to_ts` into a brand-new thread in the same project, assigns fresh run/event ids so FKs & unique `(run_id, seq)` constraints pass, and omits later events.
  - In `tests/runs-reducer.test.ts`: assert `user_message` and `agent_message_delta` preserve `ts` on `UserChatItem` and `AssistantChatItem` (update the existing exact `.toEqual` checks at lines 93 and 175 to include `ts: 1_700_000_000_000` with explicit reason: timestamps are now captured on message items for hover time display & branching).
  - In `tests/messages-timeline.test.tsx`: test hover actions on both `UserRow` and `TextRow` render `HH:MM`, clicking **Copy** writes message text to `navigator.clipboard.writeText`, and clicking **Branch** calls `threadsBranch(threadId, ts)` and navigates to `/thread/<newId>`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib branch_thread` and `pnpm test tests/runs-reducer.test.ts tests/messages-timeline.test.tsx` → FAIL.
- [ ] **Step 3: Implement `branch_thread`, `threads_branch` IPC, `ts` capture, and hover Copy/Branch UI (DeepSeek)**
  - Implement transactional `branch_thread` in `src-tauri/src/store/threads.rs`, `threads_branch` in `src-tauri/src/ipc/mod.rs`, register in `src-tauri/src/lib.rs`.
  - Update `src/lib/ipc.ts`, `src/stores/threads.ts`, `src/stores/runs.ts`, and `src/components/chat/MessagesTimeline.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(timeline): add message timestamps and hover Copy/Branch actions with backend thread branching`

---

### Task 8: Plain inline thinking/tool rows, grouped consecutive tool calls, and `"Working for Ns"`

**Design Decision:** Keep `useRunsStore`'s flat `items: ChatItem[]` reducer clean and perform consecutive tool-call grouping at the timeline presentation layer via a pure exported helper `groupTimelineEntries(entries)` in `MessagesTimeline.tsx`. That preserves memoized prior-run rendering and keeps reducer tests untouched. Group 2+ consecutive `tool` entries into one expandable summary line (e.g. `"Searched code 6 times and read 2 files"`). Remove `border` and `bg-surface` cards from `ThoughtGroup`, `ToolRow`, and `ToolGroupRow` so they render as quiet inline lines with small icon + muted text, expandable on click. Add a 1-second `useElapsedSeconds` hook for live `"Working for Ns"` and `"Thinking for Ns"` status while streaming.

**Files:**

- Modify: `src/components/chat/MessagesTimeline.tsx`
- Modify tests: `tests/messages-timeline.test.tsx`

**Interfaces:**

- `src/components/chat/MessagesTimeline.tsx`:
  ```ts
  export type TimelineRenderBlock =
    | { kind: "item"; entry: TimelineEntry }
    | { kind: "tool_group"; key: string; entries: TimelineEntry[] };

  export function groupTimelineEntries(entries: TimelineEntry[]): TimelineRenderBlock[];
  export function formatToolGroupSummary(items: ToolChatItem[]): string;
  ```
  - `formatToolGroupSummary` counts by tool `kind` (`search` -> `"searched code"`, `read` -> `"read"`, `edit` -> `"edited"`, `execute` -> `"ran"`, `fetch` -> `"fetched"`, `delete` -> `"deleted"`, `move` -> `"moved"`, fallback -> `"ran tool"`), producing natural pluralized phrases joined with `", "` and `" and "` (e.g., `"Searched code 6 times and read 2 files"`).

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/messages-timeline.test.tsx`:
    1. `"formats and groups consecutive tool calls into one expandable summary line"` — asserts `formatToolGroupSummary` formats 6 `search` + 2 `read` tools as `"Searched code 6 times and read 2 files"`, renders a run with 6 search + 2 read tool items, asserts the summary line is visible and individual tool titles are collapsed until clicked, then expanding reveals all 8 inline tool rows.
    2. `"renders thinking and tool rows as plain inline lines without bordered surface cards"` — asserts `ThoughtGroup` and `ToolRow` wrappers do not have `border` or `bg-surface` classes.
    3. `"displays live 'Working for Ns' status while streaming"` — renders a streaming run (`startedAt` 4s ago, `entries.length === 0` or streaming tail), asserts `"Working for"` with seconds ticks forward under fake timers.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/messages-timeline.test.tsx` → FAIL (`groupTimelineEntries`, `formatToolGroupSummary`, inline styles, and `"Working for Ns"` do not exist).
- [ ] **Step 3: Implement flat inline rows, tool grouping, and live elapsed timer (DeepSeek)**
  - Export and implement `groupTimelineEntries`, `formatToolGroupSummary`, `ToolGroupRow`, flat `ThoughtGroup` & `ToolRow`, and `"Working for Ns"` live ticker in `src/components/chat/MessagesTimeline.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(timeline): flatten thinking/tool rows, group consecutive tools, and show Working for Ns`

---

### Task 9: Remove transcript token usage text from `FinishDivider` (keep `/usage`)

**Design Decision:** Remove `usageLine(usage)` rendering from `FinishDivider` in `src/components/chat/MessagesTimeline.tsx` so finished turns render only the clean stop-reason label (e.g., `"Completed"`) without `"Completed · 12.3k / 200k tokens"`. Keep `usageLine` in `src/stores/runs.ts` and the `/usage` route (`src/routes/usage.tsx`) completely intact.

**Files:**

- Modify: `src/components/chat/MessagesTimeline.tsx`
- Modify tests: `tests/messages-timeline.test.tsx`

**Steps:**

- [ ] **Step 1: Write failing test (Gemini)**
  - In `tests/messages-timeline.test.tsx`: add `"omits token usage string from FinishDivider while keeping stop reason label"` — renders a finished run with `stopReason: "end_turn"` and `usage: { used: 12300, size: 200000 }`, asserts `"Completed"` is visible and `/12\.3k|200k|tokens/i` is NOT in the document.
- [ ] **Step 2: Run test to verify failure (Gemini)**
  - Run `pnpm test tests/messages-timeline.test.tsx` → FAIL (`"Completed · 12.3k / 200k tokens"` currently renders).
- [ ] **Step 3: Remove usage text from `FinishDivider` (DeepSeek)**
  - Remove `usage` prop / `usageLine` call from `FinishDivider` in `src/components/chat/MessagesTimeline.tsx` (and remove unused `usageLine` import from `MessagesTimeline.tsx`). Keep `src/routes/usage.tsx` and `usageLine` in `src/stores/runs.ts` untouched.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `fix(timeline): remove token usage string from FinishDivider while preserving /usage`

---

### Task 10: App-wide custom Context Menus (disable native menu, editable/selection, thread/project/message)

**Design Decision:** Register a global `contextmenu` listener in `src/routes/__root.tsx` that calls `e.preventDefault()` everywhere so the native Tauri/WebView2 right-click menu never appears. When an element handles its own domain menu (`Sidebar` project/thread rows, `MessagesTimeline` message rows), it opens a global or local `ContextMenu` and calls `e.stopPropagation()` (or sets a flag). Otherwise, our global context menu handler inspects:

1. Editable target (`HTMLInputElement`, `HTMLTextAreaElement`, `[contenteditable="true"]`): captures selection range `{ start, end }` _before_ menu mount and opens `ContextMenu` with **Cut**, **Copy**, **Paste**, separator, **Select All** (using clipboard API + `setRangeText` + synthetic `input` event for React controlled inputs).
2. Non-editable non-empty text selection (`window.getSelection()?.toString()`): opens `ContextMenu` with **Copy**.
3. For thread rows in `Sidebar.tsx`: keep real `Pin`/`Unpin`, `Settle`, `Snooze`, `Rename`, `Mark unread`, `Copy path`, `Project settings`, `Archive`, `Delete`, and add real **`Filter by project`** (toggles `projectFilterId` filter in `Sidebar.tsx` with a clearable filter pill in the sidebar filter strip). **Explicitly skip `Regenerate title`** because ACP has no standalone stateless title-regeneration endpoint (no dead/fake control).
4. Add right-click `ContextMenu` on `UserRow` and `TextRow` in `MessagesTimeline.tsx` (`Copy`, `Branch`).

**Files:**

- Create: `src/lib/contextMenu.ts`
- Modify: `src/routes/__root.tsx`, `src/components/ui/ContextMenu.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/chat/MessagesTimeline.tsx`
- Modify tests: `tests/context-menu.test.tsx`, `tests/sidebar.test.tsx`, `tests/messages-timeline.test.tsx`

**Interfaces:**

- `src/lib/contextMenu.ts`:
  ```ts
  export type GlobalMenuState = {
    x: number;
    y: number;
    items: Array<ContextMenuItem | "separator">;
  } | null;

  export function buildEditableMenuItems(
    el: HTMLInputElement | HTMLTextAreaElement,
    selection: { start: number; end: number; text: string },
  ): Array<ContextMenuItem | "separator">;

  export function buildSelectionMenuItems(
    selectedText: string,
  ): Array<ContextMenuItem | "separator">;
  ```

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/context-menu.test.tsx`:
    1. `"suppresses native contextmenu and opens Cut/Copy/Paste/Select All menu on editable textarea"` — renders global context-menu provider + `<textarea>` with `"hello world"`, selects `"world"`, dispatches `contextmenu` event, asserts `event.defaultPrevented === true`, asserts `Cut`, `Copy`, `Paste`, `Select All` menuitems render; tests `Copy` writes `"world"` and `Select All` selects full string.
    2. `"opens Copy-only context menu when non-editable text is selected"` — mocks `window.getSelection` returning `"selected snippet"`, fires `contextmenu` on non-editable text, asserts `Copy` menuitem renders and writes `"selected snippet"`.
  - In `tests/sidebar.test.tsx`:
    - Update the thread context menu list assertion (`tests/sidebar.test.tsx:443`) to include `"Filter by project"` (between `"Mark unread"` and `"Copy path"`), with explicit reason: real `Filter by project` action added for T3 thread menu parity while `Regenerate title` is skipped as unsupported. Add test clicking `"Filter by project"` filters the sidebar list to only that project's threads and shows a clearable badge.
  - In `tests/messages-timeline.test.tsx`:
    - Add test `"opens custom Copy/Branch context menu on right-clicking a message row"`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/context-menu.test.tsx tests/sidebar.test.tsx tests/messages-timeline.test.tsx` → FAIL.
- [ ] **Step 3: Implement global menu suppression, editable/selection menus, `Filter by project`, and message context menu (DeepSeek)**
  - Create `src/lib/contextMenu.ts`, mount the global capture/bubble `contextmenu` handler + `<ContextMenu>` in `src/routes/__root.tsx` (and export `<GlobalContextMenuHost />` for clean testing).
  - Add `projectFilterId` + `"Filter by project"` to `src/components/layout/Sidebar.tsx`.
  - Add right-click `ContextMenu` on `UserRow`/`TextRow` in `src/components/chat/MessagesTimeline.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(ui): replace native context menu app-wide with custom editable, selection, thread, and message menus`

---

### Task 11: Streamlined Empty State (`"What should we work on?"`) & inline flat Composer controls

**Design Decision:** Match T3 Code's quiet centered empty state and minimal bottom composer bar:

- In `NewChatEmptyState.tsx`: delete the large `<PultLogo />`; keep `asciiBackdrop()` as the live background (upgraded by Task 24); render `"What should we work on?"` with active project context subtitle (e.g. `Alpha · C:\work\alpha` or `"Select a project or start typing."`).
- In `ComposerControls.tsx` & `Composer.tsx`: strip the pill border/background (`border border-border-subtle bg-surface`) off `ProviderModelPicker` so `[ProviderLogo] Model Reasoning ▾` reads as one flat inline line; promote `ModePill` (`"Full access"` / `"Supervised"` / `"Auto edits"` with `ShieldCheck` icon) directly into the composer bottom bar as a flat inline trigger; keep `AgentModePicker` + remaining non-model/non-reasoning options in `ComposerOverflowMenu`, hiding the `⋯` overflow trigger whenever it has 0 items. Confirm zero microphone control exists.

**Files:**

- Modify: `src/components/chat/NewChatEmptyState.tsx`, `src/components/chat/ComposerControls.tsx`, `src/components/chat/Composer.tsx`
- Modify tests: `tests/chat-header.test.tsx`, `tests/composer.test.tsx`

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/chat-header.test.tsx`:
    - Add `"renders 'What should we work on?' with project subtitle and no giant logo"`: renders `<NewChatEmptyState />` with `"Alpha"` selected, asserts heading `"What should we work on?"`, asserts project subtitle `"Alpha"`, asserts the ASCII backdrop is still present (`container.querySelector("pre")` is not `null`, upgraded by Task 24), and `container.querySelector('svg[aria-label="pult"]')` is `null`.
  - In `tests/composer.test.tsx`:
    - Add `"renders ProviderModelPicker without pill border and shows permission ModePill inline without opening overflow"`: asserts `getByRole("button", { name: /Provider, model, and reasoning/i })` has neither `border-border-subtle` nor `rounded-full`, and `getByRole("button", { name: "Permission mode" })` is directly visible in the composer bar without clicking `"Composer options"`.
    - Update any existing `ComposerOverflowMenu` test in `tests/composer.test.tsx` that expected `Permission mode` inside the overflow menu instead of inline (document reason: permission mode moved inline to match T3 composer bar).
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/chat-header.test.tsx tests/composer.test.tsx` → FAIL.
- [ ] **Step 3: Update `NewChatEmptyState.tsx`, `ComposerControls.tsx`, and `Composer.tsx` (DeepSeek)**
  - Clean `NewChatEmptyState.tsx` (remove `PultLogo`, update headline + project subtitle, keep the upgraded live ASCII backdrop).
  - Flatten `ProviderModelPicker` trigger, render `<ModePill threadId={threadId} />` inline in `Composer.tsx`, hide empty `ComposerOverflowMenu`, ensure no microphone button exists.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(composer): simplify empty state to 'What should we work on?' and flatten inline composer controls`

---

### Task 12: Neutral focus rings, text selection, and T3-style user message bubbles

**Design Decision:** Remove loud purple/accent focus glows and tinted selections while keeping WCAG accessibility (`>= 4.5:1` contrast tests in `tests/theme-contrast.test.ts` remain green):

- Update `--focus-ring` in `src/styles/tokens.css`, `src/styles/themes/{light,graphite,liquid}.css`, and `src/lib/theme.ts` to subtle neutral `0 0 0 1px var(--border-strong)` (no accent color glow).
- Update `::selection` in `src/styles/index.css` from `color-mix(in oklab, var(--accent) 32%, transparent)` to neutral `color-mix(in oklab, var(--text-primary) 15%, transparent)`.
- Replace `bg-mention-bg` on `UserRow` in `src/components/chat/MessagesTimeline.tsx` with neutral outlined/soft surface styling (`rounded-(--radius-lg) border border-border-subtle bg-surface px-3.5 py-2 text-base whitespace-pre-wrap text-text-primary`).
- Replace `hover:bg-accent/40 focus-visible:bg-accent/60` in `src/components/ui/ResizeHandle.tsx` with subtle neutral `hover:bg-border-strong focus-visible:bg-border-strong`.

**Files:**

- Modify: `src/styles/tokens.css`, `src/styles/themes/light.css`, `src/styles/themes/graphite.css`, `src/styles/themes/liquid.css`, `src/styles/index.css`, `src/lib/theme.ts`, `src/components/chat/MessagesTimeline.tsx`, `src/components/ui/ResizeHandle.tsx`
- Modify/Create tests: `tests/theme-contrast.test.ts`, `tests/messages-timeline.test.tsx`

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/theme-contrast.test.ts`: add `"uses neutral --focus-ring and ::selection without accent tint"` checking `tokens.css` / `index.css` do not define `--focus-ring` or `::selection` with `var(--accent)`.
  - In `tests/messages-timeline.test.tsx`: add `"renders user message bubbles with neutral surface + border instead of accent bg-mention-bg"`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/theme-contrast.test.ts tests/messages-timeline.test.tsx` → FAIL.
- [ ] **Step 3: Neutralize focus ring, selection highlight, ResizeHandle, and UserRow bubble (DeepSeek)**
  - Update CSS tokens, `index.css`, `theme.ts`, `ResizeHandle.tsx`, and `MessagesTimeline.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `style(theme): neutralize focus rings, selection highlights, and user message bubbles`

---

### Task 13: Styled `Tooltip` component, Sidebar icon-only footer, `"Search"` placeholder, and icon-button audit

**Design Decision:** Build a lightweight accessible `Tooltip` component (`src/components/ui/Tooltip.tsx`) that reveals a dark/surface floating pill on `pointerenter`/`focus` (with Escape dismiss & `role="tooltip"`). Replace the Sidebar search placeholder `"Search threads"` with `"Search"`, relocate `Refresh` from the search bar to the Sidebar `<footer>` alongside `Settings`, `Pull requests`, and `Usage` as 4 compact icon-only buttons wrapped in `<Tooltip>`, and audit every icon-only button across the app (`WindowChrome`, `ChatHeader`, `Composer`, `Sidebar`, `DiffPanel`, `TerminalPanel`, `Markdown`, `ErrorBanner`, `settings.providers`, `settings.keybindings`) to wrap with `<Tooltip>` and drop duplicate raw `title` attributes where `Tooltip` owns the label.

**Files:**

- Create: `src/components/ui/Tooltip.tsx`
- Modify: `src/components/layout/Sidebar.tsx`, `src/components/layout/WindowChrome.tsx`, `src/components/chat/ChatHeader.tsx`, `src/components/chat/Composer.tsx`, `src/components/chat/Markdown.tsx`, `src/components/diff/DiffPanel.tsx`, `src/components/terminal/TerminalPanel.tsx`, `src/components/ui/ErrorBanner.tsx`, `src/routes/settings.providers.tsx`, `src/routes/settings.keybindings.tsx`
- Modify/Create tests: `tests/tooltip.test.tsx`, `tests/sidebar.test.tsx`

**Interfaces:**

- `src/components/ui/Tooltip.tsx`:
  ```ts
  import type { ReactElement } from "react";

  export function Tooltip(props: {
    label: string;
    shortcut?: string;
    side?: "top" | "bottom" | "left" | "right";
    children: ReactElement;
  }): ReactElement;
  ```

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - Create `tests/tooltip.test.tsx`: renders `<Tooltip label="Settings"><button aria-label="Settings" /></Tooltip>`, verifies tooltip (`role="tooltip"`) is hidden initially, appears on `fireEvent.mouseEnter` or `fireEvent.focus`, and hides on `mouseLeave` / `blur` / `Escape`.
  - In `tests/sidebar.test.tsx`:
    - Add `"renders search placeholder 'Search' and icon-only footer buttons (Settings, Pull requests, Usage, Refresh) with tooltips"`: asserts `getByPlaceholderText("Search")`, verifies footer contains buttons `"Settings"`, `"Pull requests"`, `"Usage"`, and `"Refresh projects and threads"` with no visible inline text labels inside the footer, and hovering `"Settings"` shows its tooltip.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/tooltip.test.tsx tests/sidebar.test.tsx` → FAIL.
- [ ] **Step 3: Implement `Tooltip`, compact Sidebar footer + `"Search"`, and attach `Tooltip` to all icon-only buttons (DeepSeek)**
  - Create `src/components/ui/Tooltip.tsx`.
  - Update `src/components/layout/Sidebar.tsx` (`placeholder="Search"`, move `Refresh` to icon-only `<footer>` row with `Settings`, `Pull requests`, `Usage`, wrap toolbar & row icon buttons in `<Tooltip>`).
  - Attach `<Tooltip>` to every audited icon-only button across `WindowChrome.tsx`, `ChatHeader.tsx`, `Composer.tsx`, `Markdown.tsx`, `DiffPanel.tsx`, `TerminalPanel.tsx`, `ErrorBanner.tsx`, `settings.providers.tsx`, and `settings.keybindings.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(ui): add styled Tooltip across all icon-only buttons and compact Sidebar footer`

---

### Task 14: Perf baseline + Pre-warm selected provider/session & `IdlePool` warm reuse

**Design Decision:** `IdlePool` currently keys exclusively by `thread_id`, which forces every brand-new thread or `/chat` send to pay cold process spawn + `initialize()` + `session/new` (`~1.5–25s` depending on agent). Generalize `IdlePool` with a standby warm map keyed by `(instance_id, root, spawn_sig)` (bounded within `MAX_IDLE_CONNS`):

1. Add `providers_warmup(instance_id, workspace)` IPC command + `AgentRuntime::warmup` invoked non-blockingly at startup (for the first/selected enabled instance on active workspace) and from the frontend whenever `selectedInstanceId` or active project changes.
2. When `run_turn` runs for a thread with no `thread_id` entry in `IdlePool` and no prior `remote_session_id` to `session/load`, it first checks `pool.take_warm(instance_id, root, spawn_sig)`. If found and `!conn.is_dead()`, it skips spawn + `initialize()` + `session/new` completely and sends `session/prompt` immediately (targeting warm first delta `<= 2s`).
3. Measure cold vs warm turns with `node scripts/perf-turn.mjs` before and after, documenting numbers honestly in `DEVLOG.md`.

**Files:**

- Modify: `src-tauri/src/runtime/pool.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/examples/perf_turn.rs`, `src/lib/ipc.ts`, `src/stores/ui.ts`, `src/components/chat/ComposerControls.tsx`, `DEVLOG.md`
- Modify/Create tests: `src-tauri/src/runtime/pool.rs` (`mod tests`), `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- `src-tauri/src/runtime/pool.rs`:
  ```rust
  pub fn park_warm(&self, entry: IdleConn);
  pub fn take_warm(
      &self,
      instance_id: &str,
      root: &Path,
      spawn_sig: &SpawnSig,
  ) -> Option<IdleConn>;
  ```
- `src-tauri/src/ipc/mod.rs`:
  ```rust
  #[tauri::command]
  pub async fn providers_warmup(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      instance_id: String,
      workspace: Option<String>,
  ) -> Result<(), PultError>;
  ```
- `src/lib/ipc.ts`:
  ```ts
  export const providersWarmup = (instanceId: string, workspace?: string) =>
    invoke<void>("providers_warmup", { instanceId, workspace });
  ```

**Steps:**

- [ ] **Step 1: Capture baseline perf numbers + write failing pool/runtime tests (Gemini)**
  - Run `node scripts/perf-turn.mjs mock` (and any locally configured provider) to record baseline cold vs warm timings.
  - In `src-tauri/src/runtime/pool.rs` (`mod tests`):
    1. `take_warm_matches_instance_root_and_sig_for_first_thread_turn`: parks an unassigned warm `IdleConn`, calls `take_warm("mock", &root, &sig)`, asserts `Some(entry)` is returned once and consumed, and mismatched root/sig/dead entries are rejected and killed.
    2. `warm_pool_respects_max_idle_conns_and_ttl`: enforces global `MAX_IDLE_CONNS` and `IDLE_TTL` across thread + warm entries.
  - In `src-tauri/src/runtime/tests.rs`: test `runtime.warmup("mock", Some(&root))` populates a warm entry that the very next brand-new thread's `run_turn` consumes (`RunTiming.pooled == true` and `spawn_ms == 0`).
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib take_warm` → FAIL.
- [ ] **Step 3: Implement `IdlePool` warm standby, `providers_warmup` IPC, startup + switcher warmup, and post-change perf profile (DeepSeek)**
  - Implement `park_warm` / `take_warm` in `src-tauri/src/runtime/pool.rs`, wire `run_turn` + `warmup` in `src-tauri/src/runtime/mod.rs`, add `providers_warmup` in `ipc/mod.rs` + `lib.rs`, trigger warmup at startup & in `src/stores/ui.ts` / `ComposerControls.tsx` on provider selection.
  - Update `src-tauri/examples/perf_turn.rs` if needed to also exercise pre-warmed first turn, re-run `node scripts/perf-turn.mjs`, and log before/after latencies in `DEVLOG.md`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `perf(runtime): pre-warm default and selected providers via IdlePool for sub-2s warm first turns`

---

### Task 15: Optimistic user message & instant `"Working for 0s"` render on Send

**Design Decision:** Currently on Send (`Composer.tsx`), the UI waits for `threadsCreate` + `runsDispatch` IPC round-trips before showing the user message or `"Working"` indicator. Add an optimistic pending turn path in `useRunsStore` (`startOptimisticTurn(threadId, tempRunId, text, images, startedAt)` / `reconcileOptimisticRun(threadId, tempRunId, realRun)` / `rollbackOptimisticRun(threadId, tempRunId)`) so clicking Send renders the user bubble and `"Working for 0s"` on the immediate React render frame, then smoothly swaps in the real run when `run:started` / `runsDispatch` resolves (never duplicating the user bubble once real `user_message` arrives).

**Files:**

- Modify: `src/stores/runs.ts`, `src/components/chat/Composer.tsx`, `src/components/chat/MessagesTimeline.tsx`
- Modify tests: `tests/runs-store.test.ts`, `tests/composer.test.tsx`, `tests/messages-timeline.test.tsx`

**Interfaces:**

- `src/stores/runs.ts`:
  ```ts
  startOptimisticTurn: (
    threadId: string,
    tempRunId: string,
    instanceId: string,
    text: string,
    images: ImageInput[],
    startedAt?: number,
  ) => void;
  reconcileOptimisticTurn: (threadId: string, tempRunId: string, realRun: Run | null) => void;
  ```

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `tests/runs-store.test.ts`:
    1. `"startOptimisticTurn immediately renders user bubble and streaming state, then reconciles cleanly with real run without duplicating user_message"` — calls `startOptimisticTurn("th", "opt-1", "mock", "Hi", [], 1000)`, asserts `viewsByRun["opt-1"]` has `streaming: true` and 1 user item; calls `reconcileOptimisticTurn("th", "opt-1", realRun)` and `receiveRunEvent(realRun.id, userMessage("Hi"))`, asserts total user items in `threadTimelineItems` is `1` (no duplicate!).
    2. `"reconcileOptimisticTurn(..., null) removes failed optimistic run"` — verifies rollback on error.
  - In `tests/composer.test.tsx`: test that clicking Send on an existing thread while `runsDispatch` is still pending (`new Promise(...)`) immediately populates `useRunsStore` with the optimistic user item and `streaming: true`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `pnpm test tests/runs-store.test.ts tests/composer.test.tsx` → FAIL.
- [ ] **Step 3: Implement optimistic turn lifecycle in `runs.ts` + `Composer.tsx` (DeepSeek)**
  - Add `startOptimisticTurn` and `reconcileOptimisticTurn` in `src/stores/runs.ts` (avoiding duplicate user bubbles when `realRun`'s `user_message` event arrives).
  - Invoke `startOptimisticTurn` before awaiting `runsDispatch` in `Composer.tsx` (and on `/chat` after `threadsCreate` resolves, navigate immediately while `runsDispatch` proceeds or start optimistic turn cleanly before navigation completes).
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `perf(chat): add optimistic user message and instant Working status on send`

---

### Task 16: Full Acceptance & Build Walkthrough

**Files:**

- Modify: `DEVLOG.md`
- Create/Refresh screenshots: `docs/screenshots/v4-*.png`

**Steps:**

- [ ] **Step 1: Run full verification gates**
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] **Step 2: Build desktop bundle & run interactive smoke walkthrough**
  - `pnpm build`
  - `pnpm tauri build --no-bundle`
  - Run `node scripts/perf-turn.mjs` and launch the built executable to visually verify: Right Panel ProjectCard + `+` surface menu (`Files`, `Diff`, `Terminal`, `Pull requests`), real provider logos in Composer & Settings -> Providers, cached + refreshed startup connection status, Codex/mock generated image inline + lightbox zoom, hover `Copy` / `Branch` / `HH:MM`, flat grouped tool lines + `"Working for Ns"`, removed transcript token line (with `/usage` intact), custom context menus (editable, selection, thread, message), `"What should we work on?"` empty state + inline `ModePill`, neutral focus/selection/user bubbles, tooltipped icon-only buttons & sidebar footer, and instant optimistic send + warm `<= 2s` first delta.
- [ ] **Step 3: Update `DEVLOG.md` and capture `docs/screenshots/v4-*.png`**
  - Record exact test counts, cold/warm latency measurements, skipped items (`Regenerate title`), and screenshots.
- [ ] **Step 4: Commit**
  - `docs(devlog): record T3 parity pass acceptance verification and screenshots`

---

## Pending user additions

> **Note for the executor:** The user has additional parity items queued to send before execution begins. Before executing **Task 1**, check for any newly appended tasks below this heading (or append the user's follow-up items here as numbered tasks following the exact **Files / Interfaces / Steps** template above) and resolve any ordering/dependency impact before starting **Task 1**.

---

## Addendum — user additions (2026-11-15, execute with this plan)

> These tasks were requested after the main plan was written. They supersede the conflicting parts of Task 11 (composer controls) and extend Task 8 (tool rows). Execute them with the same test-first rhythm; Gemini writes the failing tests before each implementation step.

### Task 17: Project rows — chevron on the right, tinted project badge

**Files:** `src/components/layout/Sidebar.tsx`, `src/lib/projectColor.ts` (new), `src/routes/settings.projects.tsx` (creation color), tests `tests/sidebar.test.tsx`.

**Requirements:**

- Move the collapse/expand chevron to the **right edge** of the project row (before star and `+`); the name stays left with the badge.
- Project badge: at creation assign a random hue (persisted in `project.color` as a hue seed, not a solid fill). Render background `hsl(h 45% 16%)` and initials `hsl(h 70% 72%)` — same hue, dark surface, normal-bright text. Existing projects without a hue derive one deterministically from the project id/name so colors are stable.
- Initials font smaller (10–11px), generous padding, 6–7px radius; badge ~20–22px.
- Update tests for the new chevron position and badge styles; add a test for deterministic hue fallback.

### Task 18: Remove the composer workspace/branch status line

**Files:** `src/components/chat/Composer.tsx`, tests `tests/composer.test.tsx`.

**Requirements:**

- Delete `ComposerStatusLine` and its git refresh effect: the Right Panel `ProjectCard` is now the single place for workspace/branch. No duplicate "~\Desktop\... · main" row inside the composer.
- Composer bottom row then starts with the attach button; keep "Decision needed" surfacing on the approval card instead.

### Task 19: Provider/model picker like the reference (provider tabs, model search, favorites, effort slider)

**Files:** `src/components/chat/ComposerControls.tsx`, `src/stores/settings.ts`, `src/lib/types.ts`, tests `tests/composer.test.tsx` / new `tests/provider-picker.test.tsx`.

**Requirements:**

- The composer picker popover gets a top **provider icon tab row** (real logos; selected tab highlighted; `+` opens Manage providers), a `Search models…` input filtering the model list, model rows with name + `Ctrl 1…9` shortcut badges + favorite star, a checked row for the current model, and a reasoning control at the bottom: slider/segmented values plus a `Select effort` dropdown label (from the agent's reasoning option; hide the slider when the agent exposes only a boolean toggle, show On/Off).
- Favorites persist in settings (`favoriteModels: Record<instanceId, string[]>`); shortcuts are shown and actually select the nth visible model while the popover is open.
- Only real advertised models/options; no invented entries. When a provider has no model list, show "Default model (provider-managed)" and hide the search.
- Keyboard: arrows move, Enter selects, Esc closes, stars toggle without closing.

### Task 20: Queue rows like the reference + queue icon on the send button

**Files:** `src/components/chat/Composer.tsx`, `src/lib/ipc.ts`, tests `tests/composer.test.tsx`.

**Requirements:**

- Queued messages render as compact rows above the composer: drag-handle glyph, message text, `↑ Edit` ("Скорректировать") control, pencil, trash. Edit removes the queue item and loads its text (and images) back into the composer; trash removes it. Drag handle may be decorative only if reordering is not implemented — otherwise implement reorder; no fake drag that silently does nothing (use a static grip with tooltip "Queued" if no reorder).
- Keep the "queued sends when the current turn ends" semantics; add the hint line under the queue rows ("Keep typing to queue another message").
- While a run is active and the composer has text/images, the primary button becomes the **queue icon** (list-plus, blue circle), not an arrow and not stop; clicking queues. With an empty composer it stays Stop.

### Task 21: Human-readable tool rows (no raw exec JSON)

**Files:** `src/components/chat/MessagesTimeline.tsx`, `src/lib/toolSummary.ts` (new), tests `tests/messages-timeline.test.tsx` (new or existing).

**Requirements:**

- Expanded tool details show a readable summary first: command text, file path, query, or output text. Never show opaque `exec-…` ids as the primary content.
- Raw input/output JSON moves behind a `Raw`/`Details` toggle (collapsed by default). Strip `id`/`exec-*` fields from the readable layer.
- `Image generation` tool output renders the generated image inline when present (wired with Task 6); otherwise a short status line.
- Borderless inline rows from Task 8 apply; no card background.

### Task 22: Dismiss every popover/modal on outside click

**Files:** `src/components/ui/Popover.tsx` (new shared primitive if not present), `src/components/chat/ChatHeader.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/chat/ComposerControls.tsx`, `src/components/chat/Composer.tsx`, `src/components/ui/CommandPalette.tsx`, `src/components/diff/DiffPanel.tsx`, `src/routes/settings.providers.tsx`, tests for each menu.

**Requirements:**

- Any open popover/menu/dialog (thread actions, filters, project menu, provider picker, slash/mention menus, settings add-provider drawer, diff commit menu) closes on a pointerdown outside its root, on Escape, and on route change.
- Use one shared hook (`useDismissOnOutside(rootRef, open, onClose)`) or `Popover` primitive so behavior is identical everywhere; do not close when the click lands inside the popover or on its trigger (trigger toggles).
- Preserve focus and textarea selection; outside-click must not submit forms.

### Task 23: Bigger logo inside the app icon

**Files:** `scripts/gen-icon.mjs`, `pult-icon.svg`, `src-tauri/icons/*`, visual check.

**Requirements:**

- Regenerate the app icon so the pult mark fills more of the rounded dark tile (reduce outer padding ~30–40% while keeping safe margins for Windows taskbar masking), with the blue accent bar retained.
- Re-run the existing icon generation script and verify the built exe/taskbar icon at 16/32/48 px.

### Task 24: Living, theme-colored ASCII background

**Files:** `src/components/chat/NewChatEmptyState.tsx`, `src/components/chat/LivingAscii.tsx` (new), `src/styles/index.css` (keyframes if needed), tests (deterministic math helpers).

**Requirements:**

- Keep the ASCII field behind the empty state but raise its base visibility (user says it is barely visible) and color it from the active theme/accent tokens, not a hardcoded gray.
- Animate it: a slow ambient drift/pulse at rest, and a smooth, uneven ripple centered on the pointer as it moves; clicking the background emits a stronger pulse. Ripple brightness is highest at the wave crest and fades toward the edges (gaussian falloff), never a hard ring.
- Pointer/click listeners only on the background layer, not on the composer or text; respect `prefers-reduced-motion` (static but more visible), cap to ~30 fps, use `requestAnimationFrame`, and pause when the tab/window is hidden.
- Deterministic base field (no flicker); wave state is ephemeral and not persisted.
- Tests for the pure wave/falloff function (crest brighter than edge, click pulse decays over time).

### Task 25: T3-style Settings navigation with real, working pages

**Files:** `src/routes/settings.tsx`, `src/routes/settings.*.tsx`, `src/stores/settings.ts`, `src/lib/types.ts`, `src/lib/ipc.ts`, `src-tauri/src/ipc/mod.rs` (only if a setting needs backend), tests for each page and the settings store.

**Requirements:**

- Rebuild the Settings left rail like the reference: a `Search` field with `/` shortcut, grouped nav (`General`, `Appearance`, `Chat`, `Diffs & pull requests`, `Keybindings`; group `Agents`: `Providers`, `Threads`; group `Code`: `Projects`, `Source control`, `Worktrees`) and a local user chip at the bottom (opens General; no fake avatar upload).
- Search filters the nav live and jumps to the first match on Enter. Every nav item opens a page that actually configures and persists something; do NOT add Voice, Browser, Devices, Scheduled tasks, SnapShots or any other page without a real backing feature.
- Real settings to implement (persisted via existing settings store/`settings_set`, applied live):
  - General: desktop notifications on/off (existing), confirm before deleting a thread on/off, default landing route (`/chat` vs last thread).
  - Chat: default permission mode (Supervised / Auto-edit / Auto / Full access), send key behavior (Enter sends vs Mod+Enter sends), follow streaming output on/off, show message timestamps on/off.
  - Diffs & pull requests: default diff view (Unified / Split), wrap long diff lines on/off, auto-refresh on window focus on/off.
  - Agents > Threads: default sidebar filter (All / Active / Unread), default worktree strategy for new projects (root/worktree), auto-settle idle threads after N minutes (applies to thread status; backend timer if needed, otherwise skip rather than fake it).
  - Code > Projects: list projects with name/folder/strategy, create/edit/delete via the existing dialogs.
  - Code > Source control: default diff base (HEAD vs worktree), auto-fetch on open, PR checks refresh interval (only if real); skip anything without backend support.
  - Code > Worktrees: default strategy, worktree root preview, and a list of current worktrees from threads (read-only is fine if actions are not available).
- The settings store must expose typed getters/setters with defaults; pages read/write through it; changes survive restart. Update the keybindings/defaults docs where relevant.
- Tests: nav grouping/search filtering, persistence of each setting (round-trip), and that each page renders its controls. Gemini authors the tests; unsupported T3 pages are explicitly omitted from the nav.

### Task 26: Final performance, size, and freeze audit (Gemini) + optimizations

**Files:** `DEVLOG.md`, this plan; production files only as findings require.

**Requirements:**

- Gemini records real measurements on the built app: clean `pnpm build` dist size (total + largest JS chunks), `pult-core.exe` size, cold app start (launch → window responsive), idle and post-imagegen RSS/CPU, SQLite `pult.db` + WAL sizes, top 10 largest event payloads, IPC cap behavior, `pnpm test` duration, Rust test duration, ASCII idle CPU, and warm vs cold first-token latency.
- Freeze checks: open the historical 8 MB imagegen thread, switch projects/providers repeatedly, open/close the right panel with a large diff, and idle for 5 minutes; record responsiveness and memory growth.
- Rank findings, implement the safe wins (chunk splitting, unused assets, oversized modules, canvas tuning, safe SQLite checkpoint/VACUUM, redundant IPC), avoid behavior changes for numbers.
- Record numbers and changes in DEVLOG; re-run all gates and rebuild.

---

## Addendum — T3 Files Surface, Editor Preference, Icon Centering & Provider Updates (2026-11-15)

> Follow the same strict TDD split: **Gemini** authors failing tests (Step 1) and verifies failure (Step 2) before **DeepSeek** implements production code (Step 3), passes all gates (Step 4), and commits cleanly per task (Step 5).
>
> **Explicit Assumptions & Detection Rules:**
>
> 1. **Workspace root resolution:** In-app file browsing and link resolution prefer `activeThread.workspace` -> `selectedProject.rootPath` -> `runtime.global_workspace_root()`. Relative markdown links resolve against that root; absolute `file://` or OS paths must still pass canonical workspace confinement before reading.
> 2. **Editor detection order (Task 28):** Default `preferredEditor` resolves dynamically via `detect_editors` in order: `zed` (PATH or `%LOCALAPPDATA%\Programs\Zed\Zed.exe`) -> `vscode` (`code` on PATH or `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe`) -> `explorer` (always available). `"antigravity"` is detected via `which("antigravity")` or `%LOCALAPPDATA%\Programs\Antigravity\Antigravity.exe` (shown disabled/unavailable if absent, never guessed).
> 3. **Icon generation pipeline (Task 29):** `src-tauri/icons/*` was generated from `pult-icon.svg` via `pnpm tauri icon pult-icon.svg` (whereas `scripts/gen-icon.mjs` contains an older chevron+caret PNG generator). Keep `pult-icon.svg` as the canonical icon source and align/retire `scripts/gen-icon.mjs` so re-running icon generation cannot revert to the old mark.
> 4. **Provider CLI updates (Task 30):** Package mappings are derived by inspecting each configured instance's `command`/`args` and detecting installed package managers rather than guessing:
>    - `@zed-industries/claude-code-acp` (for `claude-code` `npx` adapter) and/or `@anthropic-ai/claude-code` (when `claude` CLI is npm-installed).
>    - `@agentclientprotocol/codex-acp` (for `codex` `npx` adapter) and/or `@openai/codex` (when `codex` CLI is npm-installed).
>    - `@google/gemini-cli` (for `gemini-cli`).
>    - `opencode-ai` (npm package assumption for `opencode`, used **only** if `npm list -g opencode-ai --depth=0 --json` confirms npm installation; otherwise mark `opencode` as `externally_managed` with `currentVersion` from `opencode --version`).
>    - `antigravity` (`agy_acp_server.exe` in `%LOCALAPPDATA%\pult\antigravity` or PATH): no standalone updater CLI or npm package is shipped/documented in the repo, so detect `--version` if supported and mark `externally_managed` unless an official updater binary/flag is detected.
>    - `mock`, `dsh`, and custom/unknown instances are always marked `externally_managed` and never updated.

---

### Task 27: Files surface + workspace tree, text/image preview, and in-chat file/folder hyperlinks

**Design Decision:** Replace the agent-changed-only `FileRow` list in `RightPanel.tsx` (`tab === "files"`) with a dedicated lazy-loaded `<FilesPanel />` that browses the real project/thread workspace while preserving `Diff`, `Terminal`, and `Pull requests` surfaces intact. Add shared workspace-path confinement (`confine_workspace_path`, matching `safe_path` in `src-tauri/src/runtime/mod.rs`) in `src-tauri/src/workspace.rs` so `workspace_list_dir`, `workspace_read_file`, and `read_image_data_url` (extended with optional `thread_id` and `workspace`) all reject UNC paths, `..` traversal, and symlink escapes. In `Markdown.tsx`, intercept local relative paths and `file://` links (including optional `#L123` line anchors) via a `MarkdownOpenLocalContext` / callback to open the in-app Files surface instead of navigating or shelling out to the OS, while `http(s)://` links stay external via `openExternalUrl`.

**Files:**

- Modify: `src-tauri/src/workspace.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts`, `src/lib/commands.ts`
- Create: `src/components/files/FilesPanel.tsx`
- Modify: `src/components/layout/RightPanel.tsx`, `src/components/chat/Markdown.tsx`, `src/components/chat/MessagesTimeline.tsx`
- Create/Modify tests: `tests/files-panel.test.tsx`, `tests/markdown-links.test.tsx`, `tests/markdown.test.tsx`, `tests/right-panel-project-card.test.tsx`

**Interfaces:**

- `src-tauri/src/workspace.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub struct WorkspaceDirEntry {
      pub name: String,
      pub path: String,        // workspace-relative POSIX path
      pub kind: String,        // "dir" | "file"
      pub size: Option<u64>,
  }

  #[derive(Debug, Clone, Serialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub struct WorkspaceFilePreview {
      pub path: String,        // workspace-relative POSIX path
      pub content: String,     // UTF-8 lossy decoded (empty when is_binary == true)
      pub truncated: bool,
      pub total_bytes: u64,
      pub is_binary: bool,
  }

  pub const MAX_DIR_ENTRIES: usize = 500;
  pub const MAX_TEXT_PREVIEW_BYTES: usize = 256 * 1024;

  /// Confines `raw` (relative POSIX/OS path or absolute path inside `root`) to canonical `root`.
  /// Rejects empty paths, UNC (`\\` / `//`), `..` ParentDir escapes, and out-of-root symlinks.
  pub fn confine_workspace_path(root: &Path, raw: &str) -> Result<PathBuf, PultError>;
  pub fn list_workspace_dir(root: &Path, rel_dir: Option<&str>, limit: usize) -> Result<Vec<WorkspaceDirEntry>, PultError>;
  pub fn read_workspace_file_preview(root: &Path, raw_path: &str, max_bytes: usize) -> Result<WorkspaceFilePreview, PultError>;
  ```
- `src-tauri/src/ipc/mod.rs` (registered in `src-tauri/src/lib.rs`):
  ```rust
  #[tauri::command]
  pub async fn workspace_list_dir(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: Option<String>,
      workspace: Option<String>,
      path: Option<String>,
  ) -> Result<Vec<crate::workspace::WorkspaceDirEntry>, PultError>;

  #[tauri::command]
  pub async fn workspace_read_file(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: Option<String>,
      workspace: Option<String>,
      path: String,
  ) -> Result<crate::workspace::WorkspaceFilePreview, PultError>;

  #[tauri::command]
  pub async fn read_image_data_url(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      path: String,
      thread_id: Option<String>,
      workspace: Option<String>,
  ) -> Result<String, PultError>;
  ```
- `src/stores/ui.ts`:
  ```ts
  selectedFilePath: string | null;
  selectedFileLine: number | null;
  openWorkspaceFile: (path: string, line?: number | null) => void;
  ```
  - Calling `openWorkspaceFile(path, line)` opens the `"files"` surface (`rightPanelTab = "files"`, `rightPanelOpen = true`) and stores the normalized target path/line so `FilesPanel` expands parent directories and selects/previews the target (or navigates into that folder if `path` resolves to a directory).
- `src/components/chat/Markdown.tsx`:
  ```ts
  export type ClassifiedHref =
    | { kind: "external"; href: string }
    | { kind: "local"; path: string; line?: number }
    | { kind: "other"; href: string };

  export function classifyMarkdownHref(href?: string): ClassifiedHref;
  ```
  - Accept optional `onOpenLocalPath?: (path: string, line?: number) => void` and `workspaceThreadId?: string | null` on `<Markdown />` (defaulting `onOpenLocalPath` to `useUiStore.getState().openWorkspaceFile` and passing `threadId` from `MessagesTimeline.tsx`).
  - `LocalImage` treats both relative paths and `file://`/OS paths inside the workspace as local via `readImageDataUrl(path, { threadId, workspace })`.
- `src/components/files/FilesPanel.tsx`:
  - **Breadcrumb:** `<projectName> > seg1 > seg2` where clicking the project root or any folder segment focuses/navigates to that folder.
  - **Search filter:** `"Filter files…"` input; when empty renders expandable directory tree (`workspace_list_dir`); when non-empty queries `workspace_files` for matching workspace-relative paths.
  - **Changed-file badges:** Cheap O(1) lookup against `useGitStore.byThread[threadId]?.diff?.files` and `useRunsStore.filesByThread[threadId]` showing subtle `M` / `A` / `D` or dot indicators next to matching files.
  - **Preview pane:**
    - Text/code files: monospace numbered lines (`1..N`), highlights/scrolls to `selectedFileLine` when provided, truncation notice when `truncated === true`, binary notice when `isBinary === true`.
    - Image files (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`): calls `readImageDataUrl(path, { threadId, workspace })`, renders zoom toolbar with **Fit**, **`-`**, **`+`**, zoom percentage (`100%`), and pixel size (`{naturalWidth}×{naturalHeight}px`) updated on `onLoad`.
  - **Toolbar:** includes the editor split-button + editor dropdown (wired with Task 28's `preferredEditor`).
- `src/lib/commands.ts`: add `"view.panel.files"` (`defaultBinding: "Mod+Alt+F"`, `"Show files panel"`).

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/workspace.rs` (`mod tests`):
    1. `confine_workspace_path_rejects_traversal_unc_and_outside_paths` — asserts `../secret.txt`, `a/../../evil`, `\\server\share\x`, `//server/share/x`, and an absolute path outside `root` return `Err`, while relative paths (`src/main.rs`) and in-root absolute paths resolve inside `root`.
    2. `list_workspace_dir_sorts_dirs_first_skips_ignored_and_caps` — creates `node_modules`, `.git`, `target`, `src/`, `README.md`, `app.ts`; asserts dirs come before files (`src` before `app.ts`, `README.md`), ignored dirs are omitted, and `limit` caps entries.
    3. `read_workspace_file_preview_caps_size_lossy_utf8_and_flags_binary` — tests small UTF-8 file, invalid UTF-8 bytes (lossy replacement without error), file larger than cap (`truncated == true`), and NUL-containing binary file (`is_binary == true`).
  - In `src-tauri/src/ipc/mod.rs` (`mod image_tests`): test relative image path confinement (`assets/chart.png` passes inside root, `../outside.png` fails).
  - Create `tests/files-panel.test.tsx`:
    1. Renders `<FilesPanel />` with mocked `workspaceListDir` / `workspaceReadFile` / `readImageDataUrl`, verifies breadcrumb (`Alpha > src`), dirs-first tree order, search filter invoking `workspaceFiles`, and changed-file badge on a dirty file.
    2. Clicking a text file renders line-numbered content; clicking a `.png` file renders image preview with **Fit**, **`-`**, **`+`** zoom controls and pixel dimensions (`640×480px`).
    3. Clicking `"Files"` in `RightPanel` `+` menu opens the workspace tree (and `Diff` / `Terminal` / `Pull requests` still render when selected).
  - In `tests/markdown-links.test.tsx`:
    1. Asserts relative links (`[ipc](src/lib/ipc.ts#L42)`), folder links (`[dir](src/components/)`), and `file://` links (`[main](file:///C:/work/alpha/src/main.rs)`) call `openWorkspaceFile` (and `preventDefault`) rather than `openExternalUrl`.
    2. Keeps `https://example.com/a` calling `openExternalUrl`.
  - In `tests/markdown.test.tsx`: asserts relative markdown image `![chart](out/chart.png)` resolves via `readImageDataUrl("out/chart.png", ...)`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib workspace` and `pnpm test tests/files-panel.test.tsx tests/markdown-links.test.tsx tests/markdown.test.tsx` → FAIL.
- [ ] **Step 3: Implement backend workspace dir/file IPCs, `FilesPanel`, `RightPanel` integration, and Markdown local-link interception (DeepSeek)**
  - Implement `confine_workspace_path`, `list_workspace_dir`, `read_workspace_file_preview` in `src-tauri/src/workspace.rs`; add `workspace_list_dir`, `workspace_read_file`, and relative-root support on `read_image_data_url` in `src-tauri/src/ipc/mod.rs`; register in `src-tauri/src/lib.rs`.
  - Update `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts`, `src/lib/commands.ts`.
  - Create `src/components/files/FilesPanel.tsx`, wire into `src/components/layout/RightPanel.tsx`, and update `src/components/chat/Markdown.tsx` + `src/components/chat/MessagesTimeline.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(files): add workspace Files surface with tree, text/image preview, and in-chat file links`

**Acceptance Criteria:**

- Clicking any local relative or `file://` link in chat opens the right-panel `Files` surface on that file/folder without invoking the OS opener; `http(s)://` links still open externally.
- `Files` tab shows the real workspace tree (dirs first, `node_modules`/`.git`/`target` hidden by default, search filter, changed-file badges, breadcrumb) and is reachable from both the `+` menu and in-chat links; `Diff`, `Terminal`, and `Pull requests` remain functional.
- Text previews cap size with UTF-8 lossy decoding and show line numbers; image previews support Fit / `+` / `-` zoom and show pixel dimensions.
- All path confinement tests reject `..`, UNC, and out-of-workspace escapes.

---

### Task 28: File context menu, persisted `preferredEditor` setting, and `Ctrl+O` shortcut

**Design Decision:** Store `preferredEditor: EditorId | null` (`"zed" | "vscode" | "antigravity" | "explorer" | null`) in SQLite `settings` under `"preferred_editor"` via `useSettingsStore` (`null` means auto-select: **Zed if installed, else VS Code, else File Explorer**). Extend `open_in_editor` in `src-tauri/src/ipc/mod.rs` to validate paths (supporting workspace-relative paths when `thread_id`/`workspace` is passed) and accept an allowlisted `editor` id (`zed` | `vscode` | `antigravity` | `explorer`), rejecting unknown ids and never using shell interpolation. Add `editors_detect` and `reveal_in_explorer` IPC commands so dropdowns reflect actually installed editors and `"Reveal in File Explorer"` selects files cleanly in the OS file manager. Wire right-click `ContextMenu` on every file/folder row and preview header in `FilesPanel`, add an editor dropdown to both `FilesPanel` toolbar and `ProjectCard`, and register `Mod+O` (`Ctrl+O`) to open the selected file (or workspace) in the preferred editor.

**Files:**

- Modify: `src-tauri/src/config.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/settings.ts`, `src/lib/commands.ts`
- Modify: `src/components/files/FilesPanel.tsx`, `src/components/layout/ProjectCard.tsx`
- Create/Modify tests: `tests/file-context-menu.test.tsx`, `tests/right-panel-project-card.test.tsx`, `tests/settings-pages.test.tsx`

**Interfaces:**

- `src-tauri/src/config.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub struct DetectedEditor {
      pub id: &'static str,       // "zed" | "vscode" | "antigravity" | "explorer"
      pub label: &'static str,    // "Zed" | "VS Code" | "Antigravity" | "File Explorer"
      pub available: bool,
  }

  pub fn detect_editors() -> Vec<DetectedEditor>;
  pub fn default_editor_id(detected: &[DetectedEditor]) -> &'static str; // zed -> vscode -> explorer
  ```
- `src-tauri/src/ipc/mod.rs` (registered in `src-tauri/src/lib.rs`):
  ```rust
  #[tauri::command]
  pub fn editors_detect() -> Result<Vec<crate::config::DetectedEditor>, PultError>;

  #[tauri::command]
  pub fn open_in_editor(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      path: String,
      editor: Option<String>,
      thread_id: Option<String>,
      workspace: Option<String>,
  ) -> Result<(), PultError>;

  #[tauri::command]
  pub fn reveal_in_explorer(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      path: String,
      thread_id: Option<String>,
      workspace: Option<String>,
  ) -> Result<(), PultError>;
  ```
  - `validate_editor_id(editor: Option<&str>) -> Result<Option<&'static str>, PultError>` accepts only `"zed"`, `"vscode"` (plus `"code"` alias normalized to `"vscode"`), `"antigravity"`, `"explorer"` and rejects arbitrary strings/commands.
  - On Windows, `reveal_in_explorer` runs `explorer.exe /select,<canonical_path>` when `target.is_file()` (or `explorer.exe <canonical_path>` for dirs); `open -R` on macOS; `xdg-open <parent_or_dir>` on Linux.
- `src/lib/types.ts` & `src/stores/settings.ts`:
  ```ts
  export type EditorId = "zed" | "vscode" | "antigravity" | "explorer";
  export interface DetectedEditor {
    id: EditorId;
    label: string;
    available: boolean;
  }
  // In SettingsState:
  preferredEditor: EditorId | null;
  setPreferredEditor: (editor: EditorId | null) => void;
  ```
- `src/components/files/FilesPanel.tsx` & `src/components/layout/ProjectCard.tsx`:
  - `FilesPanel` right-click menu on any tree row or preview header (`e.preventDefault(); e.stopPropagation();`) renders:
    1. `Open in <editor>` (`shortcut: "Ctrl+O"` / `"⌘O"`)
    2. `Reveal in File Explorer`
    3. `"separator"`
    4. `Copy relative path`
    5. `Copy full path`
  - Both `FilesPanel` toolbar and `ProjectCard` include a split button / editor picker dropdown listing `VS Code`, `Zed`, `Antigravity`, `File Explorer` (highlighting unavailable ones as disabled with `"(not found)"` if not installed, while keeping the active choice persisted via `setPreferredEditor`).
- `src/lib/commands.ts`:
  - Add `"files.openInEditor"` (`defaultBinding: "Mod+O"`, title `"Open file in editor"`): opens `useUiStore.getState().selectedFilePath` (or active workspace root) via `openInEditor(..., preferredEditor)`.

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/ipc/mod.rs` (`mod open_editor_tests`):
    1. Test `validate_editor_id` accepts `"zed"`, `"vscode"`, `"antigravity"`, `"explorer"` and rejects `"powershell"`, `"cmd"`, `"sh -c evil"`.
    2. Test `default_editor_id` picks `"zed"` when Zed+VS Code are available, `"vscode"` when only VS Code is available, and `"explorer"` when neither is available.
    3. Test `validate_editor_target` (existing + relative confinement) rejects empty, UNC, and `..` escape paths.
  - Create `tests/file-context-menu.test.tsx`:
    1. Right-clicking a file row in `FilesPanel` opens `ContextMenu` with `"Open in Zed"` (or resolved preferred editor), `"Reveal in File Explorer"`, `"Copy relative path"`, and `"Copy full path"`; clicking each calls `openInEditor`, `revealInExplorer`, and `navigator.clipboard.writeText` with relative vs full path.
    2. Changing the editor dropdown in `FilesPanel` calls `settingsSet("preferred_editor", "vscode")` and updates the `"Open in VS Code"` menu label; pressing `Ctrl+O` opens the selected file in the preferred editor.
  - In `tests/right-panel-project-card.test.tsx`:
    1. Update/extend `"Open in editor"` test (explicitly documenting the new optional `editor` arg or keeping `undefined` -> default behavior) and add test for changing the `ProjectCard` editor dropdown persisting `"preferred_editor"` and invoking `openInEditor(workspace, "antigravity")`.
  - In `tests/settings-pages.test.tsx`: add round-trip hydration test for `preferred_editor` in `useSettingsStore`.
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib open_editor_tests` and `pnpm test tests/file-context-menu.test.tsx tests/right-panel-project-card.test.tsx tests/settings-pages.test.tsx` → FAIL.
- [ ] **Step 3: Implement editor detection, `open_in_editor(editor)`, `reveal_in_explorer`, `preferredEditor` setting, context menus, and `Mod+O` (DeepSeek)**
  - Implement `detect_editors` / `default_editor_id` in `src-tauri/src/config.rs` and extend `open_in_editor` + add `editors_detect` / `reveal_in_explorer` in `src-tauri/src/ipc/mod.rs` + `src-tauri/src/lib.rs`.
  - Update `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/settings.ts`, `src/lib/commands.ts`.
  - Add file/preview context menu and editor dropdown to `src/components/files/FilesPanel.tsx` and `src/components/layout/ProjectCard.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(files): add file context menu, persisted preferredEditor setting, and Ctrl+O open`

**Acceptance Criteria:**

- Right-clicking any file/folder in `FilesPanel` or its preview opens a custom menu with `Open in <editor>`, `Reveal in File Explorer`, `Copy relative path`, and `Copy full path`.
- `preferredEditor` persists across restarts, defaults to `Zed -> VS Code -> File Explorer`, and can be switched from both the `Files` toolbar and `ProjectCard`.
- `Ctrl+O` opens the selected file (or workspace) in the preferred editor; backend strictly allowlists editor ids with zero shell interpolation.

---

### Task 29: Center the pult app icon optically with safe margins across all icon sizes

**Design Decision:** Inspection of `pult-icon.svg` and `src-tauri/icons/128x128.png` shows why the regenerated mark was clipped/off-center: inside `<g transform="translate(22 0) skewX(-12)">`, the four blocks occupy `x ∈ [66.47, 223.51]` (`center = 144.99`, `width = 157.03`) and `y ∈ [87, 233]` (`center = 160`, `height = 146`). The current `transform="translate(-156 -112) scale(2.3)"` places `x_min` at `-3.12px` (clipped at the left edge!) and shifts the mark far left of `256`. Recompute the outer transform in `pult-icon.svg` to `scale(1.95)` (~`306×285px`, leaving `>= 100px` / `~19.5%` safe margin on every side of the `512×512` `rx="112"` tile for Windows taskbar & squircle masking) with optical centering (`tx = -24, ty = -53`, putting the mark in `x ∈ [105.6, 411.8]`, `y ∈ [116.6, 401.3]`). Regenerate all platform icons (`src-tauri/icons/*`) via `pnpm tauri icon pult-icon.svg` and align `scripts/gen-icon.mjs` so it does not contain the obsolete chevron+caret icon.

**Files:**

- Modify: `pult-icon.svg`, `scripts/gen-icon.mjs`
- Regenerate: `src-tauri/icons/*` (all PNGs, `icon.ico`, `icon.icns`, Windows Square logos)
- Create tests: `tests/app-icon.test.ts`

**Interfaces:**

- `pult-icon.svg`:
  - `viewBox="0 0 512 512"`, `<rect width="512" height="512" rx="112" fill="#0B0B0B"/>`
  - Outer mark `<g transform="translate(-24 -53) scale(1.95)">` (exact optical centering inside the `512×512` tile with `~19–22%` margins on all 4 sides).
- `scripts/gen-icon.mjs`:
  - Update to spawn/wrap `pnpm tauri icon pult-icon.svg` (or render/verify `pult-icon.svg` -> `src-tauri/icons/*`) so no stale chevron+caret icon generator remains in `scripts/`.

**Steps:**

- [ ] **Step 1: Write failing test (Gemini)**
  - Create `tests/app-icon.test.ts`:
    1. Parses `pult-icon.svg` transform (`translate(tx ty) scale(s)`) and computes the exact transformed corners of all 4 skewed `<rect>`s; asserts `x_min >= 85`, `x_max <= 427`, `y_min >= 85`, `y_max <= 427`, `|(x_min + x_max)/2 - 256| <= 8`, and `|(y_min + y_max)/2 - 256| <= 8`.
    2. Decodes `src-tauri/icons/32x32.png` and `src-tauri/icons/128x128.png` (pure Node `zlib.inflateSync` PNG scanline reader) and checks the bounding box of light mark pixels (`r > 180 && g > 180 && b > 180`): asserts non-zero safe margin (`>= 15%` of dimension) on left, right, top, and bottom, and `|leftMargin - rightMargin| <= Math.ceil(size * 0.06)`, `|topMargin - bottomMargin| <= Math.ceil(size * 0.06)`.
    3. Asserts `src-tauri/icons/icon.ico` contains multi-size entries covering `16`, `32`, `48`, and `128`/`256` px (parsing the ICO directory header bytes).
- [ ] **Step 2: Run test to verify failure (Gemini)**
  - Run `pnpm test tests/app-icon.test.ts` → FAIL (`pult-icon.svg` has `x_min = -3.12` and `32x32.png` / `128x128.png` touch the left edge with 0 margin).
- [ ] **Step 3: Fix `pult-icon.svg`, align `scripts/gen-icon.mjs`, and regenerate all icons (DeepSeek)**
  - Update `pult-icon.svg` outer `<g>` transform to `translate(-24 -53) scale(1.95)`.
  - Run `pnpm tauri icon pult-icon.svg` to regenerate `src-tauri/icons/*`.
  - Update `scripts/gen-icon.mjs` to invoke `tauri icon pult-icon.svg` and print generated icon verification summary.
  - Visually inspect generated PNGs at `16/32/48/128 px` (including ICO extraction or `32x32.png` / `64x64.png` / `128x128.png`).
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `fix(icons): optically center pult icon mark with safe margins and regenerate all sizes`

**Acceptance Criteria:**

- The 4-block pult mark is optically centered inside the `512×512` tile with zero edge clipping and `>= 18%` safe margins on all four sides.
- All `src-tauri/icons/*` assets (including `16/32/48/128 px` ICO/PNGs) are regenerated and pass both pixel-margin assertions and visual inspection.

---

### Task 30: Provider CLI update checks & background install from the single sidebar refresh button

**Design Decision:** Keep one and only one refresh button in the left sidebar footer (rightmost footer control). Clicking it refreshes projects/threads/instances and runs `providers_check_updates` asynchronously in the background (never blocking the UI). When one or more providers have newer versions available, the button displays a download badge; clicking it when updates are ready runs `providers_install_all_updates` in the background while rendering an SVG circular progress ring around the button (`0..100%`). All update commands use a strict hardcoded allowlist in `src-tauri/src/updates.rs` (`npm view` / `npm install -g <pkg>@latest` for npm-distributed agents only, `CREATE_NO_WINDOW` on Windows, zero shell interpolation, `instance_id` validated against `runtime.instances()`, and unsupported/native tools like `antigravity` / `mock` / `dsh` marked `"externally_managed"` unless an official updater is explicitly detected). Per-provider rows in `src/routes/settings.providers.tsx` display current vs available version, `"Managed externally"` when unsupported, and per-provider update action + progress bar/ring.

**Files:**

- Create: `src-tauri/src/updates.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/ipc/mod.rs`
- Modify: `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts`
- Modify: `src/components/layout/Sidebar.tsx`, `src/routes/settings.providers.tsx`
- Create/Modify tests: `tests/provider-updates.test.tsx`, `tests/sidebar.test.tsx`

**Interfaces:**

- `src-tauri/src/updates.rs`:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub enum UpdateSupport {
      Npm,
      ExternallyManaged,
  }

  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
  #[serde(rename_all = "camelCase")]
  pub struct ProviderUpdateInfo {
      pub instance_id: String,
      pub support: UpdateSupport,
      pub package_name: Option<String>,
      pub current_version: Option<String>,
      pub latest_version: Option<String>,
      pub update_available: bool,
      pub status: String, // "idle" | "checking" | "up_to_date" | "update_available" | "updating" | "updated" | "externally_managed" | "error"
      pub progress: u8,   // 0..=100
      pub message: Option<String>,
  }

  /// Pure classifier: maps an InstanceSpec onto an allowlisted npm package (or ExternallyManaged).
  /// Never accepts user-supplied commands or shell strings.
  pub fn resolve_update_target(spec: &crate::config::InstanceSpec, npm_installed_pkgs: Option<&std::collections::HashSet<String>>) -> UpdateTarget;
  pub fn parse_semver_version(raw: &str) -> Option<(u64, u64, u64)>;
  pub fn is_newer_version(current: Option<&str>, latest: Option<&str>) -> bool;
  ```
  - Hardcoded allowlist `UpdateTarget`:
    - `args` containing `@zed-industries/claude-code-acp` -> `Npm { package: "@zed-industries/claude-code-acp" }` (or if `command == "claude"` and `@anthropic-ai/claude-code` is detected in global npm list -> `@anthropic-ai/claude-code`).
    - `args` containing `@agentclientprotocol/codex-acp` -> `Npm { package: "@agentclientprotocol/codex-acp" }` (or if `command == "codex"` and `@openai/codex` is detected in global npm list -> `@openai/codex`).
    - `args` containing `@google/gemini-cli` -> `Npm { package: "@google/gemini-cli" }`.
    - `id == "opencode"` / `command` basename `"opencode"` -> `Npm { package: "opencode-ai" }` **only when** `npm list -g opencode-ai --depth=0 --json` confirms it is npm-managed; otherwise `ExternallyManaged`.
    - `antigravity`, `dsh`, `mock`, and any custom binary -> `ExternallyManaged` (`message: "Managed externally"`).
  - Emits Tauri event `"provider:update"` with `ProviderUpdateInfo` on check completion and during `npm install -g <pkg>@latest` progress phases (`10%` -> `35%` -> `70%` -> `95%` -> `100%`).
- `src-tauri/src/ipc/mod.rs` (registered in `src-tauri/src/lib.rs`):
  ```rust
  #[tauri::command]
  pub async fn providers_check_updates(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
  ) -> Result<Vec<crate::updates::ProviderUpdateInfo>, PultError>;

  #[tauri::command]
  pub async fn providers_install_update(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      instance_id: String,
  ) -> Result<crate::updates::ProviderUpdateInfo, PultError>;

  #[tauri::command]
  pub async fn providers_install_all_updates(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
  ) -> Result<Vec<crate::updates::ProviderUpdateInfo>, PultError>;
  ```
  - Validates `instance_id` exists in `runtime.instances()`, prevents concurrent installs for the same `instance_id`, resolves `which("npm")`, and spawns `npm` directly without a shell (`CREATE_NO_WINDOW` on Windows).
- `src/stores/ui.ts`:
  ```ts
  providerUpdates: Record<string, ProviderUpdateInfo>;
  checkingUpdates: boolean;
  installingUpdates: boolean;
  checkProviderUpdates: () => Promise<void>;
  installProviderUpdate: (instanceId: string) => Promise<void>;
  installAllProviderUpdates: () => Promise<void>;
  ```
  - Subscribes once to `"provider:update"` (`onProviderUpdate`) to keep `providerUpdates[instanceId]` live.
  - Pure helper `aggregateUpdateState(updates)` computes `{ availableCount, updatingCount, overallProgress (0..100) }`.
- `src/components/layout/Sidebar.tsx`:
  - Footer keeps **one** refresh button (`ml-auto`, rightmost icon in `<footer>`). Verify no duplicate refresh button exists anywhere in `Sidebar.tsx`.
  - Behavior:
    - Idle / no available updates: `<RefreshCw />` (spins while `checkingUpdates`), tooltip `"Refresh"`, `aria-label="Refresh"`; clicking refreshes projects/threads/instances AND calls `checkProviderUpdates()`.
    - Updates available (`availableCount > 0` and not installing): shows download badge (`data-update-badge` + count dot), tooltip `"Update ${availableCount} provider(s)"`, `aria-label="Refresh"`; clicking starts `installAllProviderUpdates()` in background.
    - Installing (`installingUpdates` or `updatingCount > 0`): renders circular SVG progress ring (`data-update-progress`, `strokeDashoffset` from `overallProgress`) around/inside the button without blocking sidebar or chat interactions.
- `src/routes/settings.providers.tsx`:
  - Per-provider row in the left list shows compact version / update badge (`"Update vX.Y.Z"` or circular/mini progress % while updating); detail card `Status` / `Updates` section shows current version, latest version, `"Managed externally"` when unsupported, or an `"Update to vX.Y.Z"` button with progress bar.

**Steps:**

- [ ] **Step 1: Write failing tests (Gemini)**
  - In `src-tauri/src/updates.rs` (`mod tests`):
    1. `parse_semver_and_compare_versions` — tests `0.1.9` vs `0.1.10`, `v1.2.3-beta.1`, equal versions (`false`), missing version (`false`), and prerelease vs stable.
    2. `resolve_update_target_allowlists_known_packages_and_marks_others_external` — verifies `@zed-industries/claude-code-acp`, `@agentclientprotocol/codex-acp`, `@google/gemini-cli` map to `Npm`; `opencode` maps to `Npm("opencode-ai")` only when present in `npm_installed_pkgs` and `ExternallyManaged` otherwise; `antigravity`, `mock`, and arbitrary `command: "bash"` map to `ExternallyManaged`.
    3. `install_update_rejects_unknown_or_external_instance_id` — verifies invalid `instance_id` or `ExternallyManaged` target returns `Err` without spawning any process.
  - Create `tests/provider-updates.test.tsx`:
    1. Tests `aggregateUpdateState` across mixed `up_to_date`, `update_available`, `updating` (`progress: 40`, `80` -> `60`), and `externally_managed` entries.
    2. Renders `<Sidebar />` footer: verifies exactly ONE refresh button exists, clicking it checks updates (`providersCheckUpdates`) alongside refreshing stores, receiving a `"provider:update"` event with `updateAvailable: true` shows `[data-update-badge]`, clicking it triggers `providersInstallAllUpdates`, and active `updating` progress renders `[data-update-progress]` circular SVG fill without blocking other buttons.
    3. Renders `ProvidersSettings` with seeded `providerUpdates` and asserts per-provider rows display available version (`v0.2.0`), progress (`65%`), and `"Managed externally"` for Antigravity/custom agents.
  - Check `tests/sidebar.test.tsx`: verify existing footer refresh tests (`name: /^refresh$/i`, icon-only `textContent === ""` when idle, tooltip `/refresh/i`) remain compatible (or update cleanly if badge adds sr-only text; keep visible text empty when idle and put badge in `aria-hidden` element so `btn.textContent?.trim()` stays `""` or update test explicitly).
- [ ] **Step 2: Run tests to verify failure (Gemini)**
  - Run `cargo test --manifest-path src-tauri/Cargo.toml --lib updates` and `pnpm test tests/provider-updates.test.tsx tests/sidebar.test.tsx` → FAIL.
- [ ] **Step 3: Implement backend `updates.rs`, IPC commands, `useUiStore` update state, Sidebar footer progress/badge, and Providers Settings UI (DeepSeek)**
  - Create `src-tauri/src/updates.rs`, wire `providers_check_updates`, `providers_install_update`, `providers_install_all_updates` in `src-tauri/src/ipc/mod.rs` and `src-tauri/src/lib.rs`.
  - Update `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/ui.ts`, `src/components/layout/Sidebar.tsx`, and `src/routes/settings.providers.tsx`.
- [ ] **Step 4: Run verification**
  - Run `pnpm typecheck && pnpm lint && pnpm test && cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write && cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [ ] **Step 5: Commit**
  - `feat(providers): check and install CLI updates with circular progress from sidebar refresh`

**Acceptance Criteria:**

- Exactly one refresh button exists in the sidebar footer (on the right side); clicking it checks all providers without blocking the UI, shows a download badge when updates exist, and installs updates in the background with a circular progress fill.
- Providers settings shows current/available versions, live progress per provider, and `"Managed externally"` for unsupported/custom tools (`antigravity`, `mock`, custom binaries).
- Backend validates `instance_id` against configured instances, uses only allowlisted package-manager invocations (`npm view` / `npm install -g <pkg>@latest` without shell interpolation), and handles errors cleanly without crashing or blocking.

### Task 31: Tab selects slash-command and @-mention suggestions

**Files:** `src/components/chat/Composer.tsx`, `tests/composer.test.tsx`.

**Requirements:**

- With the `/` command menu or the `@` mention menu open, `Tab` selects the highlighted suggestion exactly like Enter and keeps focus in the composer; `Shift+Tab` moves the highlight up (or is ignored, never moves DOM focus). Escape still closes; ArrowUp/Down still move.
- Test: open `/` menu, press Tab, assert the command text is inserted and the menu closes; same for `@` with a seeded workspace file; Shift+Tab changes the highlighted row.
