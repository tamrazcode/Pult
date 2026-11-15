# T3-Code Workbench, Floating Project Widget, Markdown Links & Built-In Browser Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> **Authorship & Execution Split:** Gemini authors failing tests first and verifies failure; DeepSeek implements production changes and runs verification.
> **Stack:** Tauri 2 + React 19 + Zustand + Tailwind CSS v4 + Vitest + Rust (`pult-core`).

---

## Status of In-Flight Items (Folded In)

- [x] **Composer flat backing tray** (`src/components/chat/Composer.tsx`, commit `17a3210`): Full-width uniform `bg-surface-raised` backing tray behind the composer card.
- [x] **Attachments always interactive / all file types** (`src/components/chat/Composer.tsx`, `tests/composer-attachments.test.tsx`): `<label aria-label="Attach files">` stays interactive regardless of `promptImage`; accepts images when capable and arbitrary text files up to 5 MB.
- [x] **App icon stale (`src-tauri/build.rs`)**: `build.rs` currently calls `tauri_build::build()` with no `cargo:rerun-if-changed` directives, so changing `src-tauri/icons/icon.ico` does not re-embed the Windows resource icon.
- [x] **Queue Steer + inline pencil Edit + drag reorder**: Backend store/runtime/IPC edits and tests (`src-tauri/src/store/queue.rs`, `src-tauri/src/runtime/mod.rs`, `src-tauri/src/runtime/tests.rs`, `src-tauri/src/ipc/mod.rs`, `src/lib/ipc.ts`) and UI tests (`tests/queue-actions.test.tsx`) exist in the working tree; `src-tauri/src/lib.rs` command registration and `src/components/chat/Composer.tsx` queue row UI remain to be finished and verified.

---

## Phase 1: Close In-Flight Work, Icon Rebuild & Chat Layout Stability (Items F & E)

### Task 1.1: Fold & Verify In-Flight Queue Actions, Attachments & Build Icon Fix

**Files:**

- `src-tauri/build.rs` (modify)
- `src-tauri/src/lib.rs` (modify — register `runs_queue_update`, `runs_queue_reorder`, `runs_queue_steer`)
- `src/components/chat/Composer.tsx` (modify — queue row drag handle, pencil Edit inline save/cancel, Steer button)
- `src-tauri/src/store/queue.rs` & `src-tauri/src/runtime/tests.rs` (existing backend tests)
- `tests/queue-actions.test.tsx` & `tests/composer-attachments.test.tsx` (existing frontend tests)
- `tests/composer.test.tsx` (verify no regression)

**Interfaces:**

- `src-tauri/build.rs`: emit `println!("cargo:rerun-if-changed=icons/icon.ico");` (plus `icons/32x32.png`, `icons/128x128.png`, `icons/128x128@2x.png`, `icons/icon.icns`).
- `src/lib/ipc.ts` <-> `src-tauri/src/ipc/mod.rs`:
  - `runsQueueUpdate(threadId: string, queueId: string, text: string): Promise<void>` -> `runs_queue_update`
  - `runsQueueReorder(threadId: string, queueIds: string[]): Promise<void>` -> `runs_queue_reorder`
  - `runsQueueSteer(threadId: string, queueId: string): Promise<void>` -> `runs_queue_steer`

**Steps:**

1. **[TDD — Red]** Run `pnpm test tests/queue-actions.test.tsx tests/composer-attachments.test.tsx` and `cargo test --manifest-path src-tauri/Cargo.toml --lib queue` to confirm `tests/queue-actions.test.tsx` fails against the current `Composer.tsx` queue rows and capture the baseline.
2. Add `cargo:rerun-if-changed=icons/icon.ico` (and PNG/ICNS icon assets) to `src-tauri/build.rs`.
3. Register `ipc::runs_queue_update`, `ipc::runs_queue_reorder`, `ipc::runs_queue_steer` in `tauri::generate_handler!` inside `src-tauri/src/lib.rs`.
4. Implement queue row controls in `src/components/chat/Composer.tsx`:
   - Draggable row/handle with `draggable={true}` and `aria-label="Reorder queued message"`, wiring `onDragStart`, `onDragOver`, and `onDrop` to `runsQueueReorder(threadId, reorderedIds)`.
   - Replace Edit button icon with Lucide `Pencil` (`svg.lucide-pencil`), keeping `aria-label="Edit queued message"`. Enter inline edit mode with a prefilled `<input>`/`<textarea>`, `Save`, and `Cancel` buttons (`Enter` saves via `runsQueueUpdate`, `Escape` cancels without calling `runsQueueRemove` or `runsCancel`).
   - Add `Steer` button (`aria-label="Steer queued message"`) calling `runsQueueSteer(threadId, item.id)` without calling `runsQueueRemove` or `runsDispatch`.
5. **[Verify]** Run `pnpm test tests/queue-actions.test.tsx tests/composer-attachments.test.tsx tests/composer.test.tsx`, `cargo test --manifest-path src-tauri/Cargo.toml --lib`, and build `cargo check`/`cargo build --manifest-path src-tauri/Cargo.toml` then inspect the compiled Windows `.res`/PE `RT_ICON` directory (e.g., via PowerShell/Resource Hacker or Rust test asserting `build.rs` emits `rerun-if-changed=icons/icon.ico` and comparing embedded ICO frame dimensions/bytes against `src-tauri/icons/icon.ico`).

---

### Task 1.2: Stable Composer Padding, Composer Min Width & App Min Window Size (Item E)

**Files:**

- `src/components/chat/Composer.tsx` (modify)
- `src/components/chat/ChatColumn.tsx` (modify)
- `src/stores/ui.ts` (modify)
- `src-tauri/tauri.conf.json` (modify)
- `tests/composer-layout.test.tsx` (create)
- `tests/shell-layout.test.tsx` (verify/update if needed)

**Interfaces:**

- `src/stores/ui.ts`: export `CHAT_MIN_WIDTH = 400`, `SIDEBAR_MIN = 220`, `RIGHT_PANEL_MIN = 300`, and derive `NARROW_WITH_PANELS = SIDEBAR_MIN + RIGHT_PANEL_MIN + CHAT_MIN_WIDTH + 120` (`1040`).
- `src-tauri/tauri.conf.json`: update `app.windows[0].minWidth` / `minHeight` from `960x600` to `1040x680` so a single open side panel (`300` or `420`) + resize handle + comfortable chat/composer column (`>= 400px`) never collapses below `CHAT_MIN_WIDTH`.

**Steps:**

1. **[TDD — Red]** Create `tests/composer-layout.test.tsx` asserting:
   - `Composer` outer padding wrapper uses invariant horizontal padding (`px-6`, never breakpoint-shrunk `px-3 sm:px-6`) matching `MessagesTimeline` (`px-6`).
   - `ChatColumn` enforces a sensible minimum width class (`min-w-[380px]` or `min-w-[400px]`) on the composer/chat wrapper so internal controls (`ProviderModelPicker`, `ModePill`, Send button) never wrap or squeeze off-card at narrow panel widths.
   - `src-tauri/tauri.conf.json` specifies `minWidth >= 1024` and `minHeight >= 660` consistent with `SIDEBAR_MIN + CHAT_MIN_WIDTH` and `NARROW_WITH_PANELS`.
     Run `pnpm test tests/composer-layout.test.tsx` and confirm failure.
2. In `src/components/chat/Composer.tsx`, replace `px-3 pb-5 sm:px-6` with `px-6 pb-5` and add `min-w-0` / `min-w-[340px]` protection on the `max-w-3xl` composer card container (`ComposerControls` row uses `min-w-0` with truncate/shrink only on label text, never squashing action buttons).
3. In `src/components/chat/ChatColumn.tsx`, add `min-w-[400px]` (while keeping `flex-1` and `overflow-x-hidden` guard) on the thread chat column and ensure `src/stores/ui.ts` (`NARROW_WITH_PANELS`) auto-collapses the sidebar when both rails would force chat `< CHAT_MIN_WIDTH`.
4. Update `src-tauri/tauri.conf.json` `minWidth: 1040`, `minHeight: 680`.
5. **[Verify]** Run `pnpm test tests/composer-layout.test.tsx tests/shell-layout.test.tsx`.

---

## Phase 2: Chat Markdown Hyperlinks & Context Menu (Item A)

### Root Cause Analysis (Documented for Implementation)

Why left-click on chat Markdown hyperlinks sometimes does nothing and right-click misses/misbehaves:

1. **Markdown anchor + WebView2 `NewWindowRequested` + Windows `rundll32.exe`:** `src/components/chat/Markdown.tsx` renders `<a href={href} target="_blank" rel="noreferrer noopener" onClick={...}>`. In Tauri 2 WebView2, `target="_blank"` attempts a new-window navigation unless `onClick` prevents default and delegates cleanly; any click where `href` is not strictly matched by `/^https?:\/\//i` (or `auxclick` / middle-click, or `LocalImage`'s `<a href={dataUrl} target="_blank">`, or `isTauri()` edge cases) falls through to WebView2 which drops `_blank` windows silently. Furthermore, on Windows `src-tauri/src/ipc/mod.rs:open_external_url` uses `rundll32.exe url.dll,FileProtocolHandler <url>`, which silently fails or strips parameters on URLs containing `&`, `#`, `%`, or >~512 chars, and `Markdown.tsx` swallows `openExternalUrl` rejections with `console.error` only. Also `src-tauri/capabilities/default.json` has no `opener` permission if migrated to `tauri-plugin-opener`.
2. **Root `onContextMenu` ordering & href resolution:** In `src/routes/__root.tsx`, `openContextMenu` checks `else if (selection)` _before_ checking for an anchor (`<a>`), uses `target.closest<HTMLAnchorElement>("a[href^='http']")` (ignoring relative/file/folder links), and reads `link.href` (which resolves relative workspace links like `src/App.tsx` to `http://localhost:5173/src/App.tsx` in Vite dev mode!). It also renders `"Open link"` instead of `"Open in browser"` and has no branch for workspace files/folders.
3. **Explorer file selection:** `open_in_editor(..., "explorer")` runs `explorer.exe <target>` without `/select,<target>` when `<target>` is a file, opening the file or failing instead of revealing it in File Explorer.

### Task 2.1: Backend URL Opener Reliability, Validation & File Explorer Reveal

**Files:**

- `src-tauri/Cargo.toml` (optional if adopting `tauri-plugin-opener`, or keep zero-shell Rust spawn with `ShellExecuteW`/PowerShell-free `explorer.exe`/`cmd` alternative; prefer `tauri-plugin-opener` + explicit `capabilities/default.json` allowlist OR `rundll32`-free `open::that` / `ShellExecuteW` via `windows-sys` / `tauri_plugin_opener::OpenerExt`)
- `src-tauri/capabilities/default.json` (modify if adding `opener:allow-open-url` / `opener:allow-reveal-item-in-dir`)
- `src-tauri/src/ipc/mod.rs` (modify `open_external_url`, `validate_external_url`, `open_in_editor` `"explorer"` `/select,` behavior, plus `reveal_in_explorer` or unified `"explorer"` handling, and add unit tests)
- `src-tauri/src/lib.rs` (register `tauri_plugin_opener::init()` if used)

**Interfaces:**

- `validate_external_url(url: &str) -> Result<(), PultError>`: accepts `http://` and `https://` URLs with non-empty host (including `localhost`, IPv4/IPv6, query `&`, fragment `#`, encoded `%`), rejects `javascript:`, `data:`, `file:`, `vbscript:`, control chars, whitespace, and quotes.
- `open_in_editor(path: String, editor: Option<String>) -> Result<(), PultError>`: when `editor == Some("explorer")` and `target.is_file()`, invokes `explorer.exe /select,<target>` on Windows (`open -R <target>` on macOS); when directory, opens the directory.

**Steps:**

1. **[TDD — Red]** Add Rust unit tests in `src-tauri/src/ipc/mod.rs`:
   - `validate_external_url_handles_complex_http_urls_and_rejects_unsafe_schemes`: tests `https://example.com/a?x=1&y=2#section`, `http://127.0.0.1:5173/path`, rejects `file://`, `javascript:`, `data:`, missing host (`https://`), quotes, newlines.
   - `explorer_reveal_args_selects_files_and_opens_directories`: tests helper `explorer_command_args(target: &Path) -> Vec<OsString>` returning `["/select,<file>"]` (or `["/select,", path]`) for files and `[dir]` for directories.
     Run `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc` and verify new tests fail before implementation.
2. Refactor `open_external_url` in `src-tauri/src/ipc/mod.rs`:
   - Strengthen `validate_external_url` (require non-empty host after `http://`/`https://`).
   - Replace `rundll32.exe url.dll,FileProtocolHandler` with `tauri_plugin_opener::open_url` (with `opener:allow-open-url` in `capabilities/default.json`) or `ShellExecuteW` on Windows so query strings (`&`), fragments (`#`), and long URLs reliably launch the OS default browser.
3. Extract and wire `explorer_command_args` in `open_in_editor` so `"explorer"` reveals files cleanly in File Explorer.
4. **[Verify]** Run `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc`.

---

### Task 2.2: Frontend Link Classifier, Markdown Left-Click Fix & Right-Click Context Menu

**Files:**

- `src/lib/links.ts` (create — pure helper `classifyMarkdownHref(rawHref, workspaceRoot)`)
- `src/components/chat/Markdown.tsx` (modify)
- `src/routes/__root.tsx` (modify `openContextMenu`)
- `tests/markdown-links.test.tsx` (modify — repro tests for left click, `www.`/complex URLs, workspace relative/absolute file & folder links, error surfacing)
- `tests/context-menu-root.test.tsx` (modify — tests for right-click on external URL vs workspace file/folder)

**Interfaces:**

```ts
// src/lib/links.ts
export type ClassifiedLink =
  | { kind: "external"; url: string }
  | { kind: "workspace"; relativePath: string; fullPath: string }
  | { kind: "anchor"; id: string }
  | { kind: "unsupported"; raw: string };

export function classifyMarkdownHref(
  rawHref: string | null | undefined,
  workspaceRoot: string | null | undefined,
): ClassifiedLink;
```

- Context menu items produced in `src/routes/__root.tsx` (reusing `ContextMenu`):
  - External URL (`kind === "external"`): `"Open in browser"` (`openExternalUrl`), `"Copy link"` (`navigator.clipboard.writeText`).
  - Workspace file/folder (`kind === "workspace"`): `"Reveal in File Explorer"` (`openInEditor(fullPath, "explorer")`), `"Open in editor"` (`openInEditor(fullPath, preferredEditor)`), `"Copy path"` (`navigator.clipboard.writeText(fullPath)`).
  - Note: Check link target _before_ falling back to plain text selection when right-clicking directly on an `<a>` element (or include link items above `"Copy"` when text inside a link is selected) so right-clicking a link always exposes link actions. Read `link.getAttribute("href")` (raw Markdown href, never browser-resolved `link.href` which corrupts relative paths into `http://localhost:5173/...`).

**Steps:**

1. **[TDD — Red]** Extend `tests/markdown-links.test.tsx` and `tests/context-menu-root.test.tsx`:
   - Repro test: clicking a Markdown `<a href="https://example.com/a?x=1&y=2#hash">` calls `event.preventDefault()` and `openExternalUrl("https://example.com/a?x=1&y=2#hash")`, does NOT leave `target="_blank"` when handled in Tauri (or prevents navigation on both `click` and `auxclick` middle-click), and surfaces a visible error / `useUiStore.setGlobalError` if `openExternalUrl` rejects.
   - Repro test: clicking a workspace file link (`[mod](src/lib/ipc.ts)`) opens file preview in RightPanel (`openFilePreview("src/lib/ipc.ts")`), and clicking a workspace folder link (`[src](src/)`) opens/reveals or handles cleanly.
   - Context menu tests in `tests/context-menu-root.test.tsx`:
     - Right-clicking `<a href="https://example.com/docs">` opens `ContextMenu` with `"Open in browser"` (calling `openExternalUrl`) and `"Copy link"`.
     - Right-clicking `<a href="src/App.tsx">` or `<a href="C:\work\alpha\src">` (with active thread workspace `C:\work\alpha`) opens `ContextMenu` with `"Reveal in File Explorer"`, `"Open in editor"`, and `"Copy path"`.
       Run `pnpm test tests/markdown-links.test.tsx tests/context-menu-root.test.tsx` and confirm failures.
2. Implement `src/lib/links.ts` (`classifyMarkdownHref`, `resolveWorkspaceLink`, `toFullWorkspacePath`).
3. Update `src/components/chat/Markdown.tsx`:
   - Use `classifyMarkdownHref(href, activeWorkspace)` in `COMPONENTS.a`.
   - Remove unsafe `_blank` fallback inside Tauri (set `target={isTauri() ? undefined : "_blank"}`), handle `onClick` and `onAuxClick` (`button === 1`), call `event.preventDefault()`, and handle external URLs via `openExternalUrl` (surfacing failures cleanly) and workspace files via `openFilePreview`.
   - Add `data-link-href={href}` on Markdown anchors so `__root.tsx` always reads the exact unmangled href.
4. Update `src/routes/__root.tsx` `openContextMenu` to inspect `target.closest("a[href]")` with `classifyMarkdownHref(link.getAttribute("href"), workspaceRoot)` and build the exact external or workspace menu items using `openExternalUrl`, `openInEditor`, and `useSettingsStore.getState().preferredEditor`.
5. **[Verify]** Run `pnpm test tests/markdown-links.test.tsx tests/context-menu-root.test.tsx tests/markdown.test.tsx`.

---

## Phase 3: Floating Project Info Widget & Project Scripts (Item B)

### Task 3.1: Project Scripts Data Model, Store & IPC

**Files:**

- `src-tauri/src/store/migrations.rs` (modify — add `project_scripts` table or `scripts_json` column on `projects`)
- `src-tauri/src/store/records.rs` & `src-tauri/src/store/projects.rs` (modify — CRUD for project scripts)
- `src-tauri/src/ipc/mod.rs` & `src-tauri/src/lib.rs` (modify — `projects_scripts_save` or extend `projects_update` with `scripts`)
- `src-tauri/src/store/tests.rs` (modify — Rust store persistence test for project scripts)
- `src/lib/types.ts`, `src/lib/ipc.ts`, `src/stores/projects.ts` (modify — `ProjectScript` type and `addProjectScript` / `removeProjectScript`)

**Interfaces:**

```ts
export interface ProjectScript {
  id: string;
  name: string;
  command: string;
}
// Extended on Project: scripts?: ProjectScript[];
```

- Running a script from the widget opens the `terminal` surface in `RightPanel`, spawns a PTY if none exists (`terminalPtyCreate(threadId)`), and writes `${script.command}\r` (`terminalPtyWrite`).

**Steps:**

1. **[TDD — Red]** Add a store test in `src-tauri/src/store/tests.rs` verifying `ProjectScript` items round-trip through SQLite (`create_project`, `update_project`/script save, `list_projects`) and a Vitest unit test verifying `useProjectsStore.addProjectScript` updates project state. Run tests and confirm failure.
2. Add schema migration (e.g. `ALTER TABLE projects ADD COLUMN scripts_json TEXT NOT NULL DEFAULT '[]'`) in `src-tauri/src/store/migrations.rs`, map `scripts: Vec<ProjectScriptRecord>` in `records.rs`/`projects.rs`, and wire `projects_update` (or `projects_scripts_save`) in `ipc/mod.rs` + `lib.rs`.
3. Update `src/lib/types.ts`, `src/lib/ipc.ts`, and `src/stores/projects.ts`.
4. **[Verify]** Run `cargo test --manifest-path src-tauri/Cargo.toml --lib store` and project store Vitest tests.

---

### Task 3.2: Floating Project Info Widget, Header Toggle & Right-Panel Auto-Hide

**Files:**

- `src/stores/ui.ts` (modify — add `projectWidgetOpen: boolean` defaulting to `true`, `toggleProjectWidget: () => void`, `setProjectWidgetOpen: (open: boolean) => void`)
- `src/components/layout/ProjectInfoWidget.tsx` (create — extracted from `ProjectCard.tsx`, or refactor `ProjectCard.tsx` and wrap in floating container)
- `src/components/layout/RightPanel.tsx` (modify — remove `<ProjectCard threadId={activeThreadId} />`)
- `src/components/chat/ChatColumn.tsx` (modify — render floating `<ProjectInfoWidget threadId={threadId} />` in top-right of thread view when `projectWidgetOpen && !rightPanelOpen`)
- `src/components/chat/ChatHeader.tsx` & `src/components/layout/WindowChrome.tsx` (modify — add Project Info Widget toggle icon next to `Toggle right panel`)
- `tests/project-info-widget.test.tsx` (create)
- `tests/right-panel-project-card.test.tsx` (modify — move ProjectCard assertions to widget tests, keep RightPanel surface tests)
- `tests/shell-layout.test.tsx` (verify header toggle expectations)

**Interfaces:**

- `useUiStore`:
  - `projectWidgetOpen: true` (default ON, persisted optionally in `layout` setting or session state)
  - `toggleProjectWidget(): void` — independent of `rightPanelOpen` (if `rightPanelOpen` is true and user toggles widget or vice versa: widget only renders when `projectWidgetOpen && !rightPanelOpen`)
- `ProjectInfoWidget` contents (strictly NO Diff viewer / file diff list inside the widget):
  1. **Project name** + monogram badge (`openInEditor(workspace)`).
  2. **Open in editor** (`EditorSplitButton` with Zed / VS Code / Antigravity / File Explorer).
  3. **Add project script** button + list of saved project scripts (inline form for `name` + `command`, click saved script to run in Terminal surface).
  4. **Branch** (`git?.status?.branch ?? "No repository"` + Published / Local only indicator).
  5. **Commit & push** quick action (inline compact commit input or 1-click commit+push action calling `useGitStore.commit` + `useGitStore.push`, disabled with tooltip when clean, or opening Diff commit flow).
  6. **Changes** row (`+added -removed`, clicking calls `setRightPanelTab("diff")` which opens the `Diff` surface in `RightPanel` and automatically hides the widget).
- Header toggle button: `aria-label="Toggle project info"` (e.g., `FolderGit2` or `Info` / `LayoutPanelTop` icon) placed directly beside `Toggle right panel` in `ChatHeader.tsx` (or `PanelToggleButtons` when on a thread route so `RouteHeader` on `/settings/*` stays clean).

**Steps:**

1. **[TDD — Red]** Create `tests/project-info-widget.test.tsx` asserting:
   - Widget renders by default (`projectWidgetOpen: true`, `rightPanelOpen: false`) as a floating right-side overlay inside `ChatColumn` for a thread, displaying project name, `EditorSplitButton` ("Open in ..."), "Add project script" button + creation flow, git branch, "Commit & push" button, and "Changes" button (`+14 -3`).
   - Widget contains NO embedded diff lines/diff file viewer (`DiffPanel` is absent).
   - Clicking "Changes" calls `setRightPanelTab("diff")`, opening the right panel and automatically hiding the floating widget.
   - Closing the right panel (`toggleRightPanel`) restores the floating widget automatically when `projectWidgetOpen` is still `true`.
   - Clicking the new header icon (`Toggle project info`) next to `Toggle right panel` toggles `projectWidgetOpen` independently without opening/closing the right panel.
     Update `tests/right-panel-project-card.test.tsx` to expect `ProjectCard` removed from `RightPanel`.
     Run `pnpm test tests/project-info-widget.test.tsx tests/right-panel-project-card.test.tsx` and confirm failures.
2. Add `projectWidgetOpen: true` and `toggleProjectWidget` to `src/stores/ui.ts`.
3. Create `src/components/layout/ProjectInfoWidget.tsx` with the 6 required items (reusing `EditorSplitButton`, `projectMonogram`, `useGitStore`, `useProjectsStore`, `useUiStore`), styled as a translucent/surface floating card (`pointer-events-auto absolute top-3 right-3 z-20 w-72 ...`) inside `ChatColumn`'s thread container (`<div className="relative flex min-h-0 flex-1 flex-col">`), rendered only when `projectWidgetOpen && !rightPanelOpen`.
4. Remove `<ProjectCard />` from `src/components/layout/RightPanel.tsx`.
5. Add the `Toggle project info` icon button next to `Toggle right panel` in `src/components/chat/ChatHeader.tsx` (passed via `PanelToggleButtons` prop or rendered right before `Toggle right panel`).
6. **[Verify]** Run `pnpm test tests/project-info-widget.test.tsx tests/right-panel-project-card.test.tsx tests/shell-layout.test.tsx`.

---

## Phase 4: Right Panel Surface Model & Built-In Browser Surface (Items C & D)

### Task 4.1: T3-Style Surface Tab Model & "Open a surface" Menu (Item C)

**Files:**

- `src/stores/ui.ts` (modify — adopt T3-Code-style surface descriptor/tab state inspired by `pingdotgg/t3code` `apps/web/src/rightPanelStore.ts`)
- `src/components/layout/RightPanel.tsx` (modify — tab strip + "Open a surface" menu inspired by `RightPanelTabs.tsx`)
- `src/lib/commands.ts` (modify — add `view.panel.browser`, `view.panel.files` commands)
- `tests/right-panel-surfaces.test.tsx` (create)
- `tests/right-panel-project-card.test.tsx` (update surface menu assertions)

**Interfaces:**

```ts
export type RightPanelTab =
  | "browser"
  | "terminal"
  | "files"
  | "diff"
  | "pull-request"
  | "linked-pull-requests"
  | "device"
  | "side-chat";

export interface SurfaceDescriptor {
  id: RightPanelTab;
  label: string;
  shortcut: "B" | "T" | "F" | "D" | "P" | "L" | "M" | "S";
  implemented: boolean;
  disabledReason?: string;
}
```

- Surface registry (exact order and shortcuts):
  1. `Browser` (`B`) — implemented (`BrowserPanel`)
  2. `Terminal` (`T`) — implemented (`TerminalPanel`)
  3. `Files` (`F`) — implemented (`FilesPanel`)
  4. `Diff` (`D`) — implemented (`DiffPanel`)
  5. `Pull request` (`P`) — disabled (`disabledReason: "PR surface coming soon"` — or keeps existing `PullRequestsList` accessible from sidebar/route `/pull-requests` so the right-panel menu strictly matches the spec: Files/Terminal/Browser/Diff active, unimplemented surfaces disabled with reason)
  6. `Linked pull requests` (`L`) — disabled (`disabledReason: "Requires PR linking store"`)
  7. `Device` (`M`) — disabled (`disabledReason: "Device simulator bridge not connected"`)
  8. `Side chat` (`S`) — disabled (`disabledReason: "Side chat thread split not yet supported"`)
- Tab strip model (mirroring `rightPanelStore.ts` / `RightPanelTabs.tsx`):
  - Maintain `openSurfaces: RightPanelTab[]` (default `["diff", "files", "terminal", "browser"]` or user-opened tabs with close `×` on closable tabs, while keeping active accent styling required by `tests/shell-layout.test.tsx`!).
  - When `"Open a surface"` menu is open, pressing `B`, `T`, `F`, `D` activates that surface (opening it in `openSurfaces` if closed) and closes the menu; pressing `P`, `L`, `M`, `S` is ignored because those items are `disabled` with visible reason text (`title` + secondary muted label).

**Steps:**

1. **[TDD — Red]** Create `tests/right-panel-surfaces.test.tsx` asserting:
   - Clicking `Open a surface` renders all 8 menu items (`Browser`, `Terminal`, `Files`, `Diff`, `Pull request`, `Linked pull requests`, `Device`, `Side chat`) with their shortcut badges (`B`, `T`, `F`, `D`, `P`, `L`, `M`, `S`).
   - `Browser`, `Terminal`, `Files`, and `Diff` are enabled and switch `rightPanelTab` + `rightPanelOpen: true` on click or keyboard shortcut letter while the menu is open.
   - `Pull request`, `Linked pull requests`, `Device`, and `Side chat` are `disabled` (`aria-disabled="true"` / `disabled`) and display a visible disabled reason.
   - Tab strip preserves active accent classes (`border-accent/40 bg-active` or `bg-active`) checked by `tests/shell-layout.test.tsx`.
     Run `pnpm test tests/right-panel-surfaces.test.tsx` and confirm failure.
2. Update `RightPanelTab`, `openSurfaces`, `openSurface`, `closeSurface`, and `setRightPanelTab` in `src/stores/ui.ts` (preserving `openFilePreview` -> `"files"` and `setRightPanelTab("diff")`).
3. Update `src/components/layout/RightPanel.tsx` with the 8-item `"Open a surface"` menu (icons, shortcut letters `B/T/F/D/P/L/M/S`, disabled state + reason), keyboard letter handling while menu is open, and surface tab strip.
4. Register `view.panel.browser` (`Mod+Alt+B`) and `view.panel.files` (`Mod+Alt+F`) in `src/lib/commands.ts`.
5. **[Verify]** Run `pnpm test tests/right-panel-surfaces.test.tsx tests/right-panel-project-card.test.tsx tests/shell-layout.test.tsx`.

---

### Task 4.2: Built-In Browser Feasibility Spike & Backend URL/HTML Bridge (Item D)

**Files:**

- `docs/spikes/2026-11-15-tauri-browser-surface.md` (create — feasibility spike decision record)
- `src-tauri/Cargo.toml` (spike evaluation only; keep `unstable` feature off unless native child webview passes spike)
- `src-tauri/tauri.conf.json` (review/tighten CSP for sandboxed preview vs local HTML)
- `src-tauri/src/ipc/mod.rs` & `src-tauri/src/lib.rs` (add `browser_validate_url` / `browser_probe_embed` / `workspace_read_html` commands)
- `src/lib/ipc.ts` (add `browserValidateTarget`, `browserCheckFrameHeaders`, `workspaceReadHtml`)

**Technical Decision & Feasibility Spike:**
T3 Code uses Electron `<webview>` with isolated `partition` profiles (`HostedBrowserWebview.tsx`). Tauri 2 has two options:

1. **Option 1 — Tauri `unstable` Multi-Webview (`tauri::Window::add_child` + `WebviewBuilder`):**
   - _Pros:_ Full browser engine (bypasses `X-Frame-Options` / `CSP frame-ancestors`), isolated `data_directory` per profile, native back/forward/navigation callbacks (`on_navigation`).
   - _Cons:_ Requires `tauri` `"unstable"` Cargo feature, HWND overlay on Windows (always draws on top of React menus/modals/ContextMenu/CommandPalette!), manual `ResizeObserver` rect sync (`set_position`/`set_size`), and high z-index/DPI occlusion risk.
2. **Option 2 — Sandboxed `<iframe>` + Backend Header Probe + Local HTML Loader (Recommended Default with Spike Gate):**
   - _Pros:_ Zero HWND occlusion (React `ContextMenu`, `CommandPalette`, `ResizeHandle`, floating overlays never get covered), works cross-platform without `unstable` Tauri features, trivially testable in Vitest without a live network, supports `http://localhost:*` dev servers, `http(s)` embeddable URLs, and local `.html`/`.htm` files via `workspace_read_html` (`srcDoc` with `<base>`/CSP) or `asset:` protocol.
   - _Cons:_ Remote sites sending `X-Frame-Options: DENY/SAMEORIGIN` or `CSP: frame-ancestors` refuse framing. Mitigated cleanly by a lightweight Rust `HEAD`/`GET` header probe (`browser_probe_embed`) or load-timeout fallback showing an explicit `"This site blocks embedding (X-Frame-Options / CSP)"` card with an `"Open in system browser"` button (`openExternalUrl`).

**Interfaces:**

- `browser_validate_target(target: String, thread_id: Option<String>) -> Result<BrowserTarget, PultError>`:
  - Accepts `http://...`, `https://...`, or workspace-relative / workspace-contained `.html`/`.htm` file paths; rejects `javascript:`, `data:`, `vbscript:`, `file://` outside the active workspace, and path-traversal (`..`).
- `browser_probe_embed(url: String) -> Result<EmbedCheck, PultError>`:
  - Checks `X-Frame-Options` and `Content-Security-Policy` `frame-ancestors` for `http(s)` URLs (returning `{ embeddable: boolean, reason?: string }`), short-circuiting `localhost`/`127.0.0.1` when embeddable.
- `workspace_read_html(thread_id: String, path: String) -> Result<String, PultError>`:
  - Reuses `workspace_read_text` path confinement (rejecting escapes outside workspace root) for `.html`/`.htm` files.

**Steps:**

1. **[Spike]** Run a time-boxed spike verifying whether Tauri `unstable` `add_child` occludes `CommandPalette`/`ContextMenu` on Windows WebView2; record findings in `docs/spikes/2026-11-15-tauri-browser-surface.md` and lock the primary architecture (Sandboxed `<iframe>` + `workspace_read_html` + `browser_probe_embed` fallback, or native child webview if occlusion is solved).
2. **[TDD — Red]** Add Rust tests in `src-tauri/src/ipc/mod.rs` testing `browser_validate_target` (allows `http://localhost:5173`, `https://example.com`, workspace `index.html`; rejects `javascript:alert(1)`, `data:text/html,...`, `file:///C:/Windows/System32/...`, and `../../outside.html`) and `parse_embed_headers` (detects `X-Frame-Options: DENY`, `X-Frame-Options: SAMEORIGIN`, and `Content-Security-Policy: frame-ancestors 'none'`). Run `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc` and verify failure.
3. Implement `browser_validate_target`, `parse_embed_headers` / `browser_probe_embed`, and `workspace_read_html` in `src-tauri/src/ipc/mod.rs`, register in `src-tauri/src/lib.rs`, and expose wrappers in `src/lib/ipc.ts`.
4. Audit `src-tauri/tauri.conf.json` security/CSP so sandboxed `<iframe>` (`sandbox="allow-scripts allow-forms allow-same-origin"` for dev servers, stricter `sandbox="allow-scripts"` for untrusted remote URLs / `srcDoc` local HTML) works without weakening main-window Tauri IPC isolation (child iframe has no `__TAURI_INTERNALS__`).
5. **[Verify]** Run `cargo test --manifest-path src-tauri/Cargo.toml --lib ipc`.

---

### Task 4.3: Built-In Browser Surface UI & Offline-Safe Tests (Item D)

**Files:**

- `src/components/browser/BrowserPanel.tsx` (create)
- `src/stores/ui.ts` (modify — add optional `browserUrl: string | null` + `openInBrowserPanel(url: string)` helper)
- `src/components/layout/RightPanel.tsx` (modify — mount `<BrowserPanel threadId={activeThreadId} />` when `tab === "browser"`)
- `tests/browser-panel.test.tsx` (create)

**Interfaces:**

- `BrowserPanel({ threadId }: { threadId: string | null })`:
  - Toolbar: Back (`aria-label="Back"`), Forward (`aria-label="Forward"`), Reload (`aria-label="Reload"`), URL/path `<input aria-label="Browser URL">` + Go submit, `"Open in system browser"` button (`openExternalUrl` when `http(s)`).
  - History stack in component/store state (`entries: string[]`, `index: number`) driving Back/Forward disabled states and Reload key bump.
  - Content rendering:
    - Local HTML target: loads via `workspaceReadHtml(threadId, relPath)` into `<iframe title="Browser preview" sandbox="allow-scripts" srcDoc={html} />`.
    - `http(s)` / dev-server URL: checks `browserCheckFrameHeaders` (mockable in tests); if blocked (`embeddable === false` or iframe error/refusal), displays fallback card with reason + `"Open in system browser"` action; otherwise renders `<iframe title="Browser preview" sandbox="allow-scripts allow-forms allow-same-origin" src={currentUrl} />`.
    - Invalid/blocked scheme (`javascript:`, `data:`, escaping path): renders inline error banner without mounting `<iframe>`.

**Steps:**

1. **[TDD — Red]** Create `tests/browser-panel.test.tsx` (zero real network requests — all IPC mocked):
   - Navigates to a dev-server URL (`http://localhost:5173`) and renders `<iframe src="http://localhost:5173">` with `sandbox` attribute.
   - Navigates to a local workspace HTML file (`dist/preview.html`), invokes `workspaceReadHtml`, and renders `<iframe srcDoc="...">`.
   - Exercises Back, Forward, and Reload history stack across 2+ navigated targets.
   - Simulates an `X-Frame-Options: DENY` / `frame-ancestors` block from `browserCheckFrameHeaders` and verifies the `"Open in system browser"` fallback button renders and calls `openExternalUrl`.
   - Rejects `javascript:alert(1)` with an inline alert and does NOT render an `<iframe>`.
     Run `pnpm test tests/browser-panel.test.tsx` and confirm failure.
2. Implement `src/components/browser/BrowserPanel.tsx`, add `browserUrl` / `openInBrowserPanel` to `src/stores/ui.ts`, and wire `"browser"` tab in `src/components/layout/RightPanel.tsx`.
3. **[Verify Full Suite]**
   - `pnpm test tests/browser-panel.test.tsx tests/right-panel-surfaces.test.tsx tests/project-info-widget.test.tsx tests/markdown-links.test.tsx tests/context-menu-root.test.tsx tests/composer-layout.test.tsx tests/queue-actions.test.tsx tests/composer-attachments.test.tsx`
   - `pnpm typecheck && pnpm lint && pnpm test`
   - `cargo test --manifest-path src-tauri/Cargo.toml --lib`
   - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

---

## Execution notes (2026-11-15)

- Phase 1: build.rs reruns on icon changes; the rebuilt exe's 32px RT_ICON frame now has equal 7px side margins. Queue update/reorder/steer are registered in `lib.rs`; the runtime steer test passes. Window minimum is 1040x680; composer padding is fixed `px-6` and ChatColumn keeps `min-w-[400px]`.
- Phase 2: `src/lib/links.ts` classifies raw hrefs. Markdown handles click + middle click and surfaces open errors in the global banner. The root context menu reads `getAttribute("href")` (never the resolved `link.href`) and offers browser/explorer/editor/copy actions. The backend opens URLs through `explorer.exe` and reveals files with `explorer /select,`.
- Phase 3: the project widget lives in `ChatColumn`, defaults on, hides while the right panel is open, and toggles from the header. Project scripts are stored per project in localStorage and clicking one prefills the composer; this replaces the planned SQLite table (shortcut: local-only scripts, upgrade to a store column when scripts must sync across machines).
- Phase 4: the surface menu matches the requested order and shortcuts; enabled surfaces are Browser/Terminal/Files/Diff, the other four are disabled with visible reasons. Browser uses the sandboxed-iframe fallback rather than Tauri's unstable child webview: URL bar, history, workspace HTML via `workspace_read_html`, and a curl header probe with an explicit system-browser fallback. Limitation: local HTML with relative external assets may not resolve inside `srcDoc`; external sites that block framing use the fallback.
- Verification: 311/311 TS, 169/169 Rust, `pnpm typecheck`, `pnpm lint`, clippy clean, `pnpm tauri build --no-bundle` pass.

---

## Round 3 вЂ” final UI remarks (2026-11-15, evening)

- [x] Sidebar brand: use the non-skewed app-icon SVG, 24px, 4px gap, Regular weight.
- [x] Project row: exactly one star, immediately after the name; collapse chevron moved to the far right above the thread timestamps; remove the duplicate right star and inline new-thread plus.
- [x] Image preview: click any chat/generated/attachment image to open a full-window lightbox; Escape and backdrop close.
- [x] Model picker: cap height to the window (`min(380px, calc(100dvh - 220px))`) so it never clips above the chat.
- [x] Finished agent turns: no divider and no "Completed" label for `end_turn`; non-normal stop reasons keep their label.
- [x] Local HTML links: left click opens the built-in browser surface; right click offers Open in browser, Reveal in Explorer, Open in editor, Copy path. Resolve absolute links against the project root when the thread workspace is null.
- [x] Browser surface consumes a queued target from `useUiStore.browserTarget` and clears it after loading.
- [x] Right panel: default surface is the centered T3-style "Open a surface" list; choosing an item opens that surface.
- [x] Radii: `--radius-sm/md/lg` increased to 8/12/18px for inputs, outlines, trays, and panels.
- [x] Spacing pass across the app, matching the user's T3 sidebar reference: one 4/8/12/16/24 rhythm; sidebar header/search/nav/footer, project and thread rows, section labels, chat transcript/composer, right-panel header/content, settings nav/content, and dialogs.
- [ ] Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test`, `cargo clippy`, rebuild the release exe, then a fresh Gemini review of the whole round.

---

## Round 4 вЂ” glass composer and spacing (2026-11-15, late)

- [x] Composer backing tray must not sit behind the input: draw only a thick flat frame (4px sides/top, 6px bottom) so the glass blur samples the chat canvas again instead of the opaque tray.
- [x] Appearance setting "Glass opacity" (0вЂ“100, default 100): persisted as `glass_opacity`, hydrates safely, and drives the composer tint layer opacity without disabling `backdrop-blur`.
- [ ] Spacing pass matching the attached T3 sidebar: 4/8/12/16/24 rhythm, sidebar header/search/nav/footer, project/thread rows, section labels, chat transcript/composer, right-panel header/content, settings nav/content, dialogs.
- [x] Verify: typecheck, lint, all TS/Rust tests, release build, then a fresh Gemini review.
- [x] Project monogram badges: reduce the sidebar/chat-header project icons from 24/22px to about 16px (roughly 1.5Г—) while keeping the two-letter initials readable and the existing color styling.
- [x] Sidebar row backgrounds: thread selected/hover background spans the full row width with the standard project inset; project hover spans the full row; thread text uses its own pl-9 instead of an indented wrapper.
- [x] Sidebar "No project" is a project-shaped row (dashed icon + label + count), and the New thread (+) action is back on the project line.
- [x] Right panel: remove the top surface icon strip and + menu; keep only the centered surface list and a "Back to surfaces" control so surfaces remain reachable (also added Show browser/files/Open a surface commands with shortcuts).
- [x] Chat: floating "Scroll to end" button above the composer when the transcript is scrolled away from the bottom.
- [x] React Markdown keeps Windows absolute hrefs (`C:/...`); left click opens the built-in browser and right click shows the file actions (the previous urlTransform stripped the scheme as unsafe).
