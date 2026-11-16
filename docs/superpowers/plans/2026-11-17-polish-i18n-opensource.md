# Pult UI Polish, Child Webview Browser, Full i18n & Open-Source Release Plan (2026-11-17)

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> **Baseline:** Verified against `HEAD` (`pult`, Tauri `2.12.5` + React `19.3.1` + Zustand `5.1.0` + TanStack Router `1.170.46` + Tailwind CSS v4 + Vitest `5.1.0` + Playwright `1.65.0`).
> **Constraint:** Zero new npm or Cargo dependencies (in-house typed i18n + Tokio localhost HTTP static server + Tauri `unstable` child `Webview`).

---

## Request Disposition Summary (`A–R`)

| ID    | Category        | Disposition     | Verified Target / Evidence                                                                                                                                                                                                                                                                  |
| ----- | --------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | Chrome          | **CONFIRMED**   | Move `Toggle sidebar` to `Sidebar.tsx:525` left of `<PultLogo />` (`gap-3` / 12px); fallback toggle in `ChatHeader`/`RouteHeader` only when `!sidebarOpen`; capitalize `"Pult"` across `Sidebar.tsx:532`, `PultLogo.tsx:7`, `ChatHeader.tsx`, `index.html:7`, `tauri.conf.json`, and routes |
| **B** | Chrome          | **CONFIRMED**   | Remove `border-b border-border-subtle` in `ChatHeader.tsx:123`, `WindowChrome.tsx:105,147`, `RightPanel.tsx:57`, `Sidebar.tsx:527`; remove `border-t border-border-subtle` in `Sidebar.tsx:687`                                                                                             |
| **C** | Chrome          | **CONFIRMED**   | Replace `<PanelTop size={15} />` (`"Toggle project info"`) in `WindowChrome.tsx:25-30` with a 15×15 lucide-matched page-with-two-lines SVG icon                                                                                                                                             |
| **D** | Sidebar Search  | **CONFIRMED**   | Remove `border border-border-subtle bg-surface` in `Sidebar.tsx:565`; update `buildSidebarGroups` (`src/stores/threads.ts:40-73`) to match both `project.name` and `thread.title`                                                                                                           |
| **E** | Thread Actions  | **CONFIRMED**   | Remove `...` overflow button, `menuOpen`, and inline `confirmDelete` popover in `ChatHeader.tsx:205-297`; retain Pin toggle (`ChatHeader.tsx:192-204`) and right-click context menu (`Sidebar.tsx:479-516`)                                                                                 |
| **F** | Alignment       | **CONFIRMED**   | Align `"No project"` row (`Sidebar.tsx:648`) from `px-2` (8px) to `pl-3 pr-2` (12px) to match `ProjectRow` badge (`px-2` + `pl-1`)                                                                                                                                                          |
| **G** | Footer          | **CONFIRMED**   | Insert `flex-1` spacer before Refresh/Updates button (`Sidebar.tsx:688-739`) to pin it to the right wall                                                                                                                                                                                    |
| **H** | Composer        | **CONFIRMED**   | Remove `border border-border-subtle bg-surface` from `ModePill` (`src/components/chat/ComposerControls.tsx:761`)                                                                                                                                                                            |
| **I** | Chat Header     | **CONFIRMED**   | Change `ChatHeader.tsx:140,164` title/input from `text-lg` to `text-sm font-medium`; reveal Rename pencil (`ChatHeader.tsx:165-177`) only on `group-hover/header` / `group-focus-within/header` / `focus-visible`                                                                           |
| **J** | Project Dialogs | **CONFIRMED**   | Replace native `<input type="radio">` in `CreateProjectDialog.tsx:165-184` and `ProjectSettingsDialog.tsx:140-160` with shared custom `<WorkspaceStrategyRadio>`                                                                                                                            |
| **K** | Keybindings     | **CONFIRMED**   | Add `formatBindingParts` (`src/lib/hotkeys.ts:67-72`); render each key in `<Kbd>` separated by visible `+` spans in `src/routes/settings.keybindings.tsx:79-85`                                                                                                                             |
| **L** | Browser         | **NEEDS SPIKE** | Replace `<iframe sandbox>` (`BrowserPanel.tsx`) with Tauri `unstable` `Window::add_child` + `WebviewBuilder` + localhost static server (`127.0.0.1:0`) for local HTML/JS/assets + centralized overlay occlusion; spike WebView2 HWND resize/clipping first                                  |
| **M** | Header Layout   | **CONFIRMED**   | Fix `pr-[136px]` in `ChatHeader.tsx:123` / `WindowChrome.tsx:147` only when `!rightPanelOpen`; keep left controls flush-left and stop top toggles shifting with a 136px gap when `RightPanel` opens                                                                                         |
| **N** | Timeline        | **CONFIRMED**   | Replace search-only `ToolGroupRow` (`MessagesTimeline.tsx:306-370`) with `ActionGroupRow` collapsing consecutive `tool` + `thought` + `trace` items with live active state, summary counts, and timestamp                                                                                   |
| **O** | Thoughts        | **CONFIRMED**   | Filter completed thoughts whose rounded duration is `0s` (`Math.round((endedAt - startedAt) / 1000) === 0` or empty text) in `MessagesTimeline.tsx`                                                                                                                                         |
| **P** | Spinner         | **CONFIRMED**   | Add lightweight `<ThinkingAscii />` inline ASCII/Braille spinner (respecting `prefers-reduced-motion`) before `"Thinking"` in `MessagesTimeline.tsx:567-573`                                                                                                                                |
| **Q** | Full i18n       | **CONFIRMED**   | In-house typed i18n (`src/lib/i18n/`) supporting `en`, `ru`, `de`, `es`, `ja`, `zh`, `fr`, `settings.language`, `Intl` formatters, `localizeIpcError`, structured Rust `PultError` codes, and key-parity tests                                                                              |
| **R** | Open Source     | **CONFIRMED**   | Remove dead `ProjectCard.tsx` and duplicate `pult-transparent.svg`; harden `.gitignore`; add `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `.github/` templates, CI, updated `README.md`, and v0.1.0 checklist                                                                         |

---

## Wave & Dependency Architecture

Tasks are grouped into 5 waves with **disjoint file ownership within every parallel wave** so sub-agents never collide on the same files:

- **Wave 1 — Foundations & High-Risk Spike (4 parallel tasks):**
  - `T01` [HIGH] Spike **L**: Tauri `"unstable"` `Window::add_child` WebView2 lifecycle + localhost static file server prototype (`src-tauri/src/browser/spike.rs` / Cargo check).
  - `T02` **Q** Core i18n engine, types, English base catalog, and `settings.language` store/DOM `lang` sync (`src/lib/i18n/`, `src/stores/settings.ts`).
  - `T03` **Q** Rust `PultError` structured code enrichment across `src-tauri/src/{ipc,git,runtime,config,workspace}`.
  - `T04` **R** Repo hygiene & dead-file removal (`ProjectCard.tsx`, duplicate root `pult-transparent.svg`, `.gitignore`).
- **Wave 2 — UI/UX Polish, Timeline & Child Webview Implementation (5 parallel tasks; `T09` depends on `T01`):**
  - `T05` (**A, B, C, E, I, M**): `WindowChrome.tsx`, `ChatHeader.tsx`, `RightPanel.tsx`, `PultLogo.tsx`, `index.html`, `src-tauri/tauri.conf.json`, `Sidebar.tsx` top bar only? **Disjoint split:** `T05` owns `WindowChrome.tsx`, `ChatHeader.tsx`, `RightPanel.tsx`, `PultLogo.tsx`, `index.html`, `tauri.conf.json`, `NewChatEmptyState.tsx`, `SignInActions.tsx`; `T06` owns ALL of `Sidebar.tsx` (including `T05`'s top-bar move/border/capitalization edits so `Sidebar.tsx` has a single owner!) + `src/stores/threads.ts`.
  - `T06` (**A-sidebar, B-sidebar, D, F, G**): `src/components/layout/Sidebar.tsx` + `src/stores/threads.ts`.
  - `T07` (**H, J, K**): `src/components/chat/ComposerControls.tsx`, `src/components/projects/WorkspaceStrategyRadio.tsx` (new), `CreateProjectDialog.tsx`, `ProjectSettingsDialog.tsx`, `src/lib/hotkeys.ts`, `src/components/command/CommandPalette.tsx`, `src/routes/settings.keybindings.tsx`.
  - `T08` (**N, O, P**): `src/components/chat/MessagesTimeline.tsx` (unified `ActionGroupRow`, 0s thought filter, `<ThinkingAscii />`).
  - `T09` (**L**, depends on `T01`): Full child Webview browser (`src-tauri/src/browser/`, `src-tauri/src/ipc/mod.rs`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`, `src/lib/tauri.ts`, `src/components/browser/BrowserPanel.tsx`, `src/stores/ui.ts`, `src/routes/__root.tsx`).
- **Wave 3 — Full i18n Rollout & Open-Source Deliverables (3 sequential/scoped tasks; depends on Wave 2 UI completion so route/component strings are stable):**
  - `T10` (**Q**, depends on `T02` + Wave 2): Author full `ru`, `de`, `es`, `ja`, `zh`, `fr` catalogs (`src/lib/i18n/locales/*.ts`) + parity test `tests/i18n.test.ts`.
  - `T11` (**Q**, depends on `T02`, `T03`, `T10` + Wave 2): Wire `useT()`, `t()`, `Intl` formatters, `localizeIpcError`, and Settings General language selector across all routes, components, and non-React registries (`settings.ts`, `commands.ts`, `fileGitStatus.ts`, `usage.ts`, `hotkeys.ts`).
  - `T12` (**R**, independent after `T04`): Add `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, harden `.github/workflows/ci.yml`, update `README.md`, `package.json`, `Cargo.toml`, and release checklist.
- **Wave 4 — QA & Regression Test Updates (1 task; depends on Waves 2–3):**
  - `T13`: Update modified UI unit tests (`shell-layout.test.tsx`, `sidebar.test.tsx`, `thread-actions.test.tsx`, `hotkeys.test.ts`, `messages-timeline.test.tsx`, `browser-panel.test.tsx`, `settings-pages.test.tsx`, `project-dialog.test.tsx`) + add new behavioral tests.
- **Wave 5 — Full Gate Verification & Adversarial Plan/Diff Audit (1 task; depends on Waves 1–4):**
  - `T14`: Full Rust/Vitest/Playwright/build gate + adversarial review of `T01–T14` and `2026-11-16-ade-review-followup.md` + mandatory fix pass.

---

## Wave 1 — Foundations & High-Risk Spike

### T01 — [HIGH] Spike: Tauri `unstable` Child Webview & Localhost Asset Server (`L`)

- **Severity:** P0 (Technical Risk Gate)
- **Dependencies:** None
- **Files & Symbols:**
  - `src-tauri/Cargo.toml`: evaluate `tauri = { version = "2", features = ["unstable"] }`.
  - `src-tauri/src/browser/mod.rs` (prototype module)
- **Concrete Investigation & Spike Goals:**
  1. Confirm `tauri = "2.12.5"` (`wry = 0.57.2`, `tao = 0.37.2`) compiles cleanly on Windows with `features = ["unstable"]` exposing `tauri::window::Window::add_child` and `tauri::webview::WebviewBuilder`.
  2. Verify Windows WebView2 child HWND behavior:
     - `add_child(WebviewBuilder::new("pult-browser-child", WebviewUrl::External(url)), LogicalPosition, LogicalSize)` inside the main window (`main`).
     - Dynamic `set_position` / `set_size` (matching `ResizeObserver` rect of the `BrowserPanel` viewport `div` converted by `window.devicePixelRatio` or logical CSS pixels).
     - `hide()` / `show()` visibility toggling (critical: native WebView2 child HWNDs paint over HTML/CSS regardless of `z-index`!).
     - Navigation hooks: `on_navigation`, `on_page_load`, `navigate(Url)`, `eval("window.history.back()")` / `forward()` / `location.reload()`.
     - **Custom URI / local file check:** Prototype an ephemeral `127.0.0.1:0` Tokio `TcpListener` HTTP server scoped to a canonicalized workspace root serving `.html`, `.js`, `.mjs`, `.css`, `.svg`, `.png`, `.jpg`, `.webp`, `.wasm`, `.json` with strict path-traversal canonicalization (`canonical_target.starts_with(&canonical_root)`). Verify `<script type="module" src="./app.js">` and relative CSS/assets resolve natively inside the child `Webview` without `srcDoc` or `file://` CORS blocks.
  3. **Fallback criterion:** If `add_child` on Windows exhibits unrecoverable DPI scaling corruption, focus stealing that traps keyboard shortcuts permanently, or crash-on-drop bugs, document the blocker and switch `T09` to a managed auxiliary `WebviewWindow` docked alongside/synced to the main window rather than an embedded `<iframe sandbox>`.
- **Verification:** `cargo check --manifest-path src-tauri/Cargo.toml` + small headless/windowed test verifying `Window::add_child` compiles and Tokio static server returns `200 OK` for `index.html` + `./main.js` and `403` for `../secret`.

---

### T02 — Core Zero-Dependency i18n Engine, English Catalog & Language Setting (`Q`)

- **Severity:** P1
- **Dependencies:** None
- **Files & Functions:**
  - `src/lib/i18n/types.ts` (new): `LocaleId` (`"en" | "ru" | "de" | "es" | "ja" | "zh" | "fr"`), `SUPPORTED_LOCALES`, `TranslationKey`, `TranslationParams`.
  - `src/lib/i18n/locales/en.ts` (new): canonical nested/flat typed dictionary `en` (`as const satisfies Record<string, string>`).
  - `src/lib/i18n/index.ts` (new): `t(key, params?, locale?)`, `useT()`, `formatDate`, `formatTime`, `formatRelativeTime`, `formatNumber`, `localizeIpcError(err, t)`.
  - `src/stores/settings.ts`: add `language: LocaleId` (default `"en"`), `setLanguage(locale: LocaleId)` persisting via `settingsSet("language", locale)` and syncing `document.documentElement.lang = locale`, plus hydrating `"language"` in `load()`.
- **Concrete Change:**
  - Validate persisted `"language"` against `SUPPORTED_LOCALES` (fallback `"en"` on unknown value).
  - Provide interpolation `{{param}}` with TypeScript compile-time key checking (`TranslationKey = keyof typeof en`) and fallback chain `locales[activeLocale]?.[key] ?? en[key] ?? key`.
  - Expose `localizeIpcError(err, t)`: maps `PultError.code` (`"url.empty"`, `"project.empty_name"`, `"git.worktree_dirty"`, etc.) to `errors.<code>` keys when present, interpolating safe metadata or falling back to `err.message`.
- **Acceptance Tests (`tests/i18n-core.test.ts`):**
  - `t()` interpolates `{{count}}` / `{{name}}` placeholders and falls back cleanly to `en`.
  - `useSettingsStore.setLanguage("ja")` persists via `settingsSet` and updates `document.documentElement.lang`.
  - `localizeIpcError` maps known structured codes and preserves unknown fallback messages.
- **Verification:** `pnpm vitest run tests/i18n-core.test.ts && pnpm typecheck`.

---

### T03 — Structured Rust `PultError` Codes for User-Facing Errors (`Q`)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src-tauri/src/ipc/mod.rs`: replace raw `"internal"` string errors in user-facing commands (`open_url`, `open_in_editor`, `projects_create`, `queue_enqueue`, `attach_image`, etc.) with `PultError::with_code(code, message)`.
  - `src-tauri/src/git/mod.rs`, `src-tauri/src/workspace.rs`, `src-tauri/src/config.rs`, `src-tauri/src/runtime/mod.rs`: ensure user-visible validation errors emit stable dot-separated codes (`project.empty_name`, `url.empty`, `url.too_long`, `url.invalid_scheme`, `url.invalid_chars`, `url.no_host`, `editor.empty_path`, `editor.unc_blocked`, `editor.not_found`, `editor.launch_failed`, `browser.launch_failed`, `queue.empty_message`, `workspace.not_found`, `image.unc_blocked`, `image.outside_workspace`, `image.too_large`, `image.unsupported_type`).
- **Concrete Change:**
  - Preserve backwards-compatible English `.message` strings on the Rust side so CLI/headless callers remain readable, while exposing exact `code` strings so the frontend (`T11`) can localize every error cleanly without parsing English prose.
- **Acceptance Tests (`src-tauri/src/ipc/mod.rs` unit tests):**
  - Assert `open_url` rejects empty/bad-scheme URLs with `err.code == "url.empty"` / `"url.invalid_scheme"` and `projects_create` rejects blank names with `"project.empty_name"`.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc::` and `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`.

---

### T04 — Repo Audit & Dead-Code / Untracked Artifact Cleanup (`R`)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - Remove `src/components/layout/ProjectCard.tsx` (0 imports in `src/` or `tests/`, superseded by `ProjectInfoWidget.tsx`).
  - Remove `src/components/ui/badge.tsx` if still unreferenced (`0` imports verified across `src/` and `tests/`).
  - Remove duplicate root `pult-transparent.svg` (keep `public/pult-transparent.svg`, referenced by `index.html`, and keep `pult-icon.svg`, referenced by `scripts/gen-icon.mjs`).
  - Update `.gitignore`: add `outputs/`, `docs/reviews/`, `.pult/`, `*.db`, `*.db-wal`, `*.db-shm`.
  - Remove untracked local artifacts from working tree before any release (`outputs/screenshots/review-followup-final.png`, `docs/reviews/` local scratch if not meant for public history — confirm with user before deleting `docs/reviews/` vs gitignoring it).
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test`.

---

## Wave 2 — UI/UX Polish, Unified Timeline & Child Webview Browser

### T05 — Top Chrome, `ChatHeader`, `WindowChrome`, `RightPanel` & `"Pult"` Branding (`A, B, C, E, I, M`)

- **Severity:** P1
- **Dependencies:** None
- **Files & Functions:**
  - `src/components/layout/WindowChrome.tsx`:
    - `PanelToggleButtons`: export optional `showSidebarToggle?: boolean` (default `false` when `sidebarOpen` is true, `true` when `!sidebarOpen`) or separate `SidebarToggleButton` so when `sidebarOpen` is true, `Sidebar.tsx` (`T06`) renders `Toggle sidebar` top-left; when `!sidebarOpen`, `ChatHeader` and `RouteHeader` render `SidebarToggleButton` on the far left so the sidebar can always be reopened!
    - Middle icon (`"Toggle project info"`, `WindowChrome.tsx:25-30`): replace `<PanelTop size={15} />` with a crisp 15×15 page-with-two-lines SVG icon (`viewBox="0 0 24 24"`, `strokeWidth={2}`, rounded rect page + 2 interior horizontal lines) matching `PanelLeft` / `PanelRight` weight.
    - `TauriWindowControls` (`WindowChrome.tsx:105`): remove `border-b border-border-subtle`.
    - `RouteHeader` (`WindowChrome.tsx:147`): remove `border-b border-border-subtle`; replace unconditional `pr-[136px]` with `!rightPanelOpen && isTauri() ? "pr-[136px]" : "pr-3"` (since `RightPanel` sits underneath `WindowControls` when open); put `!sidebarOpen && <SidebarToggleButton />` at the far left before `<h1>`.
  - `src/components/layout/RightPanel.tsx`:
    - Line `57`: remove `border-b border-border-subtle` (keep `pr-[136px]` when `isTauri()` so `Back to surfaces` clears `WindowControls`, while `ChatHeader` stops double-reserving 136px!).
  - `src/components/chat/ChatHeader.tsx`:
    - **B:** Remove `border-b border-border-subtle` on `<header>` (`line 123`).
    - **M:** Read `rightPanelOpen` and `sidebarOpen` from `useUiStore`. Render `!sidebarOpen && <SidebarToggleButton />` at the far left of `<header>`, keep project breadcrumb + title strictly flush-left (`justify-start`), and apply `pr-[136px]` ONLY when `isTauri() && !rightPanelOpen` (otherwise `pr-3`), eliminating the big dead gap/shift next to the top-right toggles when `RightPanel` opens.
    - **A:** When rendering the breadcrumb when no project exists on welcome/general/app context or brand references, capitalize `"Pult"`; also normalize `"pult"` default brand strings (`PultLogo.tsx:7` `aria-label="Pult"`, `index.html:7`, `src-tauri/tauri.conf.json:3,17`, `NewChatEmptyState.tsx:34`, `SignInActions.tsx:84`). _(Note: repository folder basenames like `project.name` from disk are user folder names, while app-owned workspace/title strings use `"Pult"`)._
    - **E:** Remove `MoreHorizontal` `"Thread actions"` button (`lines 205-213`), `menuOpen` dropdown (`Snooze` / `Mark settled` / `Delete thread`, `lines 214-263`), inline `confirmDelete` popover (`lines 268-297`), and `removeThread` helper; keep `<Pin>` / `<PinOff>` button (`lines 192-204`).
    - **I:** Change `<h1>` and rename `<input>` (`lines 140, 164`) from `text-lg` to `text-sm font-medium` (matching project name at `line 158`); add `group/header` on `<header>` (or title wrapper) and `opacity-0 transition group-hover/header:opacity-100 group-focus-within/header:opacity-100 focus-visible:opacity-100` on Rename pencil `<button>` (`line 173`).
- **Verification:** `pnpm typecheck && pnpm lint` (`T13` updates `shell-layout.test.tsx` & `thread-actions.test.tsx`).

---

### T06 — `Sidebar` Top Toggle, Borderless Search, Project+Thread Search, Alignment & Footer (`A, B, D, F, G`)

- **Severity:** P1
- **Dependencies:** None (coordinate export of `SidebarToggleButton` with `T05` from `WindowChrome.tsx`)
- **Files & Functions:**
  - `src/components/layout/Sidebar.tsx`:
    - **A & B (Top bar `lines 525-551`):** Remove `border-b border-border-subtle`; move `Toggle sidebar` button (`SidebarToggleButton` / `PanelLeft size={15}`) to the far left inside the top `h-10` bar before `<PultLogo />` with `gap-3` (12px gap between toggle and logo+title, `px-3`); capitalize `<span ...>Pult</span>` (`line 532`). Ensure there is NO separator line above or below this top bar.
    - **D (Search box `line 565`):** Remove `border border-border-subtle bg-surface` from search `<input>` (use `border-0 bg-transparent` with subtle `focus:bg-hover/40` or clean underline-free focus state). Update `placeholder` / `aria-label` to cover projects & threads (`"Search"`).
    - **F (`"No project"` alignment `line 648`):** Change `px-2 py-1.5` to `pl-3 pr-2 py-1.5` so the `SquareDashed` 16×16 icon box aligns at 12px horizontally with `ProjectRow`'s project monogram (`px-2` + `pl-1` = 12px).
    - **G (Footer `lines 687-739`):** Remove `border-t border-border-subtle` on `<footer>` (`B`); insert `<span className="flex-1" />` before the Refresh/Updates `<Tooltip>` (`line 719`) so Refresh/Updates sits pinned against the right wall.
    - **E verification:** Confirm `Sidebar.tsx` `ThreadRow` context menu (`lines 479-516`) retains `Snooze`, `Mark settled`, and `Delete` (with `confirmDeleteThread` confirmation).
  - `src/stores/threads.ts` (`buildSidebarGroups`, `lines 40-73`):
    - **D (Search matching):** Match `const q = opts.query.trim().toLowerCase()`. Compute `projectMatches = project.name.toLowerCase().includes(q)`.
      - If `projectMatches` is true: include that project group and include all its threads that pass `opts.filter` (and show the project even if it has 0 threads when `opts.filter === "all"`).
      - Else: include threads in that project whose `thread.title.toLowerCase().includes(q)` (and pass `opts.filter`), showing the project group when `matchingThreads.length > 0`.
      - For `"No project"` (`project === null`): match against `thread.title.toLowerCase().includes(q)` (or `"no project".includes(q)`? Keep `"no project"` optional/excluded unless projectless threads match title, or match `"no project"` — clarify: `q` matches projects and threads, so match project names for real projects + thread titles across all groups).
- **Verification:** `pnpm typecheck && pnpm lint` (`T13` updates `sidebar.test.tsx`).

---

### T07 — `ModePill`, Custom Workspace Radios & Keybinding `+` Separators (`H, J, K`)

- **Severity:** P2
- **Dependencies:** None
- **Files & Functions:**
  - `src/components/chat/ComposerControls.tsx` (`ModePill`, `line 761`):
    - **H:** Remove `border border-border-subtle bg-surface` so `ModePill` renders purely as icon + label + chevron (`flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) px-1.5 py-0.5 text-xs text-text-secondary transition hover:bg-hover`).
  - `src/components/projects/WorkspaceStrategyRadio.tsx` (new), `CreateProjectDialog.tsx` (`lines 165-184`), `ProjectSettingsDialog.tsx` (`lines 140-160`):
    - **J:** Build accessible `<WorkspaceStrategyRadio>` wrapping `<input type="radio" className="sr-only peer" />` with a styled 16×16 circular indicator (`border-border-strong` unchecked, `border-accent bg-accent/10` checked with centered 8×8 `rounded-full bg-accent` dot, plus `peer-focus-visible:ring-2 ring-accent/40`). Replace native radios in both `CreateProjectDialog` and `ProjectSettingsDialog` while keeping card text `"Direct folder"` / `"Git worktree"` and keyboard arrow navigation intact.
  - `src/lib/hotkeys.ts` (`lines 67-72`), `src/routes/settings.keybindings.tsx` (`lines 79-85`), `src/components/command/CommandPalette.tsx`:
    - **K:** Export `formatBindingParts(binding: string): string[]` mapping `"Mod" -> MOD_KEY`, `"Alt" -> "Alt"`, `"Shift" -> "⇧"`, and normalizing single-letter keys (`p.length === 1 ? p.toUpperCase() : p` for clean `<Kbd>` display). Keep `formatBinding(binding)` returning `formatBindingParts` joined cleanly (`+` or unchanged — check `tests/hotkeys.test.ts`!).
    - In `src/routes/settings.keybindings.tsx`, inside the rebind `<button>`, render `<span className="inline-flex items-center gap-1">` containing each part wrapped in `<Kbd>` separated by `<span aria-hidden className="text-text-tertiary">+</span>`. Also use `formatBindingParts` in `CommandPalette.tsx` if shortcuts render multiple keys.
- **Verification:** `pnpm typecheck && pnpm lint`.

---

### T08 — Unified `ActionGroupRow`, 0s Thought Suppression & ASCII Thinking Spinner (`N, O, P`)

- **Severity:** P1
- **Dependencies:** None
- **Files & Functions:**
  - `src/components/chat/MessagesTimeline.tsx`:
    - **O (Filter 0s thoughts):** Extract helper `isZeroSecondCompletedThought(item: ChatItem): boolean`: returns `true` when `item.type === "thought" && !item.streaming && (item.text.trim().length === 0 || Math.round(Math.max(0, item.endedAt - item.startedAt) / 1000) === 0)`. Filter these out before building `TimelineRows` (and inside expanded `ActionGroupRow`), so transient 0s thought bubbles never appear between tool calls or on their own.
    - **P (`<ThinkingAscii />`):** Add a lightweight `ThinkingAscii` component cycling through compact Braille/ASCII frames (`["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]` or `["|", "/", "-", "\\"]` every `90ms`), rendering a static `"·"` or `"*"` when `window.matchMedia("(prefers-reduced-motion: reduce)").matches`, marked `aria-hidden="true"`, placed immediately before `"Thinking"` in active thought rows and active `ActionGroupRow` summaries.
    - **N (`ActionGroupRow`):** Replace `ToolGroupRow` in `TimelineRows` (`lines 306-370`) with `ActionGroupRow`:
      - Groups any consecutive run of `{ type: "tool" | "thought" | "trace" }` (after filtering 0s completed thoughts) when length `>= 1` for tools/mixed runs (or `>= 2` items; single standalone thought stays `<ThoughtGroup>` with `<ThinkingAscii />`, while any run containing `>= 2` actions/tools/thoughts collapses into `ActionGroupRow` — and if a single run is actively streaming, or 2+ items exist, collapse cleanly T3-style!).
      - Summary builder `summarizeActionGroup(items)`:
        - **While active** (`some(tool => pending/running)` or `some(thought => streaming)`): show `<ThinkingAscii />` + latest in-progress action title (e.g. `"Running: <title>"` or `"Thinking"`), with live elapsed or start timestamp on the right.
        - **When completed**: count distinct file edits (`kind === "edit"` / `"write"` / `"delete"`), commands (`kind === "execute"`), searches/reads (`kind === "search"` / `"read"`), and other tool/trace steps -> e.g., `"Changed 5 files, ran 6 commands"` / `"Searched 4 times, read 2 files"`, plus right-aligned timestamp (`formatTime(lastTs)` or duration) and `<ChevronRight>` toggle.
      - Clicking expands/collapses chronologically (`ToolRow`, `ThoughtGroup`, `TraceRow`), and newly streamed tool events append inside the active group in chronological order.
- **Verification:** `pnpm typecheck && pnpm lint` (`T13` updates `messages-timeline.test.tsx`).

---

### T09 — Child Webview Browser + Ephemeral Local Static Server (`L`)

- **Severity:** P1 (Architecture Change)
- **Dependencies:** `T01` (must use the spike-verified architecture)
- **Files & Functions:**
  - `src-tauri/Cargo.toml`: enable `tauri = { version = "2", features = ["unstable"] }`.
  - `src-tauri/src/browser/mod.rs` (new):
    - `LocalStaticServer`: `tokio::net::TcpListener::bind("127.0.0.1:0")` serving canonicalized workspace root files + relative `.html`/`.htm`/`.js`/`.mjs`/`.css`/`.svg`/`.png`/`.jpg`/`.webp`/`.woff2`/`.json`/`.wasm` with MIME types, `Cache-Control: no-store`, and strict path-traversal rejection (`403`). Auto-allocates one server per active root (or maps `/root-<id>/...`) with clean shutdown on `AppState` drop.
    - `BrowserWebviewManager`: wraps Tauri child `Webview` (`pult-browser-child`) attached to `"main"` via `Window::add_child`. Tauri IPC commands:
      - `browser_navigate(url_or_path, thread_id)`: opens external `http(s)://` URLs directly (NO `X-Frame-Options` / CSP iframe blocks!) OR maps local `.html`/workspace-relative paths to `http://127.0.0.1:<port>/...` so ES modules, relative assets, fetch, and CSS work identically to a dev server.
      - `browser_set_bounds(x, y, width, height, visible)`: positions/resizes/shows/hides child `Webview` in logical coordinates.
      - `browser_history(action: "back" | "forward" | "reload")`: drives child webview history & reload.
      - `browser_close()`: closes child webview when panel closes/unmounts.
      - Emits `"browser:navigated"` Tauri event (`url`, `title`, `loading`) back to React so the address bar tracks clicks/redirects inside pages!
  - `src-tauri/src/ipc/mod.rs` & `src-tauri/src/lib.rs`: register new commands + `BrowserWebviewManager` state; replace or retire `browser_check_frame_headers` / `workspace_read_html` usage.
  - `src-tauri/capabilities/default.json`: add any required `core:webview:*` permissions.
  - `src/lib/tauri.ts`: add typed wrappers for the new browser IPC commands + event listener.
  - `src/stores/ui.ts`: track modal/overlay occlusion flags (`contextMenuOpen` or shared `overlayCount` alongside `paletteOpen`, `imagePreview`, `activeElicitation`).
  - `src/components/browser/BrowserPanel.tsx`:
    - Measure host viewport `<div>` via `ResizeObserver` + `getBoundingClientRect()` (and window resize/sidebar resize) -> call `browser_set_bounds` debounced via `requestAnimationFrame`.
    - Compute `occluded = paletteOpen || Boolean(imagePreview) || Boolean(activeElicitation) || !rightPanelOpen || rightPanelTab !== "browser" || menuOrDialogOpen`; pass `visible = !occluded && hasUrl` to `browser_set_bounds` so overlays (Command Palette, Dialogs, Lightbox, Context Menus) are NEVER covered by the native HWND!
    - Keep browser-mode Vitest fallback (non-Tauri test shim) cleanly stubbed so Playwright/Vitest work without Tauri internals.
- **Verification:** `cargo test --manifest-path src-tauri/Cargo.toml --lib browser::` + `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` + manual/Playwright Tauri verification on `https://github.com`, `https://google.com`, and a local workspace `index.html` importing `./app.js` and `./style.css`.

---

## Wave 3 — Full i18n Rollout & Open-Source Deliverables

### T10 — Complete 7-Locale Translation Catalogs & Parity Test (`Q`)

- **Severity:** P1
- **Dependencies:** `T02`, Wave 2 UI (`T05–T09`) finalized
- **Files & Functions:**
  - `src/lib/i18n/locales/{en,ru,de,es,ja,zh,fr}.ts` (new): complete translations for all navigation, sidebar, headers, chat timeline, composer, approval/elicitation cards, browser panel, terminal/files/diff panels, git/PR pages, usage page, welcome/onboarding, settings pages (Appearance, General, Providers, Keybindings, Projects, About), command palette, hotkey descriptions, permission modes, and all `errors.*` keys.
  - `src/lib/i18n/index.ts`: register all 7 locales.
  - `tests/i18n.test.ts` (new): parity suite asserting:
    1. Every locale in `SUPPORTED_LOCALES` (`en`, `ru`, `de`, `es`, `ja`, `zh`, `fr`) has the **exact same key set** as `en` (0 missing keys, 0 extra keys).
    2. Zero empty/whitespace-only translations.
    3. Placeholder tokens (`{{...}}`) match `en` identically in every translation string.
- **Verification:** `pnpm vitest run tests/i18n.test.ts && pnpm typecheck`.

---

### T11 — Wire `useT()`, `t()`, `Intl` Formatters & Language Picker (`Q`)

- **Severity:** P1
- **Dependencies:** `T02`, `T03`, `T10`
- **Files & Functions:**
  - **Settings UI:** `src/routes/settings.general.tsx` — add Language selector (`English`, `Русский`, `Deutsch`, `Español`, `日本語`, `中文`, `Français`) bound to `useSettingsStore((s) => s.language)` + `setLanguage`.
  - **Components & Routes:** Replace hardcoded UI strings with `useT()` across:
    - `Sidebar.tsx`, `WindowChrome.tsx`, `RightPanel.tsx`, `ChatHeader.tsx`, `MessagesTimeline.tsx`, `Composer.tsx`, `ComposerControls.tsx`, `NewChatEmptyState.tsx`, `ImageLightbox.tsx`
    - `BrowserPanel.tsx`, `TerminalPanel.tsx`, `FilesPanel.tsx`, `DiffPanel.tsx`, `PullRequestsList.tsx`, `ProjectInfoWidget.tsx`
    - `CreateProjectDialog.tsx`, `ProjectSettingsDialog.tsx`, `WorkspaceStrategyRadio.tsx`, `CommandPalette.tsx`
    - All routes under `src/routes/` (`welcome.tsx`, `usage.tsx`, `pull-requests.tsx`, `settings*.tsx`).
  - **Non-React registries & helpers:** Convert static label constants to keyed getters or `t()` calls at read time:
    - `src/stores/settings.ts` (`PERMISSION_MODE_LABELS`, `PERMISSION_MODE_DESCRIPTIONS` -> getter helpers `getPermissionModeLabel(mode, t)`)
    - `src/lib/commands.ts` (`STATIC_COMMANDS` -> `labelKey` / translated `label`)
    - `src/lib/fileGitStatus.ts` (`DECORATIONS`)
    - `src/lib/usage.ts` & `src/lib/hotkeys.ts` (`MOD_KEY`, `Alt`, `Shift` where applicable)
    - `src/components/chat/MessagesTimeline.tsx` (`formatTime` -> `i18n.formatTime`, `STOP_REASON_LABELS`, `COMPACTION_LABELS`)
    - IPC error banners/toasts: pipe backend `PultError` through `localizeIpcError(err, t)`.
- **Verification:** `pnpm typecheck && pnpm lint && pnpm test`.

---

### T12 — Open-Source Licensing, Community Docs, CI & Release Checklist (`R`)

- **Severity:** P2
- **Dependencies:** `T04`
- **Files & Functions:**
  - `LICENSE` (new): MIT License (`2026 Pult Contributors`).
  - `package.json`: set `"license": "MIT"`, add `"repository"`, `"homepage"`, `"bugs"`, `"keywords"` (update `"private"` only if publishing npm package — keep `"private": true` for desktop app bundle while adding MIT `"license": "MIT"`).
  - `src-tauri/Cargo.toml`: add `license = "MIT"`, `repository = "..."`, `homepage = "..."`.
  - `CONTRIBUTING.md` (new): dev prerequisites (Node 22, pnpm, Rust stable, Windows WebView2 / Linux webkit2gtk / macOS Xcode CLT), architecture tour (`src/` vs `src-tauri/src/`), `pnpm test` / `cargo test` / Playwright commands, PR guidelines.
  - `SECURITY.md` (new): private vulnerability reporting instructions, local-first threat model (workspace sandboxing, permission modes, UNC blocking, localhost HTTP server scoping).
  - `.github/ISSUE_TEMPLATE/bug_report.yml`, `.github/ISSUE_TEMPLATE/feature_request.yml`, `.github/PULL_REQUEST_TEMPLATE.md` (new).
  - `.github/workflows/ci.yml`: verify/add `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `pnpm tauri build --no-bundle` (check current `ci.yml` triggers & caching).
  - `README.md`: update branding to `"Pult"`, current capabilities (browser child webview, i18n 7 languages, ACP providers, worktrees, timeline grouping), screenshots placeholder/instructions, MIT badge, build & run instructions.
  - **Append "Public GitHub & v0.1.0 Release Checklist"** section at bottom of this deliverable or `CONTRIBUTING.md`/plan output covering:
    - **DO NOT COMMIT**: `.pult/` (`pult.db`), `docs/reviews/`, `outputs/`, `src-tauri/target/`, `node_modules/`, `~/.tauri/*.key` updater private keys, `*.local`.
    - **GitHub Metadata**: Description, Topics (`tauri`, `react`, `rust`, `acp`, `ai-coding`, `developer-tools`, `desktop-app`), and draft v0.1.0 release notes.
- **Verification:** `pnpm lint` + `cargo check --manifest-path src-tauri/Cargo.toml` + `git status --short` clean of sensitive/local artifacts.

---

## Wave 4 — QA & Regression Test Updates

### T13 — Update Existing Tests & Add Regression Suite Coverage

- **Severity:** P1
- **Dependencies:** Waves 2 & 3 (`T05–T11`)
- **Files & Functions:**
  - `tests/shell-layout.test.tsx`: update assertions for `Toggle sidebar` living inside `Sidebar` when open and appearing left in `ChatHeader`/`RouteHeader` when `!sidebarOpen`; verify `pr-[136px]` moves from `ChatHeader` to `RightPanel` when `rightPanelOpen` is true and no header icons shift with a gap; verify `"Pult"` capitalization and borderless headers.
  - `tests/sidebar.test.tsx`: update `"pult"` -> `"Pult"`, add tests for project-name search matching (`buildSidebarGroups` matching project + threads, empty matching project), `"No project"` alignment class (`pl-3`), footer refresh `flex-1` right pin, and borderless search input.
  - `tests/thread-actions.test.tsx`: remove assertions for deleted `"Thread actions"` `...` header menu (`ChatHeader`), keep Pin/Unpin and inline Rename tests (`text-sm`, hover-reveal pencil), and ensure Snooze/Settle/Delete assertions are covered cleanly via `Sidebar` context menu (`tests/sidebar.test.tsx` / `tests/thread-delete.test.tsx`).
  - `tests/hotkeys.test.ts`: preserve existing `formatBinding` assertions (or update if formatted) + add explicit tests for `formatBindingParts` (`["Ctrl", "K"]` / `["⌘", "K"]`) and `<SettingsKeybindingsPage>` rendering visible `+` separators between `<Kbd>` elements.
  - `tests/project-dialog.test.tsx`: verify `<WorkspaceStrategyRadio>` renders custom styled radio controls (not native bare controls) and still switches between `Direct folder` and `Git worktree` via click & keyboard.
  - `tests/messages-timeline.test.tsx`: update/expand tests for `ActionGroupRow` (collapsing consecutive tool+thought+trace runs, active `"Running: ..."` vs completed summary + timestamp, chronological expansion), 0s completed thought suppression, and `<ThinkingAscii />` spinner rendering during streaming thoughts.
  - `tests/browser-panel.test.tsx`: update tests for child-webview IPC (`browser_navigate`, `browser_set_bounds`, `browser_history`), local `.html`/relative asset handling, and occlusion hiding when `paletteOpen` / `imagePreview` / `activeElicitation` is active.
  - `tests/settings-pages.test.tsx`: test language switcher in `settings.general.tsx` updating UI copy live (e.g. `"en"` -> `"ru"` / `"de"` / `"ja"`).
- **Verification:** `pnpm test`.

---

## Wave 5 — Final Verification & Adversarial Review

### T14 — Full Verification Gate & Adversarial Cross-Plan Audit

- **Severity:** P0 (Release Gate)
- **Dependencies:** `T01–T13`
- **Verification Commands (run in order):**
  1. `pnpm typecheck`
  2. `pnpm lint`
  3. `pnpm test`
  4. `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
  5. `cargo test --manifest-path src-tauri/Cargo.toml`
  6. `pnpm tauri build --no-bundle`
  7. `pnpm exec playwright test`
- **Adversarial Review Checklist:**
  - Verify all 18 requests (`A–R`) visually and functionally against every annotated screenshot (`1–12`), including right-panel open/close header stability, dark/light theme contrast across custom radios, `<Kbd> + <Kbd>`, borderless chrome, child webview occlusion under Command Palette & dialogs, live language switching across all 7 locales, and cross-check alongside `docs/superpowers/plans/2026-11-16-ade-review-followup.md` (`T01–T19`) for regressions.
  - Execute a mandatory fix pass on any audit failure and re-run the affected verification gates before tagging/publishing.
