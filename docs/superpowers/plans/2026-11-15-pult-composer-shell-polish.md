# Pult Composer, Shell & Performance Polish

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **Authorship & Execution Split:** **Gemini** authors the failing tests for each task (Step 1) and verifies failure (Step 2) before **DeepSeek** implements the production changes (Step 3) and runs verification (Step 4).

**Goal:** Polish `pult`'s daily UX and performance to match T3 Code: remove the duplicate topbar/logo and the unused new-thread workspace strip, unify provider/model/reasoning selection into one composer popover with provider logos and gray reasoning text, scale typography proportionally to a ~14px body without tiny `10px`/`11px` leftovers, scope real theme CSS tokens into Appearance preview cards so every theme preview is visibly distinct, and make the Diff panel open instantaneously even with thousands of changed files via metadata-only summaries, lazy per-file diffs, line-capped diff rendering, and dynamic-height row virtualization.

**Architecture:** Nine focused tasks (eight implementation tasks plus final acceptance) layered cleanly onto the existing Tauri 2 + React 19 + Tailwind CSS v4 + Zustand 5 codebase:

- **Shell & Empty-State Streamlining (Tasks 1–2):** Delete `NewThreadOptionsStrip` and `ui.newThreadOptions` (new threads derive `workspace` and `worktree` directly from the selected project); delete `Topbar.tsx` and fold window controls + panel toggles into a single 40px `ChatHeader` (for `/chat` and `/thread/$threadId`) and `RouteHeader` (for `/settings/*`, `/usage`, `/pull-requests`, `/welcome`) so `PultLogo` + `"pult"` appears once in `Sidebar`.
- **Unified Composer Picker & Stale-Config Safety (Tasks 3–4):** Replace `ModelPill` + overflow `AgentPicker` + overflow `Reasoning` with a single `ProviderModelPicker` (`[ProviderLogo] Model  Reasoning ▾`) backed by inline SVGs and a 3-section dialog popover; prune incompatible config keys in `useRunsStore` on provider switch and guard `runs_dispatch` / `run_turn` in Rust against stale provider config values.
- **Typography & Scoped Theme Previews (Tasks 5–6):** Bump `@theme inline` tokens and `body` from 12px to 14px, replace every hardcoded `text-[10px]`/`text-[11px]` across 14 files while keeping `DiffLines` column alignment and updating `Composer` `MAX_HEIGHT`, and scope `[data-theme="..."]` CSS selectors so Appearance theme cards render live, drift-free token palettes.
- **Instant Large Diffs (Tasks 7–8):** Add metadata-only `git_diff_summary` and lazy per-file `git_diff_file` Rust commands (with strict repo-root path validation, scratch-index blob-SHA `patch_hash`, and no-HEAD parity), switch `useGitStore` to `patchHash` `O(1)` reviewed tracking + lazy patch caching, cap `DiffLines` at 2,000 initial rows with `"Show all N lines"`, and virtualize `DiffPanel` with dynamic-height `useVirtualRows` (including `ResizeObserver` measurement and scroll anchoring).
- **Acceptance & Build Verification (Task 9):** Run full gates, `pnpm build`, kill `pult-core`, `pnpm tauri build --no-bundle`, launch the built exe, capture `docs/screenshots/v3-*.png`, and update `DEVLOG.md` honestly.

**Tech Stack:** Tauri 2 (Rust, Tokio, `git` CLI), React 19, TypeScript (`strict: true`), Zustand 5, TanStack Router, Tailwind CSS v4, Vitest + Testing Library, `cargo test` / `cargo clippy`.

---

## Pre-Task-1 Hygiene (Commit Before Starting Task 1)

1. **Uncommitted `DEVLOG.md` from v2 walkthrough:** The working tree already contains uncommitted edits in `DEVLOG.md` (`Post-walkthrough fixes (2026-11-15)` and updated `Known issues / gaps`). Commit `DEVLOG.md` first so Task 1 starts from a clean working tree:
   `git add DEVLOG.md && git commit -m "docs(devlog): record v2 post-walkthrough fixes"`
2. **Commit this plan:** Commit `docs/superpowers/plans/2026-11-15-pult-composer-shell-polish.md` before executing Task 1:
   `git add docs/superpowers/plans/2026-11-15-pult-composer-shell-polish.md && git commit -m "docs(plan): add composer, shell, theme, and large-diff polish plan"`

## Global Constraints

- **Zero new npm or Cargo dependencies:** Provider logos use inline SVGs in `ProviderLogo.tsx`; diff virtualization uses a self-contained `useVirtualRows` hook; theme previews reuse existing CSS files.
- **No dead controls:** Only real, wired controls in the composer and headers (never add a microphone button or inert placeholder).
- **Zero palette drift:** Theme preview cards MUST read the exact CSS custom properties from `src/styles/tokens.css` and `src/styles/themes/*.css` via `[data-theme="..."]`, never duplicated JS hex maps.
- **Byte-exact diffs preserved:** Expanding any `FileCard` must still render the exact `git diff` slice (`DiffFile.raw`) via `UnifiedLines` / `SplitLines`; existing `crate::git::diff()` and its Rust byte-exact tests remain intact.
- **Strict TypeScript & Rust hygiene:** Use explicit `ReactElement` / `ReactNode` imports from `"react"` (never global `JSX.Element`, which React 19 `react-jsx` may not expose). All changes must pass `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`, and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.

## Review Focus

1. **Provider switch stale-state leak:** Switching from Provider A (e.g., Claude with `model: "claude-sonnet-4"`, `thinking_level: "high"` or `effort: "high"`) to Provider B (e.g., Codex or an unprobed CLI) must call `pruneDesiredConfigForInstance` at the click site before closing the popover, filter via `configForSend` against the selected instance's options, and clear/ignore incompatible keys in Rust `runs_dispatch` / `run_turn` so Provider B never receives Provider A's model or effort.
2. **Drag region & window controls across every route:** With `Topbar.tsx` deleted, `/chat`, `/thread/$threadId`, `/settings/*`, `/usage`, `/pull-requests`, and `/welcome` must each render exactly one 40px (`h-10`) `<header>` containing `data-tauri-drag-region`, sidebar/right-panel toggles, and Tauri `WindowControls` (minimize, maximize/restore, close), with `PultLogo` appearing in `<header>` zero times (only in `Sidebar` chrome, plus `WelcomePage`'s body hero card).
3. **Path traversal & hash integrity in git IPC:** `git_diff_file` receives an untrusted `path` and optional `base` from the frontend and must enforce canonical repo-root confinement and flag-injection guards before spawning `git`; `patch_hash` must derive from scratch-index git blob SHAs (never size/mtime).
4. **CSS selector specificity & contrast tests:** Scoping theme selectors to `[data-theme="..."]` must not break `tests/theme-contrast.test.ts` (`parseTokens`) or `@supports` / `@media (prefers-reduced-transparency: reduce)` blocks in `src/styles/themes/liquid.css`.
5. **Large diff scalability & line alignment:** `DiffPanel` with 2,000+ files must mount only visible viewport rows + overscan (`< 100` row nodes), support dynamic expand/collapse heights with scroll anchoring, cap single-file `DiffLines` at 2,000 initial line rows (`"Show all N lines"` to reveal all), and preserve split/unified gutter alignment at the bumped `13px` mono size.

---

## Tasks

### Task 1: Remove `NewThreadOptionsStrip` and project-drive new-thread workspaces

**Files:**

- Delete: `src/components/chat/NewThreadOptionsStrip.tsx`
- Modify: `src/components/chat/NewChatEmptyState.tsx`, `src/stores/ui.ts`, `src/components/chat/Composer.tsx`
- Modify tests: `tests/chat-header.test.tsx`, `tests/shell-layout.test.tsx`, `tests/ui-store.test.ts`

**Interfaces:**

- Remove `NewThreadOptions`, `newThreadOptions`, and `setNewThreadOptions` from `UiState` in `src/stores/ui.ts`.
- In `src/components/chat/Composer.tsx`:
  - `handleSend` (`!threadId` branch) derives `targetWorkspace = project?.rootPath || undefined` and `targetWorktree = project?.worktreeStrategy === "worktree"` from `useProjectsStore.getState()` (`selectedProjectId` → `projects`).
  - `ComposerStatusLine` resolves `raw = threadWorkspace ?? projectRoot` (no `newThreadWorkspace`).
- In `src/components/chat/NewChatEmptyState.tsx`: remove `<NewThreadOptionsStrip />` and update subtitle copy to `"Describe a task and let the agent take it from there."`.

**Steps:**

- [x] **Step 1: Write failing test (Gemini)**
  - In `tests/chat-header.test.tsx`:
    - Add test `"does not render workspace folder input or isolated worktree checkbox on /chat"`: render `<NewChatEmptyState />` with a selected project, assert `screen.queryByLabelText("Workspace folder for new threads")` is `null` and `screen.queryByLabelText(/Isolated worktree/i)` is `null`.
    - Remove the `newThreadOptions: { workspace: "", worktree: false }` seed from `useUiStore.setState` at `tests/chat-header.test.tsx:105` and `tests/chat-header.test.tsx:176`.
  - In `tests/shell-layout.test.tsx`:
    - Remove the `newThreadOptions: { workspace: "", worktree: false }` seed from `useUiStore.setState` at `tests/shell-layout.test.tsx:146`.
  - In `tests/ui-store.test.ts`:
    - Add test `"does not expose newThreadOptions or setNewThreadOptions"` asserting `!("newThreadOptions" in useUiStore.getState())` and `!("setNewThreadOptions" in useUiStore.getState())`.
- [x] **Step 2: Run test to verify failure (Gemini)**
      Run `pnpm test tests/chat-header.test.tsx tests/ui-store.test.ts` → FAIL (strip inputs still render and `newThreadOptions` still exists on `UiState`).
- [x] **Step 3: Delete `NewThreadOptionsStrip` and clean up store + composer (DeepSeek)**
      Delete `src/components/chat/NewThreadOptionsStrip.tsx`. Update `src/components/chat/NewChatEmptyState.tsx`, `src/stores/ui.ts`, `src/components/chat/Composer.tsx` (`handleSend` and `ComposerStatusLine`).
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/chat-header.test.tsx tests/shell-layout.test.tsx tests/ui-store.test.ts` → PASS.
- [x] **Step 5: Commit**
      `refactor(chat): remove NewThreadOptionsStrip and derive new-thread workspace from project`

---

### Task 2: Collapse double headers into a single 40px header per route (`ChatHeader` + `RouteHeader`)

**Design Decision & Route Coverage:** Delete `Topbar.tsx` and remove `<Topbar />` from `src/routes/__root.tsx`. `Sidebar.tsx` retains the sole `PultLogo` + `"pult"` brand row (`h-10`, with `data-tauri-drag-region` spacer). Move `WindowControls` and panel toggles (`PanelLeft`, `PanelRight`) into `src/components/layout/WindowChrome.tsx` and render them in one `<header>` per route:

- `/chat` (`src/routes/chat.tsx`) and `/thread/$threadId` (`src/routes/thread.$threadId.tsx`): both render `src/components/chat/ChatColumn.tsx`, which renders `<ChatHeader />`. Adding `<PanelToggleButtons />` + `<WindowControls />` + `data-tauri-drag-region` to `ChatHeader.tsx` covers both routes with one `<header>`.
- `/settings/*` (`src/routes/settings.tsx`): `SettingsLayout` is a layout (`nav` + `<Outlet />`) and currently has no header. Wrap its `<div className="flex min-h-0 flex-1">` in `<div className="flex min-h-0 flex-1 flex-col">` and render `<RouteHeader title="Settings" subtitle={activeLabel} />` **once** above that flex row (where `activeLabel = NAV.find((n) => n.to === pathname)?.label`). Export `SettingsLayout` for route tests.
- `/usage` (`src/routes/usage.tsx`), `/pull-requests` (`src/routes/pull-requests.tsx`), and `/welcome` (`src/routes/welcome.tsx`): page components; wrap each in `<div className="flex min-h-0 flex-1 flex-col">` (with `<div className="min-h-0 flex-1 overflow-y-auto">` around scrolling page body) and render `<RouteHeader />` at the top of each (`title="Usage"`, `title="Pull requests"`, `title="Welcome"`). Export `PullRequestsPage` and `WelcomePage` (matching already-exported `UsagePage`) for route tests.
- `/` (`src/routes/index.tsx`): only throws `redirect({ to: "/chat" })`; renders no UI and needs no header.

**Files:**

- Create: `src/components/layout/WindowChrome.tsx`
- Delete: `src/components/layout/Topbar.tsx`
- Modify: `src/routes/__root.tsx`, `src/components/chat/ChatHeader.tsx`, `src/components/layout/Sidebar.tsx`, `src/components/layout/RightPanel.tsx`, `src/routes/settings.tsx`, `src/routes/usage.tsx`, `src/routes/pull-requests.tsx`, `src/routes/welcome.tsx`
- Modify tests: `tests/shell-layout.test.tsx`, `tests/sidebar.test.tsx`, `tests/chat-header.test.tsx`, `tests/e2e/smoke.spec.ts`

**Interfaces:**

- `src/components/layout/WindowChrome.tsx`:
  ```ts
  import type { ReactElement, ReactNode } from "react";

  export function PanelToggleButtons(): ReactElement;
  export function WindowControls(): ReactElement | null; // returns null when !isTauri()
  export function RouteHeader(props: {
    title: string;
    subtitle?: string;
    actions?: ReactNode;
  }): ReactElement;
  ```
  - `RouteHeader` renders `<header data-tauri-drag-region className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-border-subtle bg-canvas pl-4 pr-0">`, title (`text-base font-medium text-text-primary`), optional `/ subtitle`, `<div data-tauri-drag-region className="flex-1" />`, optional `actions`, `<PanelToggleButtons />`, and `<WindowControls />`.
  - `ChatHeader` becomes `<header data-tauri-drag-region className="relative flex h-10 shrink-0 select-none items-center gap-2 border-b border-border-subtle pl-4 pr-0">` with `data-tauri-drag-region` on the flexible spacer (`<div data-tauri-drag-region className="flex-1" />`), thread actions (`Pin`, `⋯`), `<PanelToggleButtons />`, and `<WindowControls />`.
  - `Sidebar.tsx` top brand row gets `h-10 shrink-0 border-b border-border-subtle px-3` (with `data-tauri-drag-region` on the brand span) and `RightPanel.tsx` tab row gets `h-10 shrink-0` so all panes align on one 40px top seam.

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
  - In `tests/shell-layout.test.tsx`: replace `Topbar` assertions with tests verifying:
    1. `"renders a single 40px header in ChatHeader with panel toggles and no duplicate PultLogo"` — renders `<ChatHeader title="Polish shell" threadId="t1" />`, checks `<header>` has `h-10`, contains `Toggle sidebar` and `Toggle right panel` buttons, and renders zero `PultLogo` SVGs (`header.querySelector('[aria-label="pult"]') === null`).
    2. `"renders RouteHeader with h-10, drag region, title, and panel toggles for non-thread routes"` — renders `<RouteHeader title="Settings" subtitle="Appearance" />`, asserts `h-10`, `[data-tauri-drag-region]`, `"Settings"`, `"Appearance"`, and panel toggles.
    3. `"every route renders exactly one <header> with WindowControls, panel toggles, and no PultLogo"` — mocks `isTauri` returning `true`, mocks TanStack Router hooks (`useRouter`, `useRouterState`, `Link`, `Outlet`), renders each route component (`/chat` via `<ChatColumn />`, `/thread/$threadId` via `<ChatColumn threadId="t1" title="Polish shell" />`, `/settings/*` via `<SettingsLayout />`, `/usage` via `<UsagePage />`, `/pull-requests` via `<PullRequestsPage />`, and `/welcome` via `<WelcomePage />`), and asserts for EVERY route that `container.querySelectorAll("header").length === 1`, the `<header>` contains `Minimize`, `Maximize` (or `Restore`), `Close`, `Toggle sidebar`, and `Toggle right panel` buttons, and `header.querySelector('[aria-label="pult"]') === null`.
  - In `tests/sidebar.test.tsx`: replace the `describe("Topbar", ...)` block with `describe("Sidebar branding", ...)` verifying `Sidebar` renders the sole `pult` header label + `PultLogo` SVG and no Settings gear in top chrome.
  - In `tests/e2e/smoke.spec.ts`: update line 59 breadcrumb check to assert the active route heading (`page.getByRole("banner").getByText("Keybindings")`) and assert `"pult"` brand appears only once (in sidebar, not duplicated in a global topbar).
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/shell-layout.test.tsx tests/sidebar.test.tsx` → FAIL (`RouteHeader` missing / `ChatHeader` lacks toggles / route components lack single `<header>`).
- [x] **Step 3: Implement `WindowChrome.tsx`, delete `Topbar.tsx`, wire `ChatHeader` + route headers (DeepSeek)**
      Create `src/components/layout/WindowChrome.tsx`, delete `src/components/layout/Topbar.tsx`, remove `<Topbar />` from `src/routes/__root.tsx`, update `ChatHeader.tsx`, `Sidebar.tsx`, `RightPanel.tsx`, `settings.tsx` (passing active section title as `subtitle` above its flex row and exporting `SettingsLayout`), `usage.tsx`, `pull-requests.tsx` (exporting `PullRequestsPage`), and `welcome.tsx` (exporting `WelcomePage`). Keep `src/lib/breadcrumbs.ts` + `tests/breadcrumbs.test.ts` intact so existing breadcrumb unit tests remain green.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/shell-layout.test.tsx tests/sidebar.test.tsx tests/chat-header.test.tsx` → PASS.
- [x] **Step 5: Commit**
      `feat(shell): collapse Topbar and ChatHeader into single 40px route header`

---

### Task 3: Unified `ProviderModelPicker` in Composer and overflow cleanup

**Design Decision:** Export `ProviderModelPicker` from `src/components/chat/ComposerControls.tsx` and `ProviderLogo` from `src/components/chat/ProviderLogo.tsx`. Replace `<ModelPill />` in `Composer.tsx` with `<ProviderModelPicker threadId={threadId} />`. Inside `ComposerOverflowMenu`, remove `Reasoning` and `Agent` sections; keep `Session mode` (`AgentModePicker`), `Permission` (`ModePill`), and render extra non-model/non-reasoning options (`ConfigOptionPickers` excluding every option matching `isModelOption` or `isReasoningOption`) only if the active instance exposes any.

**Files:**

- Create: `src/components/chat/ProviderLogo.tsx`
- Modify: `src/components/chat/ComposerControls.tsx`, `src/components/chat/Composer.tsx`, `src/stores/runs.ts`
- Modify tests: `tests/composer.test.tsx`

**Interfaces:**

- `src/components/chat/ProviderLogo.tsx`:
  ```ts
  import type { ReactElement } from "react";

  export type ProviderBrand = "claude" | "codex" | "gemini" | "opencode" | "mock" | "custom";
  export function detectProviderBrand(
    inst: Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args">,
  ): ProviderBrand;
  export function ProviderLogo(props: {
    instance: Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args"> | null;
    className?: string;
  }): ReactElement;
  ```
  - Inline 14×14 SVGs (with `data-provider-logo={brand}`) for `claude` (Anthropic starburst/spark), `codex` (OpenAI hex-knot), `gemini` (four-point star), `opencode` (terminal bracket mark); `mock` renders a clean `Bot` icon or `M` monogram; `custom` renders a 14×14 rounded badge with `displayName[0].toUpperCase()`.
- `src/stores/runs.ts`:
  ```ts
  pruneDesiredConfigForInstance: (slot: string, options: SessionConfigOption[]) => void;
  ```
  - Keeps only entries in `desiredConfigByThread[slot]` whose `id` exists in `options` AND whose value passes `configValueValid(opt, val)`; deletes stale `model`, `thinking_level`, `effort`, `thought_level`, `reasoning_effort`, and `reasoning` (or any incompatible option) when switching to a provider without matching options/values.
- `src/components/chat/ComposerControls.tsx`:
  ```ts
  import type { ReactElement } from "react";

  export function isReasoningOption(option: SessionConfigOption): boolean;
  export function isModelOption(option: SessionConfigOption): boolean;
  export function ProviderModelPicker(props: { threadId?: string }): ReactElement;
  ```
  - `isModelOption`: `option.type === "select" && (option.id === "model" || option.category === "model")`.
  - `isReasoningOption`: matches BOTH `"select"` and `"boolean"` options whose `id` is in `["thinking_level", "effort", "thought_level", "reasoning_effort", "reasoning"]` OR whose `category` is `"thought_level"` or `"reasoning"`.
  - **Trigger layout:** `<ProviderLogo instance={selected} />` + `<span className="max-w-[160px] truncate text-text-primary">{modelLabel}</span>` + (when `reasoningOption` exists) `<span className="shrink-0 text-text-tertiary">{reasoningLabel}</span>` + `<ChevronDown size={12} className="shrink-0 text-text-tertiary" />`. For boolean reasoning options, `reasoningLabel` is `"On"` when `true` and `"Off"` when `false`. `aria-label` includes provider, model, and reasoning (`"${selected?.displayName ?? "No agent"} · ${modelLabel}${reasoningLabel ? ` · ${reasoningLabel}` : ""}"`).
  - **One-Popover (`role="dialog"`, `aria-label="Provider, model, and reasoning"`) sections:**
    1. `Provider`: enabled instances (`ProviderLogo`, `displayName`, status dot, origin pill, `Check`), plus `"Manage providers…"` link to `/settings/providers`. **Click handler order (critical):**
       1. `setSelectedInstanceId(inst.id);`
       2. `if (threadId) useUiStore.getState().rememberInstance(threadId, inst.id);`
       3. `useRunsStore.getState().pruneDesiredConfigForInstance(threadId ?? "", inst.configOptions);`
       4. `setOpen(false);` (ALWAYS call `pruneDesiredConfigForInstance` BEFORE closing the popover).
    2. `Model`: shown when `modelOption` exists (flat or grouped `SessionConfigSelectGroup[]` rows with `Check`), or muted `"Default model (provider-managed)"` when absent.
    3. `Reasoning`: shown when `reasoningOption` exists; `role="radiogroup"`, `aria-label="Reasoning"`:
       - When `reasoningOption.type === "select"`: segmented pills for each option (`Low`, `Medium`, `High`, etc.).
       - When `reasoningOption.type === "boolean"`: an `Off` / `On` segmented toggle row (`role="radio"`, `aria-checked`, calling `pickConfig(reasoningOption.id, false)` / `true`).
  - `ConfigOptionPickers`: when filtering out model/reasoning options in `ComposerOverflowMenu`, filter `!isModelOption(option) && !isReasoningOption(option)` so no `thinking_level`/`effort`/`category: "reasoning"` option leaks into overflow.
- `src/components/chat/Composer.tsx`:
  - `configForSend(desired, threadId, instanceOptions?)`:
    - Preserves existing 2-arg unit-test behavior when `instanceOptions === undefined`.
    - When `instanceOptions` is provided (from `Composer.tsx` passing `selectedInstance?.configOptions`, including `[]` for an unprobed/optionless instance), keeps ONLY entries `[id, value]` where `opt = instanceOptions.find((o) => o.id === id)` exists AND `configValueValid(opt, value)` is true; returns `null` if no valid entries remain.

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
      Update `tests/composer.test.tsx`:
  - Replace overflow assertions that expected `Effort` and `Agent` inside `Composer options` with assertions that `Composer options` contains ONLY `Session mode` and `Permission` (plus extra boolean toggles like `Web search` when present), and does NOT contain `Agent` or `Reasoning`.
  - Add `"renders unified ProviderModelPicker trigger with provider logo, model name, and gray reasoning text"` — configures Claude instance (`id: "claude"`, `model: "claude-sonnet-4"`, `thinking_level: "high"`), checks trigger displays `"Sonnet 4"` and `"High"` inside a `text-text-tertiary` span alongside an inline `svg[data-provider-logo="claude"]`.
  - Add `"handles boolean reasoning options with On/Off row and gray trigger text"` — configures an instance with `{ id: "reasoning", name: "Reasoning", category: "reasoning", type: "boolean", currentValue: false }`, asserts trigger displays `"Off"` in `text-text-tertiary`, opens popover, clicks `"On"` radio button, asserts `runsSetConfigOption` is called with `("th", "reasoning", true)` and trigger updates to `"On"`.
  - Add `"opens one popover with Provider, Model, and Reasoning sections and updates trigger immediately"` — clicks trigger, asserts `Provider`, `Model`, and `Reasoning` headings inside one `[role="dialog"]`, selects a new model and reasoning pill, verifies `runsSetConfigOption` and trigger update.
  - Add `"prunes stale thinking_level/effort/model when switching provider and never dispatches stale keys"` — starts on Claude (`model: "claude-sonnet-4"`, `thinking_level: "high"`, and also seeds stale `effort: "max"`), switches to Codex (`model` options `["gpt-5", "o3"]` with default `"gpt-5"` and `reasoning_effort` default `"medium"`, no `thinking_level` or `effort`), asserts `useRunsStore.getState().desiredConfigByThread["th"]` immediately has NO `thinking_level`, NO `effort`, and NO `"claude-sonnet-4"`, and dispatching a message calls `runsDispatch` with `instanceId: "codex"` and a `config` argument containing neither `thinking_level`, `effort`, nor `"claude-sonnet-4"`.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/composer.test.tsx` → FAIL.
- [x] **Step 3: Implement `ProviderLogo.tsx`, `ProviderModelPicker`, `pruneDesiredConfigForInstance`, and `Composer` updates (DeepSeek)**
      Create `src/components/chat/ProviderLogo.tsx`, update `src/stores/runs.ts`, `src/components/chat/ComposerControls.tsx`, and `src/components/chat/Composer.tsx`. Remove `AgentPicker` and `ModelPill` once migrated.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/composer.test.tsx tests/chat-header.test.tsx` → PASS.
- [x] **Step 5: Commit**
      `feat(composer): unify provider, model, and reasoning into single popover picker`

---

### Task 4: Backend stale-config guard on provider switch

**Files:**

- Modify: `src-tauri/src/ipc/mod.rs`, `src-tauri/src/runtime/mod.rs`
- Test: `src-tauri/src/runtime/tests.rs`

**Interfaces:**

- In `src-tauri/src/runtime/mod.rs`:
  ```rust
  pub fn clear_stale_provider_config(
      &self,
      thread_id: &str,
      instance_id: &str,
  ) -> Result<(), crate::PultError>;
  ```
  - Inspects `self.store.list_runs(thread_id)` (last run's `instance_id`): if `last_run.instance_id != instance_id`, strips `"model"`, `"thinking_level"`, `"effort"`, `"thought_level"`, `"reasoning_effort"`, and `"reasoning"` from `thread_config:<thread_id>` before `runs_dispatch` merges new `config_options`.
  - Update `effort` extraction in `create_run` and `config_apply_order` in `src-tauri/src/runtime/mod.rs` to check all five reasoning IDs (`"thought_level"`, `"thinking_level"`, `"reasoning_effort"`, `"effort"`, `"reasoning"`).
  - Add `fn session_config_value_valid(options: &[SessionConfigOption], id: &str, value: &ConfigOptionValue) -> bool` and filter `picks` in `run_turn` against `session_config_options` (the options returned by `session/new` or `session/load`, falling back to cached `runtime.config_options(&instance_id)`), so even a stale persisted value is never sent to `conn.set_config_option`.
- In `src-tauri/src/ipc/mod.rs` (`runs_dispatch`): call `runtime.clear_stale_provider_config(&thread_id, &instance_id)?;` before `merge_desired_config`.

**Steps:**

- [x] **Step 1: Write failing Rust test (Gemini)**
      In `src-tauri/src/runtime/tests.rs`, add `provider_switch_does_not_apply_stale_model_or_reasoning_from_prior_provider`:
  - Run turn 1 on thread `t1` with instance `"inst-a"` and `desired_config` `{ "model": "model-a-only", "thinking_level": "high", "effort": "max" }`.
  - Call `runtime.clear_stale_provider_config("t1", "inst-b")` (simulating provider switch in `runs_dispatch`), then run turn 2 on `"inst-b"` with `config_options` advertising `["model-b-1", "model-b-2"]` and `reasoning_effort` `["low", "medium"]`.
  - Assert `run2.model.as_deref() != Some("model-a-only")`, `run2.effort.as_deref() != Some("high")`, and the mock agent for `"inst-b"` never receives `set_config_option` for `"model-a-only"`, `"thinking_level"`, or `"effort"`.
- [x] **Step 2: Run test to verify failure (Gemini)**
      Run `cargo test --manifest-path src-tauri/Cargo.toml --lib provider_switch_does_not_apply_stale_model_or_reasoning_from_prior_provider` → FAIL.
- [x] **Step 3: Implement `clear_stale_provider_config`, reasoning ID normalization, and `session_config_value_valid` (DeepSeek)**
      Update `src-tauri/src/runtime/mod.rs` and `src-tauri/src/ipc/mod.rs`.
- [x] **Step 4: Run verification**
      Run `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` → PASS.
- [x] **Step 5: Commit**
      `fix(runtime): guard against stale model/reasoning config across provider switches`

---

### Task 5: Proportional typography scale (~14px body) and removal of tiny `10px`/`11px` sizes

**Design Decision:** Bump `@theme inline` tokens in `src/styles/index.css` by +2px across the board (`--text-xs: 12px/16px`, `--text-sm: 14px/20px`, `--text-base: 15px/22px`, `--text-lg: 17px/24px`, `--text-xl: 22px/30px`, `--text-2xl: 30px/38px`), set `body` to `font-size: 14px; line-height: 20px;`, bump `.md` to `15px` (`.md-code-area` `14px`, `.md thead th` / `.md-code-lang` `12px`), bump `TerminalPane` xterm `fontSize` to `14`, update `Composer.tsx` `MAX_HEIGHT` (`10 * 28` = 280px, matching the +4px line-height step) and textarea `max-h-[280px]`, and replace all hardcoded `text-[10px]` → `text-xs` (12px) and `text-[11px]` → `text-[13px]` (13px). In `DiffLines.tsx`, widen `LineNo` and empty-cell gutter from `w-9` to `w-10` so line numbers align cleanly at `12px` / `13px`.

**Files:**

- Modify: `src/styles/index.css`, `src/components/chat/markdown.css`, `src/components/terminal/TerminalPane.tsx`
- Modify hardcoded sizes & composer height (all 14 files):
  - `src/components/chat/ChatHeader.tsx` (line 117: `h-5 w-5 text-[10px]` → `h-5.5 w-5.5 text-xs`)
  - `src/components/chat/Composer.tsx` (line 29: `const MAX_HEIGHT = 10 * 28; // 10 rows at the 28px effective line step`; line 763: `max-h-60` → `max-h-[280px]`; lines 149, 157, 163, 169, 675: `text-[10px]` → `text-xs`)
  - `src/components/chat/ComposerControls.tsx` (lines 216, 346: `text-[10px]` → `text-xs`)
  - `src/components/chat/NewChatEmptyState.tsx` (line 29: `text-[10px]` → `text-xs`)
  - `src/components/diff/DiffLines.tsx` (line 14: `w-9 ... text-[10px]` → `w-10 ... text-xs`; line 25: `w-9` → `w-10`; lines 46, 70: `text-[11px] leading-5` → `text-[13px] leading-[22px]`)
  - `src/components/diff/DiffPanel.tsx` (lines 75, 80: `text-[10px]` → `text-xs`)
  - `src/components/layout/Sidebar.tsx` (lines 129, 182, 519: `text-[10px]` → `text-xs`, monogram `h-5.5 w-5.5`)
  - `src/components/settings/SignInActions.tsx` (line 84: `text-[11px]` → `text-[13px]`)
  - `src/components/terminal/TerminalPanel.tsx` (lines 42, 126, 188: `text-[10px]` → `text-xs`; line 45: `text-[11px]` → `text-[13px]`)
  - `src/components/ui/CommandPalette.tsx` (lines 107, 122, 143: `text-[10px]` → `text-xs`)
  - `src/components/ui/ContextMenu.tsx` (line 181: `text-[10px]` → `text-xs`)
  - `src/components/ui/FpsOverlay.tsx` (line 45: `text-[10px]` → `text-xs`)
  - `src/routes/settings.diagnostics.tsx` (lines 70, 85: `text-[10px]` → `text-xs`; lines 71, 86: `text-[11px]` → `text-[13px]`)
  - `src/routes/usage.tsx` (lines 26, 205, 253, 299: `text-[10px]` → `text-xs`)
- Test: `tests/fonts.test.ts`

**Interfaces:**

- `src/styles/index.css` `@theme inline`:
  ```css
  --text-xs: 12px;
  --text-xs--line-height: 16px;
  --text-sm: 14px;
  --text-sm--line-height: 20px;
  --text-base: 15px;
  --text-base--line-height: 22px;
  --text-lg: 17px;
  --text-lg--line-height: 24px;
  --text-xl: 22px;
  --text-xl--line-height: 30px;
  --text-2xl: 30px;
  --text-2xl--line-height: 38px;
  ```

**Steps:**

- [x] **Step 1: Write failing test (Gemini)**
      In `tests/fonts.test.ts`, add `"uses 14px body scale and removes hardcoded 10px/11px text utilities across src/"`:
  - Assert `src/styles/index.css` contains `--text-sm: 14px;` and `font-size: 14px;` inside `body`.
  - Assert `src/components/chat/Composer.tsx` does not contain `MAX_HEIGHT = 10 * 24` or `max-h-60`.
  - Recursively scan `src/**/*.{ts,tsx,css}` and assert zero matches for `/text-\[(?:9|10|11)px\]/`.
- [x] **Step 2: Run test to verify failure (Gemini)**
      Run `pnpm test tests/fonts.test.ts` → FAIL.
- [x] **Step 3: Apply proportional type scale and replace hardcoded tiny sizes (DeepSeek)**
      Update `src/styles/index.css`, `src/components/chat/markdown.css`, `src/components/terminal/TerminalPane.tsx`, `Composer.tsx` (`MAX_HEIGHT = 10 * 28`, `max-h-[280px]`), and the 14 listed TSX files.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/fonts.test.ts` → PASS.
- [x] **Step 5: Commit**
      `style(typography): bump body/type scale to 14px and eliminate tiny 10px/11px text`

---

### Task 6: Scope theme CSS selectors and render distinct Appearance preview cards

**Design Decision:** Keep the single source of truth in `src/styles/tokens.css` and `src/styles/themes/*.css`. Update selectors so each theme works both at `:root` and inside any `[data-theme="<id>"]` preview container, eliminating palette drift while making Dark, Light, Graphite, and Liquid Glass previews visibly distinct regardless of the currently active app theme.

**Files:**

- Modify: `src/styles/tokens.css`, `src/styles/themes/light.css`, `src/styles/themes/graphite.css`, `src/styles/themes/liquid.css`, `src/routes/settings.appearance.tsx`
- Modify / Create tests: `tests/theme-contrast.test.ts`, `tests/appearance.test.tsx` (create)

**Interfaces:**

- Theme CSS selectors:
  - `src/styles/tokens.css`: `:root,\n[data-theme="dark"] { ... }`
  - `src/styles/themes/light.css`: `[data-theme="light"] { ... }`
  - `src/styles/themes/graphite.css`: `[data-theme="graphite"] { ... }`
  - `src/styles/themes/liquid.css`: `[data-theme="liquid"] { ... }`, `[data-theme="liquid"] .glass-panel`, `[data-theme="liquid"] .glass-surface, [data-theme="liquid"] [data-glass]`, and inside `@media (prefers-reduced-transparency: reduce)` use `[data-theme="liquid"] { ... }`.
- `src/routes/settings.appearance.tsx`:
  - Each theme `<button role="radio">` renders a scoped miniature UI preview wrapper `<span data-theme={id} className="block overflow-hidden rounded-(--radius-sm) border border-border-subtle bg-canvas p-1.5 text-text-primary">` containing a mini sidebar (`bg-panel`), mini header (`bg-chrome`), mini content card (`bg-surface` / `bg-surface-raised` with `glass-surface` class on `liquid`), text bar (`bg-text-secondary`), and accent pill (`bg-accent`). Setting `style={id === "liquid" ? { backgroundImage: "radial-gradient(circle at 80% 20%, rgba(52,107,241,0.28), transparent 65%)" } : undefined}` on the `liquid` card subtly shows its translucent `glass-surface` over a backdrop.
- `tests/theme-contrast.test.ts`:
  - Update `parseTokens(css: string)` regex from `/:root(?:\[[^\]]*\])?\s*\{([^}]*)\}/` to `/(?::root(?:\[[^\]]*\])?|\[data-theme="[^"]+"\])[^{]*\{([^}]*)\}/` so it parses both `:root, [data-theme="dark"]` and `[data-theme="light"]` / `[data-theme="graphite"]` / `[data-theme="liquid"]`.

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
      Create `tests/appearance.test.tsx`:
  - Render `<AppearanceSettings />` (or `Route.options.component`).
  - Assert all 4 theme radio cards (`Dark`, `Light`, `Graphite`, `Liquid Glass`) render a nested element with `data-theme="dark"`, `"light"`, `"graphite"`, `"liquid"` respectively (even while `document.documentElement` is dark).
  - Read `src/styles/tokens.css` and `src/styles/themes/*.css` and assert each file defines `[data-theme="<id>"]` so scoped previews override `:root` tokens rather than reading live root variables.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/appearance.test.tsx tests/theme-contrast.test.ts` → FAIL.
- [x] **Step 3: Scope CSS theme blocks and upgrade Appearance preview cards (DeepSeek)**
      Update `tokens.css`, `light.css`, `graphite.css`, `liquid.css`, `settings.appearance.tsx`, and `tests/theme-contrast.test.ts`.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/appearance.test.tsx tests/theme-contrast.test.ts` → PASS.
- [x] **Step 5: Commit**
      `fix(theme): scope theme CSS selectors so appearance previews render each palette`

---

### Task 7: Rust metadata-only `git_diff_summary` and lazy per-file `git_diff_file`

**Design Decision:** Keep `crate::git::diff()` unchanged so byte-exact whole-repo diff tests stay valid.

- **`diff_summary(dir, base)`**: Must include **staged + unstaged + untracked** changes identically to `diff()` using a throwaway scratch index (`temp_index_for(&repo)`):
  1. Validate `base` with `validate_base(base)` (reject leading `-`, `\0`, whitespace/control chars with `git_err("git.invalid_base", ...)`).
  2. Copy real index (or create empty scratch index) and run `git add -A .` with `GIT_INDEX_FILE=temp` (never touching the real index).
  3. Determine `head_ok` (`git rev-parse --verify -q HEAD`). When `base` is `None`/empty and `!head_ok` (no-HEAD repo), resolve the empty tree hash via `git hash-object -t tree --stdin` (empty stdin) so `git diff --cached` still compares staged + untracked files, while reporting `GitDiffSummary.base = "worktree"` (matching `diff()`). Otherwise `effective_base` is `validated_base` or `"HEAD"`.
  4. Run `git diff --cached --numstat --no-renames -z <effective_base>` and `git diff --cached --raw --no-abbrev --no-renames -z <effective_base>` (note: `--cached` yields real non-zero 40/64-char git blob SHAs for BOTH `old_sha` and `new_sha`, unlike worktree `git diff --raw` which emits `0000...` for dst SHA).
  5. Compute `patch_hash` directly from the `--raw -z` blob SHAs and metadata (`old_sha`, `new_sha`, `status`, `path`) via a deterministic digest (NEVER file size or mtime, which can stay unchanged on same-size edits).
- **`diff_file(dir, path, base)`**:
  1. **Trust boundary before spawning `git`:** Reject empty `path`, `\0`, `Path::new(path).is_absolute()`, leading `/` or `\`, any `Component::Prefix(_)` / `Component::RootDir` / `Component::ParentDir`, and any `..` segment across `/` or `\` with `git_err("git.invalid_path", ...)`. Canonicalize `repo_canon = repo.canonicalize()`, join `candidate = repo_canon.join(rel_path)`, walk up to the deepest existing ancestor (or `candidate` itself if it exists on disk, so deleted tracked files remain diffable), `canonicalize()` that existing path, and assert it `starts_with(&repo_canon)` (blocking symlinks/escapes outside repo root). Also validate `base` via `validate_base(base)`.
  2. Using a scratch index (`temp_index_for(&repo)`), run `git add -N -- <path>` only if the path exists on disk and is untracked (always passing `"--"` before `<path>`), then `git diff --no-color --no-ext-diff --no-renames [base] -- <path>` to return one byte-exact `DiffFile`.

**Files:**

- Modify: `src-tauri/src/git/mod.rs`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src/lib/types.ts`, `src/lib/ipc.ts`
- Test: `src-tauri/src/git/tests.rs`

**Interfaces:**

- Rust (`src-tauri/src/git/mod.rs`):
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct DiffFileSummary {
      pub path: String,
      pub old_path: Option<String>,
      pub added: u64,
      pub removed: u64,
      pub binary: bool,
      pub status: String,
      pub patch_hash: String,
  }

  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  #[serde(rename_all = "camelCase")]
  pub struct GitDiffSummary {
      pub repo_root: String,
      pub base: String,
      pub total_added: u64,
      pub total_removed: u64,
      pub files: Vec<DiffFileSummary>,
  }

  pub async fn diff_summary(dir: &Path, base: Option<&str>) -> Result<GitDiffSummary, PultError>;
  pub async fn diff_file(dir: &Path, path: &str, base: Option<&str>) -> Result<DiffFile, PultError>;
  ```
- Tauri commands (`src-tauri/src/ipc/mod.rs` + `src-tauri/src/lib.rs`):
  ```rust
  #[tauri::command]
  pub async fn git_diff_summary(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: String,
      base: Option<String>,
  ) -> Result<crate::git::GitDiffSummary, PultError>

  #[tauri::command]
  pub async fn git_diff_file(
      runtime: tauri::State<'_, Arc<AgentRuntime>>,
      thread_id: String,
      path: String,
      base: Option<String>,
  ) -> Result<crate::git::DiffFile, PultError>
  ```
- TypeScript (`src/lib/types.ts` + `src/lib/ipc.ts`):
  ```ts
  export interface DiffFileSummary {
    path: string;
    oldPath?: string | null;
    added: number;
    removed: number;
    binary: boolean;
    status: string;
    patchHash: string;
  }

  export interface GitDiffSummary {
    repoRoot: string;
    base: string;
    totalAdded: number;
    totalRemoved: number;
    files: DiffFileSummary[];
  }

  export function gitDiffSummary(threadId: string, base?: string | null): Promise<GitDiffSummary>;
  export function gitDiffFile(
    threadId: string,
    path: string,
    base?: string | null,
  ): Promise<DiffFile>;
  ```

**Steps:**

- [x] **Step 1: Write failing Rust tests (Gemini)**
      In `src-tauri/src/git/tests.rs`, add:
  - `diff_summary_matches_diff_counts_and_changes_patch_hash_on_edit`: creates staged edit + unstaged edit + untracked file, compares `diff_summary` file list, `added`, `removed`, `status`, `total_added`, `total_removed` against `diff()`, performs a **same-size content edit** (e.g. `"line1\n"` → `"XXXX1\n"`, identical byte length) and asserts that file's `patch_hash` changes while untouched files keep identical `patch_hash`.
  - `diff_summary_works_on_no_head_repo`: initializes a fresh repo with no commits (`no-HEAD`), adds one staged file and one untracked file, asserts `diff_summary(fx.path(), None)` succeeds with `base == "worktree"` and reports both files accurately.
  - `diff_file_matches_full_diff_slice_byte_exact`: asserts `diff_file(fx.path(), "tracked.txt", None)` and `diff_file(fx.path(), "notes/new.txt", None)` return `DiffFile` whose `.raw` is byte-identical to the corresponding `DiffFile.raw` from `diff()`.
  - `diff_file_rejects_absolute_parent_and_outside_paths`: asserts `diff_file` rejects `/etc/passwd`, `C:\Windows\win.ini` (and Windows drive-rooted paths), `../outside.txt`, `sub/../../outside.txt`, `bad\0path`, a symlink inside the repo pointing outside `repo_root`, and `base = Some("--ext-diff")` with `git.invalid_path` / `git.invalid_base` before spawning `git`.
  - `diff_file_handles_spaces_and_unicode_paths`: creates `"dir with spaces/café résumé.txt"`, asserts both `diff_summary` and `diff_file` return the unquoted path and byte-exact `.raw` matching `diff()`.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `cargo test --manifest-path src-tauri/Cargo.toml --lib diff_summary_` and `cargo test --manifest-path src-tauri/Cargo.toml --lib diff_file_` → FAIL.
- [x] **Step 3: Implement `diff_summary`, `diff_file`, IPC commands, and TS wrappers (DeepSeek)**
      Implement `validate_base`, `validate_repo_relative_path`, `diff_summary`, and `diff_file` in `src-tauri/src/git/mod.rs` (parsing `--numstat -z` and `--raw --no-abbrev -z` with NUL splits so spaces/unicode never corrupt paths). Register commands in `src-tauri/src/lib.rs` and add wrappers in `src/lib/types.ts` + `src/lib/ipc.ts`.
- [x] **Step 4: Run verification**
      Run `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`, `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`, and `pnpm typecheck` → PASS.
- [x] **Step 5: Commit**
      `perf(git): add metadata-only git_diff_summary and lazy git_diff_file commands`

---

### Task 8: Lazy `git` store, line-capped `DiffLines`, and dynamic-height virtualized `DiffPanel`

**Design Decision:**

1. **Store (`src/stores/git.ts`):** Store `GitDiffSummary` in `useGitStore` instead of full patches, track `reviewed` with an `O(1)` `Map` keyed by `path` against `patchHash`, and load individual file patches on expand via `gitDiffFile`.
2. **Large single-file diff cap (`src/components/diff/DiffLines.tsx`):** Virtualizing only the file list is insufficient when a single file contains 12,000+ lines. Cap `UnifiedLines` and `SplitLines` at `MAX_INITIAL_DIFF_LINES = 2000` lines/rows (`data-diff-line-row` on each row) and render a `"Show all {total} lines"` button when truncated (resetting `showAll` when `raw` changes) so clicking reveals the remaining lines cleanly without nested scroll traps.
3. **Dynamic-height `useVirtualRows` (`src/components/diff/useVirtualRows.ts`):**
   - Keys measured heights by stable `getItemKey(index)` (`dir:<dir>` / `file:<path>`), NOT raw array index, so directory expand/collapse preserves cached measurements.
   - Builds prefix-sum `offsets: number[]` and `totalHeight: number` from `measuredHeights.get(key) ?? estimateHeight(index)`, and binary-searches `offsets` (`O(log N)`) for `[scrollTop, scrollTop + viewportHeight]` + `overscan`.
   - `measureElement(key, el)` attaches a shared `ResizeObserver` (guarded by `typeof ResizeObserver !== "undefined"` for JSDOM) and also reads `el.getBoundingClientRect().height` on attach, ignoring `<= 0` (so JSDOM zero-layout never overwrites estimates).
   - **Dynamic expand/collapse + scroll anchoring:** whenever a measured height changes by `>= 0.5px`, compute `delta = nextHeight - prevHeight`. If that row's `offsetTop < scrollEl.scrollTop` (a row above the viewport expanded or collapsed), synchronously adjust `scrollEl.scrollTop += delta` and update local `scrollTop` state so visible rows stay anchored without jumping, then recompute `offsets` and `totalHeight`.
4. **Collapsed large-dir defaults (`src/components/diff/DiffPanel.tsx`):** When `files.length > 200` (or a directory has `> 100` files), default directories collapsed while keeping viewport virtualization active even when all directories are expanded.

**Files:**

- Create: `src/components/diff/useVirtualRows.ts`
- Modify: `src/stores/git.ts`, `src/components/diff/DiffLines.tsx`, `src/components/diff/DiffPanel.tsx`
- Modify tests: `tests/diff-panel.test.tsx`, `tests/composer.test.tsx`, `tests/shell-layout.test.tsx`

**Interfaces:**

- `src/stores/git.ts`:
  ```ts
  export interface FilePatchState {
    loading: boolean;
    file?: DiffFile;
    error?: string;
  }

  export interface GitThreadState {
    // ...existing fields...
    diff: GitDiffSummary | null;
    filePatches: Record<string, FilePatchState>;
  }

  loadFileDiff: (threadId: string, path: string) => Promise<void>;
  toggleReviewed: (threadId: string, path: string, patchHash: string) => void;
  ```
  - `refresh(threadId)` calls `Promise.all([gitStatus(threadId), gitDiffSummary(threadId)])`, clears stale `filePatches`, and reconciles `reviewed` via `new Map(diff.files.map((f) => [f.path, f.patchHash]))` in `O(N)`.
- `src/components/diff/DiffLines.tsx`:
  ```ts
  export const MAX_INITIAL_DIFF_LINES = 2000;
  ```
  - `UnifiedLines` and `SplitLines` memoize `parseDiffLines(raw)` / `toSplitRows(...)`, mount up to `MAX_INITIAL_DIFF_LINES` `[data-diff-line-row]` items initially, and render `<button type="button">Show all {total} lines</button>` when `total > MAX_INITIAL_DIFF_LINES`.
- `src/components/diff/useVirtualRows.ts`:
  ```ts
  export interface VirtualItem {
    index: number;
    key: string;
    offsetTop: number;
    height: number;
  }

  export function useVirtualRows(opts: {
    count: number;
    getItemKey: (index: number) => string;
    scrollRef: RefObject<HTMLDivElement | null>;
    estimateHeight: (index: number) => number;
    overscan?: number;
    fallbackViewportHeight?: number; // default 600 so JSDOM & initial render mount viewport slice
  }): {
    totalHeight: number;
    virtualItems: VirtualItem[];
    measureElement: (key: string, el: HTMLElement | null) => void;
    onScroll: () => void;
  };
  ```
- `src/components/diff/DiffPanel.tsx`:
  - Memoize `grouped = useMemo(() => groupByDir(files), [files])` and `rows: DiffTreeRow[]` (`dir` rows + `file` rows for open dirs; `defaultDirOpen(dirFiles.length, files.length)` returns `files.length <= 200 && dirFiles.length <= 100`).
  - Render a single positioned scroll container (`style={{ height: totalHeight, position: "relative" }}`) mounting ONLY `virtualItems` (`ref={(el) => measureElement(item.key, el)}`) with `data-diff-file-row` on file items and `data-diff-dir-row` on directory items.
  - Expanding a `FileCard` triggers `loadFileDiff(threadId, file.path)` if not cached and shows a compact `"Loading diff…"` state until `UnifiedLines` / `SplitLines` renders the byte-exact `file.raw`.

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
      In `tests/diff-panel.test.tsx`, add:
  - `describe("DiffPanel large diff virtualization", ...)`:
    1. `"mounts only visible viewport rows when rendering 2,000 changed files and loads file patch lazily on expand"`:
       - Seed `useGitStore` with 2,000 `DiffFileSummary` entries across 100 directories (`dir-00/file-00.ts` … `dir-99/file-19.ts`, 20 files/dir).
       - Mock `gitDiffFile` returning a single `DiffFile` with `raw: "diff --git a/..."`.
       - Render `<DiffPanel threadId="th-big" />`, assert `"0/2000 reviewed"` is visible, assert `document.querySelectorAll("[data-diff-file-row], [data-diff-dir-row]").length < 100`, expand a directory, click a file card, and assert `gitDiffFile` was called ONCE for that path and diff content renders.
    2. `"caps DiffLines at 2,000 rows for a 12,000-line patch and reveals all on click"`:
       - Construct a 12,000-line unified patch (`12000` `-line` / `+line` rows), render `<UnifiedLines raw={patch12k} />`, assert `document.querySelectorAll("[data-diff-line-row]").length < 2100`, assert `screen.getByRole("button", { name: /Show all 12,?00[0-9] lines/i })` is visible, click it, and assert `document.querySelectorAll("[data-diff-line-row]").length >= 12000`.
  - `describe("useVirtualRows dynamic heights & scroll anchoring", ...)` (with a deterministic `ResizeObserver` + `getBoundingClientRect` mock in JSDOM):
    1. `"updates totalHeight and downstream offsets when an item expands and collapses"`: renders 50 items estimated at `34px`, fires `ResizeObserver` growing item `5` to `400px` then collapsing back to `34px`, asserts `totalHeight` and item `6`'s `offsetTop` shift by `+366px` then `-366px`.
    2. `"anchors scrollTop when a row above the viewport expands or collapses"`: sets `scrollEl.scrollTop = 500` (`onScroll()`), fires `ResizeObserver` growing row `2` (`offsetTop < 500`) by `+200px`, asserts `scrollEl.scrollTop` adjusts to `700`.
    3. `"updates virtualItems slice as the user scrolls"`: sets `scrollEl.scrollTop = 2000` and fires `onScroll()`, asserts `virtualItems[0].index > 0` and earlier rows unmount.
  - Also update `gitDiff` mocks in `tests/composer.test.tsx` and `tests/shell-layout.test.tsx` to mock `gitDiffSummary` (`{ repoRoot: "", base: "HEAD", totalAdded: 0, totalRemoved: 0, files: [] }`) and `gitDiffFile`.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/diff-panel.test.tsx` → FAIL.
- [x] **Step 3: Implement `useVirtualRows.ts`, update `src/stores/git.ts`, `src/components/diff/DiffLines.tsx`, and `src/components/diff/DiffPanel.tsx` (DeepSeek)**
      Build `useVirtualRows.ts`, refactor `src/stores/git.ts` to use `gitDiffSummary` + `gitDiffFile` + `O(1)` `patchHash` reconciliation, add the 2,000-line cap to `DiffLines.tsx`, and update `src/components/diff/DiffPanel.tsx`.
- [x] **Step 4: Run verification**
      Run all checks: - `pnpm typecheck` - `pnpm lint` - `pnpm test` - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write` - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
      All → PASS.
- [x] **Step 5: Commit**
      `perf(diff): virtualize DiffPanel rows, cap DiffLines, and lazy-load per-file diffs`

---

### Task 9: Acceptance — Full Gates, Built Binary Launch, Screenshots & `DEVLOG.md`

**Goal:** Verify the complete integrated application end to end on Windows, build the release binary, launch it, capture the v3 screenshots, and record an accurate `DEVLOG.md` entry without claiming any unperformed WebView interactions.

**Files:**

- Create: `docs/screenshots/v3-composer-picker.png`, `docs/screenshots/v3-shell-header.png`, `docs/screenshots/v3-theme-previews.png`, `docs/screenshots/v3-diff-large.png`
- Modify: `DEVLOG.md`

**Steps:**

- [x] **Step 1: Run full verification gates**
      Run every gate and record exact pass counts: - `pnpm typecheck` - `pnpm lint` - `pnpm test` - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write` - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [x] **Step 2: Build frontend bundle**
      Run `pnpm build` → PASS.
- [x] **Step 3: Kill running `pult-core` and build Tauri release binary**
      In PowerShell:
      `Get-Process pult-core -ErrorAction SilentlyContinue | Stop-Process -Force`
      `pnpm tauri build --no-bundle`
      Verify `src-tauri/target/release/pult-core.exe` is produced cleanly.
- [x] **Step 4: Launch built exe and capture v3 screenshots**
      Launch `src-tauri/target/release/pult-core.exe`, confirm the desktop window renders cleanly without crashing, and capture the four required screenshots to: - `docs/screenshots/v3-composer-picker.png` - `docs/screenshots/v3-shell-header.png` - `docs/screenshots/v3-theme-previews.png` - `docs/screenshots/v3-diff-large.png`
      _(Note: headless desktop automation on Windows cannot click inside the WebView2 surface. Capture the live `pult-core.exe` window for the default shell/composer view, and if secondary routes/popovers cannot be clicked via desktop automation in `pult-core.exe`, capture those specific route views honestly using headless Chromium/Playwright against `vite preview` / built `dist/` — and explicitly state in `DEVLOG.md` which screenshots came from the `pult-core.exe` window vs browser render, never claiming clicks that were not performed.)_
- [x] **Step 5: Update `DEVLOG.md`**
      Add a `## Pult v3 — composer, shell, theme previews & diff performance (2026-11-15)` entry covering: - What changed across Tasks 1–8 (single 40px header + route headers, removal of `NewThreadOptionsStrip`, unified `ProviderModelPicker` + stale-config pruning in UI and Rust, 14px proportional type scale + zero `10px`/`11px`, scoped `[data-theme]` previews, metadata-only `git_diff_summary` + path-validated `git_diff_file` + blob-SHA `patch_hash`, 2,000-line cap in `DiffLines`, dynamic-height `useVirtualRows`). - Exact test counts, `pnpm build`, and `pnpm tauri build --no-bundle` results. - Known limitation: **headless desktop automation cannot click inside the WebView**, noting honestly which actions were verified by automated tests / window launch and making zero unverified click claims.
- [x] **Step 6: Stop `pult-core` and commit acceptance artifacts**
      Ensure no background `pult-core` process remains running, verify `git status`, and commit:
      `git add DEVLOG.md docs/screenshots/v3-*.png && git commit -m "docs(devlog): record v3 acceptance verification and screenshots"`
