# Editor Brand Icons in Editor Chooser & Project Card

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [x]`) syntax for tracking.
>
> **Authorship & Execution Split:** **Gemini** authors the failing tests for each task (Step 1) and verifies failure (Step 2) before **DeepSeek** implements the production changes (Step 3) and runs verification (Step 4).

**Goal:** Show real, locally bundled brand logos next to every editor name (**VS Code**, **Zed**, **Antigravity**, **File Explorer**) in both the `FilesPanel` editor split-button/dropdown and the `ProjectCard` `"Open in editor"` action, with a neutral glyph fallback when a mark is unavailable, zero runtime remote fetching, and full preservation of `preferredEditor` IDs (`zed`, `vscode`, `antigravity`, `explorer`) and the Rust `open_in_editor` allowlist.

**Architecture:** Four bite-sized TDD tasks layered cleanly onto the existing Tauri 2 + React 19 + Tailwind CSS v4 + Zustand 5 codebase (mirroring the existing `src/assets/providers/` + `ProviderLogo.tsx` pattern):

- **Assets & Editor Metadata (Task 1):** Download official/Simple Icons/Iconify SVG marks for VS Code, Zed, Antigravity, and File Explorer into `src/assets/editors/` with `LICENSES.md` attribution; create `src/lib/editors.ts` (`EditorId`, `EditorMeta`, `EDITORS`, `getEditorMeta`, `isEditorId`) and `src/components/ui/EditorLogo.tsx` (bundled `<img>` rendering + neutral SVG fallback on missing URL or `onError`).
- **Shared Split-Button & Surface Integration (Task 2):** Extract a reusable `EditorSplitButton` (`src/components/ui/EditorSplitButton.tsx`) supporting `"compact"` (Files toolbar) and `"card"` (`ProjectCard` row) variants; replace the inline `EditorButton` in `src/components/files/FilesPanel.tsx` and the plain `<button>` in `src/components/layout/ProjectCard.tsx` with `EditorSplitButton`; reuse `isEditorId` / `EditorId` in `src/stores/settings.ts` without altering persisted keys or defaults.
- **Matrix & Persistence Tests (Task 3):** Cover every editor entry (`vscode`, `zed`, `antigravity`, `explorer`) in both `FilesPanel` and `ProjectCard`, neutral glyph fallback on missing/broken marks, `preferredEditor` persistence + `hydrate()` round-trip, outside-click / `Escape` dismissal, and `FilesPanel` context-menu label sync.
- **Acceptance, Build & Screenshots (Task 4):** Run all frontend and Rust verification gates, `pnpm build`, `pnpm tauri build --no-bundle`, launch `pult-core.exe` and capture verification screenshots showing the editor logos in `FilesPanel` and `ProjectCard`, and record the result in `DEVLOG.md`.

**Tech Stack:** React 19, TypeScript (`strict: true`), Vite (static SVG asset imports via `vite/client`), Zustand 5, Tailwind CSS v4, Lucide React (`ChevronDown`, `Check`, neutral fallback glyph), Vitest + Testing Library (`jsdom`), Tauri 2 (Rust backend unchanged).

---

## Global Constraints

- **Zero runtime remote fetching:** All editor SVGs are downloaded during Task 1 implementation, committed under `src/assets/editors/`, and imported statically via ES `import` so Vite bundles them locally (`dist/assets/`).
- **Zero new npm or Cargo dependencies:** Reuse existing `vite/client` SVG asset imports and `lucide-react`.
- **Unchanged setting IDs & Rust allowlist:** `preferredEditor` MUST stay `"zed" | "vscode" | "antigravity" | "explorer"` (default `"zed"`, stored under key `"preferred_editor"`). `src-tauri/src/ipc/mod.rs` `open_in_editor` allowlist and spawning behavior MUST NOT be modified.
- **Neutral fallback & theme contrast:** Every bundled SVG must render crisply on both dark (`dark`, `graphite`, `liquid`) and light (`light`) themes (never pure `#000000` on dark backgrounds). If `logoUrl` is null/empty or `<img>` triggers `onError`, `EditorLogo` must render a neutral monochrome glyph (`data-editor-fallback`).
- **Strict TypeScript hygiene:** Use explicit `ReactElement` / `ReactNode` imports from `"react"` (no global `JSX.Element`), and keep `pnpm typecheck`, `pnpm lint`, `pnpm test`, and Rust checks green.

## Review Focus

1. **Bundled SVG integrity & theme legibility:** Verify all 4 files under `src/assets/editors/*.svg` are valid standalone `<svg>` documents (no external `<image href="http...">`, no `<script>`), visually legible on dark and light surfaces, and documented with source URLs + license notes in `src/assets/editors/LICENSES.md`.
2. **ProjectCard primary action & dropdown parity:** Clicking the primary half of `ProjectCard`'s split-button calls `openInEditor(workspace, preferredEditor)`; clicking the chevron opens `[role="menu"]` without triggering `openInEditor`; picking an editor calls `setPreferredEditor(id)`, calls `openInEditor(workspace, id)`, updates both `ProjectCard` and `FilesPanel` immediately via `useSettingsStore`, and closes the menu.
3. **ProjectCard title row preserved:** The top `[badge] {project.name} [FolderOpen]` row in `ProjectCard.tsx` keeps its existing `openInEditor(workspace)` behavior untouched.
4. **Fallback safety:** Test both `logoUrl: null` and a simulated `<img>` `fireEvent.error` so `EditorLogo` transitions cleanly to a neutral glyph (`[data-editor-fallback]`) without crashing or showing a broken-image icon.
5. **No tiny `< 12px` text utilities:** All labels inside `EditorSplitButton` and dropdown items use `text-xs` (`12px`) or larger per `tests/fonts.test.ts`.

---

## Tasks

### Task 1: Bundled editor SVG assets, license note, metadata module, and `EditorLogo`

**Design Decision:** Mirror `src/assets/providers/` + `ProviderLogo.tsx`. Store the four SVG marks in `src/assets/editors/` (`vscode.svg`, `zed.svg`, `antigravity.svg`, `explorer.svg`) alongside `src/assets/editors/LICENSES.md`. Define canonical editor metadata (`id`, `label`, `logoUrl`, `accent`, `fallbackGlyph`) in `src/lib/editors.ts` so neither UI components nor `settings.ts` duplicate switch statements for labels or IDs. Render logos via `src/components/ui/EditorLogo.tsx` with automatic fallback to a neutral glyph if a logo URL is absent or fails to load.

**Asset Sourcing Guidance (for Step 3):**

- `vscode.svg`: Official VS Code blue ribbon SVG (e.g. Iconify `logos:visual-studio-code` or `vscode-icons:file-type-vscode`, `#007ACC` / `#0065A9` / `#1F9CF0`).
- `zed.svg`: Official Zed mark (e.g. Simple Icons `zedindustries` or `zed-industries/zed` brand mark, tinted to Zed brand blue `#084CCF` / `#5B9BF8` so it stays visible on both dark and light themes).
- `antigravity.svg`: Official Google Antigravity mark (from `antigravity.google` / official brand asset, or clean multi-tone/blue brand SVG matching Antigravity's emblem, never raw remote URL at runtime).
- `explorer.svg`: Windows File Explorer / folder mark (e.g. Iconify `vscode-icons:default-folder-opened` or `fluent-color:folder-24` / File Explorer icon with crisp gold/blue tones).
- Document exact source URL, icon package/author, and license/trademark notice for each file in `src/assets/editors/LICENSES.md`.

**Files:**

- Create: `src/assets/editors/vscode.svg`, `src/assets/editors/zed.svg`, `src/assets/editors/antigravity.svg`, `src/assets/editors/explorer.svg`, `src/assets/editors/LICENSES.md`
- Create: `src/lib/editors.ts`, `src/components/ui/EditorLogo.tsx`
- Create test: `tests/editors.test.tsx`

**Interfaces:**

- `src/lib/editors.ts`:
  ```ts
  export type EditorId = "zed" | "vscode" | "antigravity" | "explorer";

  export interface EditorMeta {
    id: EditorId;
    label: string;
    logoUrl: string | null;
    accent: string;
    fallbackGlyph: "code" | "terminal" | "sparkles" | "folder";
  }

  export const EDITORS: readonly EditorMeta[]; // order: vscode, zed, antigravity, explorer
  export function isEditorId(value: unknown): value is EditorId;
  export function getEditorMeta(id: string | null | undefined): EditorMeta;
  ```
- `src/components/ui/EditorLogo.tsx`:
  ```ts
  import type { ReactElement } from "react";
  import type { EditorId, EditorMeta } from "../../lib/editors";

  export function EditorLogo(props: {
    editor: EditorId | EditorMeta;
    size?: number;
    className?: string;
  }): ReactElement;
  ```
  - When `meta.logoUrl` is truthy and `!errored`, renders `<img src={meta.logoUrl} alt="" aria-hidden width={size} height={size} data-editor-logo={meta.id} onError={() => setErrored(true)} className={`${className} shrink-0 object-contain`} />`.
  - When `meta.logoUrl` is null/empty or `errored` is true, renders a neutral monochrome `svg` glyph (`data-editor-fallback={meta.id}`, `aria-hidden`, `text-text-tertiary`).

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
      Create `tests/editors.test.tsx`:
  1. `"defines metadata and bundled local SVG assets for all four editors"`:
     - Asserts `EDITORS.map((e) => e.id)` equals `["vscode", "zed", "antigravity", "explorer"]`.
     - Asserts labels are `"VS Code"`, `"Zed"`, `"Antigravity"`, `"File Explorer"`.
     - Asserts every entry has a non-empty `logoUrl` (never `http://` or `https://`), a valid CSS hex/color `accent`, and `getEditorMeta("unknown")` falls back to `"zed"`.
  2. `"verifies bundled SVG files and LICENSES.md exist under src/assets/editors/"`:
     - Uses Node `fs` + `path` to assert `vscode.svg`, `zed.svg`, `antigravity.svg`, `explorer.svg`, and `LICENSES.md` exist, every SVG contains `<svg` and `</svg>` without `<script` or `http://`/`https://` `<image` references, and `LICENSES.md` mentions all four filenames.
  3. `"renders bundled img logo for each editor and falls back to neutral glyph when unavailable or errored"`:
     - Renders `<EditorLogo editor={id} />` for each of the 4 IDs and asserts `document.querySelector(\`img[data-editor-logo="${id}"]\`)`is present with non-empty`src`.
     - Renders `<EditorLogo editor={{ id: "vscode", label: "VS Code", logoUrl: null, accent: "#007ACC", fallbackGlyph: "code" }} />` and asserts `img` is absent while `[data-editor-fallback="vscode"]` (`<svg>`) is rendered.
     - Renders `<EditorLogo editor="zed" />`, fires `fireEvent.error(img)`, and asserts it switches to `[data-editor-fallback="zed"]`.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/editors.test.tsx` → FAIL (`src/lib/editors.ts` and `src/components/ui/EditorLogo.tsx` do not exist).
- [x] **Step 3: Download editor SVGs, write `LICENSES.md`, and implement `editors.ts` + `EditorLogo.tsx` (DeepSeek)**
      Download the 4 editor SVGs into `src/assets/editors/`, inspect each file for clean `viewBox` and dark/light theme visibility, create `src/assets/editors/LICENSES.md`, and implement `src/lib/editors.ts` and `src/components/ui/EditorLogo.tsx`.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/editors.test.tsx` → PASS.
- [x] **Step 5: Commit**
      `feat(editors): add bundled editor brand SVGs, metadata registry, and EditorLogo`

---

### Task 2: Shared `EditorSplitButton` in `FilesPanel` and `ProjectCard`

**Design Decision:** Replace the inline `EditorButton` in `src/components/files/FilesPanel.tsx` and the plain `"Open in editor"` `<button>` in `src/components/layout/ProjectCard.tsx` with one shared `EditorSplitButton` (`src/components/ui/EditorSplitButton.tsx`).

- `variant="compact"` (used by `FilesPanel`): renders `[EditorLogo] {active.label}` on the primary button (`h-7`) and `[ChevronDown]` on the right (`h-7 w-6`), matching existing Files toolbar geometry.
- `variant="card"` (used by `ProjectCard`): renders a full-width card row (`border-t border-border-subtle`) split into `[EditorLogo] Open in {active.label}` (`flex-1 px-3 py-1.5 text-left`) and `[ChevronDown]` (`w-8 border-l border-border-subtle`), so the selected editor's real logo is immediately visible in `ProjectCard` and clicking the chevron opens the identical 4-editor dropdown menu.
- Both variants read/write `useSettingsStore((s) => s.preferredEditor)` / `setPreferredEditor`.
- `FilesPanel` context menu line 200 (`Open in ${getEditorMeta(preferredEditor).label}`) reuses `getEditorMeta` instead of its inline ternary.
- `ProjectCard`'s top project header row (`[badge] {project.name} [FolderOpen]`) retains `openInEditor(workspace)` unchanged; `ProjectCard`'s `EditorSplitButton` invokes `openInEditor(workspace, editor)`.
- `src/stores/settings.ts` imports `EditorId` and `isEditorId` from `../lib/editors` without changing stored keys, types, or defaults (`"zed"`).

**Files:**

- Create: `src/components/ui/EditorSplitButton.tsx`
- Modify: `src/components/files/FilesPanel.tsx`, `src/components/layout/ProjectCard.tsx`, `src/stores/settings.ts`
- Modify test: `tests/right-panel-project-card.test.tsx`

**Interfaces:**

- `src/components/ui/EditorSplitButton.tsx`:
  ```ts
  import type { ReactElement } from "react";
  import type { EditorId } from "../../lib/editors";

  export interface EditorSplitButtonProps {
    onOpen: (editor: EditorId) => void;
    variant?: "compact" | "card";
    className?: string;
  }

  export function EditorSplitButton(props: EditorSplitButtonProps): ReactElement;
  ```
  - Primary button: `title={`Open in ${active.label}`}`, `aria-label={`Open in ${active.label}`}` (in `"card"` variant visible text is `Open in {active.label}`; in `"compact"` variant visible text is `{active.label}`).
  - Secondary trigger button: `aria-label="Choose editor"`, `aria-haspopup="menu"`, `aria-expanded={open}`, `title="Choose editor"`.
  - Menu container: `role="menu"`, `aria-label="Editor"`, rendering 4 `role="menuitem"` buttons (`EDITORS`), each showing `<EditorLogo editor={ed} />`, `<span>{ed.label}</span>`, and `<Check size={12} />` when `ed.id === preferred`.
  - Closes on `window` `mousedown` outside container or `keydown` `"Escape"`.

**Steps:**

- [x] **Step 1: Write failing tests (Gemini)**
      Update `tests/right-panel-project-card.test.tsx`:
  - Update the two `"Open in editor"` assertions (`lines 230–237` and `286–287`) to target the active editor split-button (`screen.getByRole("button", { name: /Open in Zed/i })`) and assert `expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha", "zed")` plus presence of `img[data-editor-logo="zed"]` inside that button.
  - Add `"renders editor dropdown on ProjectCard with logos for all four editors and switches preferredEditor"`: opens `Choose editor`, asserts `role="menu"` shows `VS Code`, `Zed`, `Antigravity`, and `File Explorer` each with `img[data-editor-logo="<id>"]`, clicks `VS Code`, and asserts `openInEditor` is called with `("C:\\work\\alpha", "vscode")`, `useSettingsStore.getState().preferredEditor === "vscode"`, and the primary button updates to `Open in VS Code` with `img[data-editor-logo="vscode"]`.
- [x] **Step 2: Run tests to verify failure (Gemini)**
      Run `pnpm test tests/right-panel-project-card.test.tsx` → FAIL (`ProjectCard` still renders plain `"Open in editor"` without `EditorLogo` or `Choose editor` dropdown).
- [x] **Step 3: Implement `EditorSplitButton` and wire `FilesPanel`, `ProjectCard`, and `settings.ts` (DeepSeek)**
      Create `src/components/ui/EditorSplitButton.tsx`, replace `EditorButton` and the inline label ternary in `src/components/files/FilesPanel.tsx`, replace the `"Open in editor"` button in `src/components/layout/ProjectCard.tsx`, and import `EditorId` / `isEditorId` in `src/stores/settings.ts`.
- [x] **Step 4: Run verification**
      Run `pnpm typecheck && pnpm lint && pnpm test tests/right-panel-project-card.test.tsx tests/editors.test.tsx` → PASS.
- [x] **Step 5: Commit**
      `feat(editors): share EditorSplitButton with brand logos across FilesPanel and ProjectCard`

---

### Task 3: Comprehensive tests for every editor entry, fallback, and preference persistence

**Design Decision:** Add a dedicated test suite (`tests/editor-chooser.test.tsx`) verifying `FilesPanel`, `ProjectCard`, `EditorSplitButton`, `EditorLogo`, and `useSettingsStore` together across all edge cases: all 4 editors (`vscode`, `zed`, `antigravity`, `explorer`), broken/missing logo fallback inside the menu and button, preference persistence to Tauri `settings_set` + `hydrate()`, synchronization between `ProjectCard` and `FilesPanel`, outside-click / `Escape` dismissal, and `FilesPanel` right-click context menu label updates.

**Files:**

- Create: `tests/editor-chooser.test.tsx`

**Steps:**

- [x] **Step 1: Write failing/target test suite (Gemini)**
      Create `tests/editor-chooser.test.tsx` covering:
  1. **Every editor entry in `FilesPanel` split-button & dropdown:**
     - Seeds `useProjectsStore`, `useThreadsStore`, `useUiStore.setState({ filePreview: "src/app.ts" })`, and mocks `workspaceTree` / `workspaceReadText` / `openInEditor` / `settingsSet` / `settingsGet`.
     - Renders `<FilesPanel threadId="th" />`, opens `Choose editor`, and loops over `[["vscode", "VS Code"], ["zed", "Zed"], ["antigravity", "Antigravity"], ["explorer", "File Explorer"]]`:
       - Asserts each menuitem renders `img[data-editor-logo="${id}"]` next to its label.
       - Selects each editor, asserts `openInEditor` receives `("C:\\work\\alpha\\src\\app.ts", id)`, `useSettingsStore.getState().preferredEditor === id`, `settingsSet` was called with `("preferred_editor", id)`, and the split-button's primary button displays both `img[data-editor-logo="${id}"]` and the updated label.
  2. **Shared persistence across `ProjectCard` and `FilesPanel` + `hydrate()`:**
     - Renders `<ProjectCard threadId="th" />` and `<FilesPanel threadId="th" />` (or switches in `ProjectCard` and verifies `FilesPanel` reflects the same `preferredEditor`).
     - Mocks `settingsGet` returning `"antigravity"` for `"preferred_editor"` (and `null` for others), calls `await useSettingsStore.getState().hydrate()`, asserts `preferredEditor === "antigravity"` and both surfaces show `img[data-editor-logo="antigravity"]`.
     - Mocks `settingsGet` returning `"unknown-editor"` for `"preferred_editor"`, calls `hydrate()`, and asserts safe fallback to `"zed"`.
  3. **Neutral glyph fallback inside `EditorSplitButton`:**
     - Triggers `fireEvent.error` on `img[data-editor-logo="zed"]` inside `EditorSplitButton` and asserts `[data-editor-fallback="zed"]` renders cleanly without removing the label or breaking click/menu interactions.
  4. **Dropdown dismissal & `FilesPanel` context menu sync:**
     - Opens `Choose editor`, presses `Escape` → menu closes; opens again, fires `mousedown` on `document.body` → menu closes.
     - Right-clicks a file in `FilesPanel` when `preferredEditor === "explorer"` and asserts the context menu item reads `"Open in File Explorer"`.
- [x] **Step 2: Run test to verify baseline / inspect any gaps (Gemini)**
      Run `pnpm test tests/editor-chooser.test.tsx`. If any assertion exposes a defect (e.g., `onError` reset, `aria-expanded`, `Escape` handling, or `hydrate`), verify failure before fixing.
- [x] **Step 3: Fix any surfaced edge cases if needed (DeepSeek)**
      Ensure all assertions in `tests/editor-chooser.test.tsx` pass cleanly without modifying `open_in_editor` allowlist or `preferredEditor` IDs.
- [x] **Step 4: Run full frontend & Rust verification**
      Run `pnpm typecheck && pnpm lint && pnpm test` → PASS.
- [x] **Step 5: Commit**
      `test(editors): verify all editor entries, fallback glyph, and preference persistence`

---

### Task 4: Acceptance, build verification, screenshots, and `DEVLOG.md`

**Goal:** Verify the complete integrated app on Windows, ensure TypeScript/lint/unit tests/Rust checks and production builds succeed, capture real screenshots showing the editor logos in `ProjectCard` and the `FilesPanel` dropdown, and record an accurate `DEVLOG.md` entry.

**Files:**

- Create: `docs/screenshots/editor-chooser-project-card.png`, `docs/screenshots/editor-chooser-files.png` (and optional `scripts/editor-shots.mjs` if not run inline, or delete scratch script after capturing)
- Modify: `DEVLOG.md`

**Steps:**

- [x] **Step 1: Run all verification gates**
      Run:
  - `pnpm typecheck`
  - `pnpm lint`
  - `pnpm test`
  - `cargo test --manifest-path src-tauri/Cargo.toml --lib -q -- --skip pty_round_trip_output_exit_and_input_write`
  - `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
    Record exact pass counts.
- [x] **Step 2: Build frontend and Tauri binary**
      In PowerShell:
  - `pnpm build` → PASS.
  - `Get-Process pult-core -ErrorAction SilentlyContinue | Stop-Process -Force`
  - `pnpm tauri build --no-bundle` → produces `src-tauri/target/release/pult-core.exe`.
- [x] **Step 3: Launch built binary and capture screenshots**
  - Launch `src-tauri/target/release/pult-core.exe` to verify the desktop window renders cleanly, then close it after capture.
  - Capture screenshots via `vite preview` + Playwright/Edge (matching `scripts/v3-shots.mjs`) with the right panel open showing:
    1. `docs/screenshots/editor-chooser-project-card.png` — `ProjectCard` `"Open in Zed"` split-button and opened dropdown showing VS Code, Zed, Antigravity, and File Explorer logos.
    2. `docs/screenshots/editor-chooser-files.png` — `Files` surface split-button and opened dropdown showing all four editor logos.
  - Visually inspect both PNGs with `view_file` to confirm crisp SVG rendering on dark UI, zero broken-image glyphs, and clean alignment.
- [x] **Step 4: Update `DEVLOG.md` and clean up**
      Add an entry to `DEVLOG.md` summarizing the bundled editor assets + `LICENSES.md`, `src/lib/editors.ts`, `EditorLogo`, `EditorSplitButton` across `FilesPanel` and `ProjectCard`, exact gate/test counts, build result, and honest provenance of the screenshots. Ensure no background `pult-core` process remains running.
- [x] **Step 5: Commit acceptance artifacts**
      `git add DEVLOG.md docs/screenshots/editor-chooser-*.png && git commit -m "docs(devlog): record editor brand icons verification and screenshots"`

---

## Execution notes (2026-11-15)

- All four marks are bundled under `src/assets/editors/` with `LICENSES.md`: VS Code and Antigravity from Iconify `logos`, Zed from Simple Icons (`#084CCF`), File Explorer represented by the neutral `vscode-icons/default-folder` glyph.
- The shared split button lives in `src/components/ui/EditorSplitButton.tsx` (`compact` for Files, `card` for ProjectCard); both surfaces open the same four-editor menu, persist `preferredEditor`, show a check mark on the active row, and close on Escape or outside click.
- `EditorLogo` falls back to a Lucide glyph per editor (`code`, `terminal`, `sparkles`, `folder`) when a bundled mark is missing or fails to load.
- Verification: `pnpm typecheck`, `pnpm lint`, `pnpm test` 268/268, `cargo test --lib` 158/158, clippy clean, `pnpm tauri build --no-bundle` pass.
- Screenshot `docs/screenshots/editor-brand-assets.png` renders every mark at 16px and 40px on dark and light surfaces. The integrated chooser is covered by `tests/editors.test.tsx` and `tests/right-panel-project-card.test.tsx`; a plain-browser harness cannot seed Tauri projects for an app-level chooser screenshot.
