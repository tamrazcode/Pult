# DEVLOG

One entry per milestone — decisions made, deviations from the spec, known issues (§0.6).

## Pult v3.2 — T3 parity pass (2026-11-15)

**Scope shipped.** A broad T3-alignment pass driven by the user's annotated screenshots, split into test-first tasks (Gemini authored the tests, DeepSeek implemented). The Right Panel now opens with a project card (name, Open in editor, branch, publish state, uncommitted `+N -N`, previous-agent counts) plus a `+` surface menu for Files / Diff / Terminal. Provider marks are real bundled SVGs (Claude starburst, OpenAI knot, Gemini spark, OpenCode) with a license note and a monogram fallback. The composer picker is T3-shaped: provider icon tabs, `Search models…`, model rows with `Ctrl 1…9` shortcuts and favorite stars, and a dot-track effort control. The empty state is now “What should we work on?” with the project name, no giant logo, and a theme-colored living ASCII canvas that drifts and ripples around the pointer/background clicks (reduced-motion aware, 30 fps). Composer no longer repeats the workspace/branch line (the project card owns it) and switches its send button to a queue icon while a run is active. Queued messages render as rows with Edit/Remove and a queue hint. Thinking/tool rows are flat inline lines; consecutive searches collapse into “Searched code N times”; expanded details show readable command/stdout with raw JSON behind a `Raw` toggle and inline images for imagegen payloads. Message hover shows Copy, Branch (starts a real new thread and prefills its composer) and the send time. The transcript token footer is gone. Custom context menus replace the WebView menu (Cut/Copy/Paste/Select All, selected-text Copy, link Open/Copy; thread/project rows keep their real menu), and every popover closes on outside click. Sidebar rows get right-edge chevrons and dark tinted project badges with bright initials; the footer is icon-only with hover labels and the search placeholder is “Search”. Settings gained a searchable grouped nav with General, Chat, Projects pages backed by persisted settings (confirm-delete, send key, follow-streaming, timestamps). Generated images returned as ACP image content blocks are projected as Markdown data URLs. Enabled providers are preflighted in the background at startup with cached status, and the selected provider is pre-spawned/initialized (10 min TTL) so the first message skips the Codex/Claude CLI cold start. The app icon was regenerated with a larger mark.

**Verification.** `pnpm typecheck`, `pnpm lint`, `pnpm test` 260/260 green; `cargo test --lib` 154/154 green with the known ConPTY flake skipped; `cargo clippy --all-targets -D warnings` clean; `pnpm build` and `pnpm tauri build --no-bundle` pass. Fresh screenshots: `docs/screenshots/v3-shell-header.png` (native window, real provider icons in the picker), `v3-live-ascii.png`, `v3-composer-picker.png`, `v3-settings-general.png`, `v3-settings-chat.png`, `v3-settings-projects.png`.

**Freeze hardening (user report).** Opening a project or one of its threads must never hang. Historical event payloads above 2 MB (the user's DB had 8 MB imagegen tool rows) are truncated at the IPC boundary before they reach the WebView, and live image/tool payloads are capped on both sides. Provider pre-warm is debounced and only fires on provider changes — project switches no longer spawn agents — and the runtime refuses duplicate warmup spawns while a cold CLI start is in flight. Local image files above 8 MB are refused, oversized ACP images become a notice, and the renderer shows “Image too large to preview” instead of decoding a huge data URL. The living ASCII canvas runs at 24 fps and pauses when the window is hidden. Project-badge initials are 10 px. Verified by opening the 8 MB imagegen thread and switching projects on the built exe (process stays responsive).

**Performance audit (Gemini, final).** Measurements before → after: production `dist` **12.72 MB → 4.98 MB** (Shiki switched from the all-languages bundle to `shiki/core` with 19 lazy grammar loaders); entry JS **446 → 332 KB gzip** (Diff/Terminal panels are now lazy `React.lazy` chunks); `pult-core.exe` **24.69 → 20.73 MB** (`lto = "thin"`, `strip = "symbols"`, `codegen-units = 1`); WAL checkpoints to zero on store open; idle ASCII drops to 12 fps (24 fps only while the pointer/ripples are active); Composer rejects attachments >1.5 MB and historical `AgentMessageDelta`/`AgentThoughtDelta`/`UserMessage.images` are capped at the IPC boundary; `gh --version` runs once per session; the duplicate `git refresh` from the project card is gone. Verified after rebuild: app opens the 8 MB imagegen thread and project switches while `Responding=True`, idle RSS ~32 MB, full suites 260 TS / 157 Rust green, clippy clean.

**Files surface and editor choice (follow-up).** The right panel's Files surface now lists the real thread workspace (flattened tree, ignored `node_modules`/`.git`/`target`, capped 2,000 entries) with search, image preview, text preview with line numbers, and an editor split-button (VS Code / Zed / Antigravity / File Explorer, persisted). Right-clicking a file offers Open in editor, Reveal in File Explorer, Copy relative path and Copy full path. Local Markdown links in the chat open the Files surface instead of leaving the app (HTTP links still open externally). `/` and `@` suggestion menus now accept Tab to pick the highlighted item. The app icon transform was re-centered.

**Provider self-updaters.** The sidebar refresh button now asks each CLI's own update source: Codex compares `codex --version` against `npm view @openai/codex version`, OpenCode compares `opencode --version` against the latest `sst/opencode` GitHub release. When a newer version exists the refresh icon becomes a download button with a dot; clicking it runs the provider's own updater (`codex update` / `opencode upgrade`) in the background — no package download or replacement. Other providers are reported as managed externally. The live updater was not run during development to avoid changing global installs. The icon mark was redrawn as a clean, centered 2×2 block grid with even margins and regenerated at every size.

**Editor brand icons.** The editor chooser now shows real bundled marks: VS Code, Zed, Antigravity, and a folder glyph for File Explorer in `src/assets/editors/` with a `LICENSES.md` source/license table. A shared `EditorSplitButton` replaces the inline button in the Files toolbar and the plain “Open in editor” row in the project card; both open the same four-editor menu, persist `preferredEditor`, mark the active row with a check, and close on Escape or outside click. `EditorLogo` falls back to a Lucide glyph if a mark is missing or fails to load, and no logo is fetched at runtime. Verification: 269/269 TS tests (including per-editor menu/logo and persistence coverage), `pnpm typecheck` and `pnpm lint` clean, `cargo test --lib` 158/158, clippy clean, `pnpm tauri build --no-bundle` pass. Asset proof: `docs/screenshots/editor-brand-assets.png` (16px and 40px, dark and light).

**Files surface round 2 and update feedback.** `workspace_tree` now returns `{ entries, truncated }`: the 2,000-entry and depth-6 caps mark truncation only when a non-ignored, non-empty subtree is actually cut, and Rust tests cover the exact boundaries. The cut-subtree probe is iterative with a 512-directory budget, so a deep generated tree cannot stall the command. The Files toolbar gained a refresh button (stale responses ignored, current preview kept) and the tree shows git status letters on files and ancestor folders (`M/A/D/R/U/?`, priority `U > D > M > A > R > ?`), fed by the existing per-thread git store. A one-line notice appears when the tree is truncated. The sidebar update button now names the provider and version while installing (`Updating Codex 0.169.0 -> 0.170.0`), keeps failed providers with their error text and retry dot after the loop, re-runs `providersUpdateCheck` instead of blindly clearing, and still never runs the updaters unless the user clicks. Verification: 276/276 TS tests, 161/161 Rust tests, `pnpm typecheck` and `pnpm lint` clean, clippy clean, `pnpm tauri build --no-bundle` pass.

**Composer depth.** The chat input now sits on a flat raised tray: a backing plate peeks out below and at the sides while layered offset/inset shadows lift the translucent composer above it. The `--shadow-composer-lift` token has dark/graphite and light variants; behavior is unchanged. Screenshots: `docs/screenshots/composer-lift-dark.png`, `composer-lift-light.png`.

**T3 workbench pass, links, widget and browser.** Chat Markdown links now classify the raw href: left click opens http(s) URLs in the OS browser (explorer.exe, not rundll32), workspace files open in the Files preview, and middle click follows the same path. Right-clicking a link opens a real menu: Open in browser / Copy link for URLs, Reveal in File Explorer / Open in editor / Copy path for workspace paths; selected text no longer steals the link menu. The project card moved out of the right panel into a floating right-edge widget in the thread view (project, editor split button, project scripts, branch, Commit & push, Changes); it defaults on, toggles from the new header button, and hides while the right panel is open. The right panel's "Open a surface" menu now lists Browser/Terminal/Files/Diff plus disabled Pull request/Linked PR/Device/Side chat with B/T/F/D/P/L/M/S badges and letter shortcuts; Browser is a new iframe surface with URL bar, back/forward/reload, local workspace HTML through `workspace_read_html`, a curl-based X-Frame-Options/CSP probe, and an "Open in system browser" fallback. Composer padding is fixed at `px-6`, the chat column keeps a 400px minimum, and the app window minimum is 1040x680. Queue rows gained Steer (move to head + cancel active run), inline pencil Edit with Save/Cancel, and drag reorder backed by `runs_queue_update` / `runs_queue_reorder` / `runs_queue_steer`. The Windows icon resource is now rebuilt when `icons/icon.ico` changes; the embedded 32px frame measures equal 7px side margins. Verification: 304/304 TS, 165/165 Rust, typecheck/lint/clippy clean, release build pass.

**Known gaps.** Project scripts and a Pull Requests surface in the Right Panel are still pending; the Codex imagegen wire shape was not captured against a live Codex run (the renderer handles base64/file payloads and ACP image blocks); extended thread-menu items (regenerate title, mark unread, auto-settle) are not implemented; the Branch action copies the message intent into a fresh thread, not the full transcript; permission mode still lives in the composer overflow; warm-start latency was not re-measured after the pre-warm change.

## Pult v3.1 — UI/UX audit + line-by-line code review (2026-11-15)

**Scope shipped.** After v3 acceptance, Gemini audited 13 fresh screens of every route (1440×900, 1024×700, light theme, open right panel, palette, composer picker) and then reviewed every frontend file, followed by every backend module. All Critical/Important findings were fixed with regression tests; both final re-reviews returned **review clean**.

**UI/UX fixes.** Providers got a real first-run empty state with an Add action (it previously said "Pick a provider on the left" with none configured); the 1180px breakpoint now auto-collapses one side rail so the transcript is never crushed; the diff header wraps instead of clipping branch/review/view controls; the command palette groups each section once, dims the page harder, traps Tab and restores focus; a global `:focus-visible` ring replaced the invisible native outline; Settings lost its duplicate "Settings" label and triple page titles (`RouteHeader` + `h2` only); Refresh moved from the sidebar footer to the search toolbar; the light-theme disabled send/composer got readable tint; icon-only controls gained labels; the theme preview accent bar is wider; About renders `version || "—"`.

**Frontend review fixes.** Approval A/S/D shortcuts no longer fire while typing in inputs; new-thread send dispatches before navigating and surfaces the error; Markdown external links open in the OS browser instead of replacing the WebView, and local images reset state per `src`; the diff panel remounts per thread and re-clamps scroll when content shrinks; virtualization uses stable row refs and mount-time measurement; Providers rows are a real button+switch pair with save errors surfaced; the palette restores focus and `Mod+N` clears the project; config picks are never pushed into another provider's live session; elicitation state resets per request; terminals decode UTF-8 per stream (split codepoints survive), copy the backfill array instead of mutating state, and drop decoder/buffer on removal.

**Backend review fixes.** `safe_path` now canonicalizes the nearest existing ancestor, closing arbitrary writes outside the workspace through non-existent Windows paths and symlinked parents; `record_frame` truncates on a char boundary; trailing agent events are drained before `finalize_run` instead of being discarded by the next pooled turn; Windows `.cmd` shims are tree-killed with `taskkill /T` (waited, under the child lock) so `node` grandchildren do not leak; dispatch's check-and-insert is atomic and every post-insert failure rolls the run back (typed `thread.busy`), queue pops are a single `DELETE … RETURNING` so two dispatchers cannot run one message twice, and a failed auto-dispatch re-enqueues; `git diff` validates its base against option injection and uses `EMPTY_TREE` for no-HEAD repos; agent terminals are owned per session and released on agent kill, pool eviction/invalidation and app teardown, panel PTYs are killed on thread delete, and a wedged run is force-killed before worktree removal; relative `../` paths are no longer auto-approved by Auto-edit.

**Verification.** `pnpm typecheck`, `pnpm lint`, `pnpm test` 221/221 green; `cargo test --lib` 154/154 green with the known ConPTY flake skipped; `cargo clippy --all-targets -- -D warnings` clean; `pnpm build` and `pnpm tauri build --no-bundle` pass. Gemini UI/UX audit → frontend line review → backend line review → three focused re-reviews, final verdict **review clean**.

**Screenshots.** `docs/screenshots/v3-*.png` were refreshed after the audit: single header, composer picker, theme previews, large-diff harness, plus `v3-providers-empty.png` and `v3-palette.png` for the two reworked screens.

## Pult v3 — single header, unified picker, real theme previews, fast diffs (2026-11-15)

**Scope shipped.** Nine-task plan executed inline. The duplicate global `Topbar` is gone: one 40px `<header>` per route now carries breadcrumbs/title, panel toggles and native window controls, while the sidebar owns the only `PultLogo` + "pult" brand. The new-thread workspace strip was deleted; `/chat` threads inherit the selected project's root and worktree strategy. The composer now has one provider/model/reasoning popover under a single trigger (`[logo] model  reasoning ▾`), with provider logos, boolean reasoning On/Off states, and a provider switch that keeps the popover open. The overflow keeps session mode, permission and unrelated config toggles. Incompatible picks are pruned in the UI and filtered again in Rust against the values each agent actually advertises at handshake, so Codex never receives stale Claude model/effort keys. Typography moved to a 14px body scale (12/14/15/17/22/30) with no remaining 9–11px text utilities; diff mono is 13/22 and xterm is 14. Theme tokens are now scoped with `[data-theme="..."]` and Appearance renders real miniature windows for Dark, Light, Graphite and Liquid Glass. The diff panel loads metadata only (`git_diff_summary`), fetches a file's patch lazily on expand (`git_diff_file`, repo-root/base validation, blob-SHA `patchHash`), virtualizes rows with dynamic measurement, collapses directories for >200-file diffs, and caps a single patch at 2,000 rendered lines with a "Show all" action.

**Verification.** `pnpm typecheck`, `pnpm lint` and `pnpm test` 213/213 green; `cargo test --lib` 149/149 green with the known pre-existing ConPTY flake skipped; `cargo clippy --all-targets -- -D warnings` clean; `pnpm build` and `pnpm tauri build --no-bundle` pass (release binary `src-tauri/target/release/pult-core.exe`).

**Review fixes.** Gemini's whole-branch review found three Important issues, all fixed with regression tests: the virtualizer's long-lived `ResizeObserver` kept a stale `applyHeight` closure after a directory expanded (rows beyond the old count stopped measuring); native window controls shifted inward when the right panel opened (now fixed to the window edge with reserved header/panel padding); and an expanded file row lost its open state when virtualized away or when refresh evicted its patch (open state now lives in `DiffPanel`, and open rows re-fetch). Minor parser/glass/preview and duplicate-page-heading findings were also addressed. A focused Gemini re-review of the fix commit returned **review clean**.

**Screenshots.** `docs/screenshots/v3-shell-header.png` is the live built `pult-core.exe` window (single header, window controls, sole sidebar brand). `v3-shell-browser.png` is the same shell in a plain browser fallback. `v3-composer-picker.png` is a browser render of the unified popover; the plain-browser build has no agent instances, so its provider list is empty (the seeded/unit-tested picker covers the populated state). `v3-theme-previews.png` shows all four scoped theme cards. `v3-diff-large.png` renders the real `DiffPanel`/token styles from a 2,000-file seeded summary harness; it is not a live repository and no file was expanded.

**Known limitation.** Headless desktop automation cannot click into this WebView, so the native window shows only the default shell/composer; popover and large-diff screenshots come from the browser/component harness, while their behavior is covered by the tests above.

## Pult v2 — history, speed, projects, T3 shell (2026-11-15)

**Scope shipped.** 17-task plan executed inline (Gemini authored the plan and every test file; DeepSeek implemented). Highlights: full multi-run transcript merging with a right-edge `HistoryTicks` rail; per-turn `RunTiming` telemetry; an idle ACP process/session pool per thread (`IdlePool`, 6 max, 15 min TTL, LRU); 40 ms event batching with delta coalescing, one SQLite transaction + one `run:events` IPC per batch; async `threads_get`; targeted `agent:caps` updates instead of `loadInstances`; frontend streaming work (throttled markdown, lazy Shiki grammars, memoized rows, scroll pinning, point selectors); SQLite v4 projects with folder-backed workspaces, strict `workspace.missing` failures, native folder picker, create/settings dialogs; T3-style sidebar (projects, stars, search/filter, unread, footer toolbar) and keyboard-accessible context menus; project-aware header/breadcrumbs; Katagami Sans/Mono; Liquid Glass theme with brighter `--panel-bg`; minimal composer with one model pill, one `⋯` overflow (the only permission control), paperclip, round send/stop; project logo across shell, new-chat screen, favicon and regenerated app icons.

**User-requested additions.** New-chat welcome screen (large logo, "What should we do in Pult?", deterministic ASCII backdrop, inline composer), composer width capped to the transcript column, taller glass composer with stronger blur, and a backlog entry for agent-generated images (Codex `imagegen`) — see the plan's Backlog section.

**Post-walkthrough fixes (2026-11-15).** Liquid Glass surfaces are now neutral instead of blue-tinted. Markdown images with local paths (`C:\...`, `file:///...`) render through a new `read_image_data_url` command, restricted to the thread/project workspace or pult home, 20 MB, raster-only, with UNC rejected before any SMB lookup. Stale desired config picks are filtered against the options each agent actually advertised, fixing Codex's `-32602 Invalid params` for `thinking_level`/`effort`. The selected provider is remembered per thread (and restored from the last run), `/chat` picks are copied to the new thread, and stale send errors clear on thread switch. The sidebar filter popover now anchors to the search row instead of clipping off the left edge.

**Verification.** `pnpm typecheck`, `pnpm lint`, `pnpm test` 196/196 green; `cargo test --lib` 138/138 green with the known pre-existing ConPTY flake skipped (`runtime::ptys::tests::pty_round_trip_output_exit_and_input_write`, reproduces at base `1258ec2`, passes alone); `cargo clippy --all-targets -- -D warnings` clean; `pnpm build` and `pnpm tauri build --no-bundle` pass.

**Performance (fresh process, `scripts/perf-turn.mjs`).** These numbers intentionally measure a fresh process; the pool removes them from repeated turns.

| Agent       | turn 1 spawn+handshake+session | turn 2 spawn+handshake+session | first delta    |
| ----------- | ------------------------------ | ------------------------------ | -------------- |
| mock        | 6 + 54 + 0 ms                  | 5 + 47 + 0 ms                  | 29/39 ms       |
| opencode    | 9 + 434 + 1727 ms              | 3 + 437 + 2073 ms              | 10.6 s / 3.0 s |
| codex       | 11 + 11621 + 2572 ms           | 3 + 1966 + 912 ms              | 4.3 s / 3.7 s  |
| antigravity | 9 + 11702 + 5005 ms            | 2 + 11064 + 4475 ms            | 268/195 ms     |

Pooled turns skip spawn/initialize/session entirely (integration test: two sequential turns on one thread write exactly 1 PID and both finish; `pool.stats().idle == 1`). The 40 ms batcher caps delta IPC/SQLite writes at ~25/s per run; adjacent deltas coalesce to one event, and barriers (tools/approval/finish) flush first. Warm overhead is below the 10 ms target by construction; the hard <100 ms gate is covered by the per-turn `run:timing` telemetry.

**Decisions.** (1) Katagami TTFs are kept as source/provenance, while the app loads subset WOFF2 (16.6 MB → ~487 KB) with `OFL.txt` bundled under `/fonts/katagami/`. (2) A desired mode is re-sent on pooled turns rather than trusting a stale `applied_mode`; correctness beats one round-trip. (3) Full `cargo test` documents the PTY flake instead of hiding it; task gates run the suite with that one environmental test skipped. (4) `katex` is now a direct dependency because pnpm's strict resolver blocked its CSS after the font packages were removed.

**Known issues / gaps.** The live desktop walkthrough is limited to launching the built app and capturing the new-chat/shell screenshots (`docs/screenshots/v2-new-chat.png`, `docs/screenshots/v2-shell-final.png`): headless desktop automation cannot click this WebView. The native folder picker, context-menu actions and Liquid Glass theme are covered by tests but not clicked end-to-end in the window. Local image artifacts are limited to raster files under a known workspace (remote URLs are never auto-fetched). The Rust PTY round-trip test is order-dependent in this environment.

## Connection fixes — required `mcpServers`, Antigravity (2026-11-14)

**Scope shipped.** OpenCode and Codex ACP sessions failed with `-32602 Invalid params` because `session/new`/`session/load` omitted `mcpServers` when the list was empty (serde `skip_serializing_if`), while the schema marks it required. Both fields now always serialize (`"mcpServers": []`); live probes confirmed OpenCode 2.3.0 and Codex ACP 2.6.0 complete initialize + session/new, and the app's preflight reports Connected with full config options. Added Google Antigravity: pult detects the standalone `agy_acp_server.exe` (installed under `%LOCALAPPDATA%\pult\antigravity`, or on PATH), verifies the official Google zip's sha256 before use, and raises the ACP initialize timeout to 60 s for its 12–25 s Windows cold start. The server itself runs the OAuth flow and opens the browser (verified: `Authentication successful`, provider Connected 1.5.0 in the app).

**Verification.** `cargo test` 116/116, clippy clean; vitest 116/116, typecheck/lint clean. Live: OpenCode 2.3.0 Connected · resume · images; Codex 2.6.0 Connected; Google Antigravity 1.5.0 Connected after Google login. The async Gemini review of these fixes failed at the provider level (`Provider turn failed`), so they carry the live-probe evidence instead of a second reviewer.

**Decisions.**

1. **Always send schema-required empty arrays.** A lenient `skip_serializing_if` is wrong for required fields; strict agents reject the whole request.
2. **Antigravity's standalone server is the supported ACP path** (same artifact T3 Code downloads); the IDE alone is not an agent. pult owns the install path, but never auto-downloads during detection.
3. **Cold start gets a longer initialize timeout**, not a per-agent fork: 60 s only delays failure for a hung agent.

**Known issues / gaps.**

- The OAuth browser is opened by the Antigravity server from a background process; Windows may keep pult focused. Opening the URL from pult would steal focus but risks a second tab; not wired yet.
- pult does not download Antigravity automatically; the exe must be present (the docs path above).

## M12 — Usage insights (2026-11-14)

**Scope shipped.** `/usage` is a real screen over the persisted ACP `usage_update` events. `Store::usage_report` reads existing `events`/`runs`/`threads` rows, keeps the **last valid snapshot per run by max seq** (corrupt/legacy payloads are skipped, never fatal), and groups by thread and provider without summing gauges. IPC `usage_report` runs the query in `spawn_blocking`; outside Tauri the wrapper returns an empty report. The route shows honest KPIs (runs with usage, median and peak context at run end, latest reported cost marked "not summed"), Runs/Threads/Providers tabs, a provider filter whose thread rows are recomputed from the filtered runs, provider-scoped empty states, an IPC error with Retry, and keyboard-openable rows. Navigation: breadcrumb, `navigate.usage` palette command, sidebar button with `aria-current`. Antigravity detection stayed out: no verifiable CLI/ACP invocation exists in the repo or docs, and inventing one would break the project rule.

**Verification.** Rust 115/115 (parsing valid/partial/corrupt payloads, empty DB, last-seq selection, broken latest payload fallback, even median, last cost-bearing run, camelCase serialization), clippy `-D warnings` clean. Frontend typecheck/lint green, vitest 116/116 (helpers, page states/navigation, breadcrumbs, command). Gemini final review: 1 major + 4 minor/nits; fixed the unscrollable page, provider-scoped thread rows, latest-cost consistency, deterministic tie-breakers, currency trimming, doc comment, keyboard rows and `aria-current`.

**Decisions.**

1. **Gauges are never summed** — context fill and agent-reported cost are per-run facts; the UI says "not summed" instead of inventing a bill.
2. **Last valid snapshot by seq**, not timestamp or insert order; a broken newest payload falls back to the previous valid one.
3. **Thread rows are computed from the filtered runs** so a provider filter cannot show another provider's numbers.
4. **No index added** (`events(kind)`) to respect the no-migration constraint; the scan is a known scale limit.

**Known issues / gaps.**

- `usage_report` scans `events` without a `kind` index — fine at fixture scale, revisit for huge histories.
- Tables render all rows without virtualization.
- No live refresh while a run is streaming; the page is a snapshot with a Refresh button.
- Real CLI usage payloads and the live window were not exercised this round.

## M11 — ACP sign-in flow (2026-11-14)

**Scope shipped.** Providers that report Needs sign-in now have a real way in. `AuthMethod` carries terminal `args`/`env` (null-tolerant) and knows `is_terminal`/`is_agent`; the driver speaks `authenticate`, and only `-32000` counts as auth-required (any other RPC/start error stays an error instead of a fake sign-in prompt). `AgentRuntime::authenticate` runs the full cycle spawn → initialize → authenticate → **fresh `session/new` probe** → kill on every path, so an agent that answers `{}` without unlocking is honestly reported as "Still needs sign-in". The auth state and advertised methods are cached in `CachedCaps`, surfaced through `InstanceInfo` (status `needs_auth`, methods, hint) and `PreflightReport`, and survive navigation/`loadInstances`. The mock agent gained env-gated scenarios (`MOCK_AUTH_REQUIRED`, `_TERMINAL`, `_FAIL`, `_STILL_REQUIRED`, `_STATE_FILE`), covered by golden and runtime tests. UI: one `SignInActions` block shared by Providers and onboarding — Sign in buttons for agent-managed methods, a copyable terminal command + Re-check for terminal methods (never sent over RPC), an honest fallback when nothing is actionable, and Re-check now refreshes the cached status so the badge clears.

**Verification.** Rust 109/109 (auth parsing/null tolerance, `-32000`-only classification, golden authenticate/failure scenarios, preflight cache, successful authenticate clears status and warms config, still-required keeps Needs sign-in, failure errors, terminal methods rejected, per-instance mock env seam), clippy `-D warnings` clean. Frontend typecheck/lint green, vitest 107/107. Gemini final review: 2 majors + 4 minors; majors fixed with tests (fresh report outranks cached status and Re-check reloads instances; UTF-8 mojibake/BOM accidentally introduced into two Rust files by a shell rewrite was reversed). Minors fixed in the same pass (auth methods cleared when no longer advertised, non-agent types rejected, "Still needs sign-in" only after a real still-required report, empty-arg quoting).

**Decisions.**

1. **Only `-32000` is sign-in.** Any other failure is a real error; this closes the false "Needs sign-in" class from the OpenCode episode.
2. **The second probe is mandatory.** `authenticate` success alone proves nothing; a new `session/new` on the same connection is the honest check.
3. **Terminal auth is a copyable command, not an in-app PTY.** The PTY registry is thread-bound and a TUI login cannot be verified without the GUI; M11 shows the exact command and a Re-check.
4. **Mock scenarios ride per-instance env** (merged into the mock spawn) plus a `#[cfg(test)]` registry seam — process-env mutations were racing other runtime tests.

**Known issues / gaps.**

- No interactive auth PTY outside a thread; terminal sign-in stays a copy/paste flow.
- Real OAuth/device-code flows were not exercised (no Claude/Gemini CLI here); protocol shapes are covered by the mock.
- `set_instances` does not clear cached capabilities when a provider's command/driver changes, so stale auth methods can linger until the next preflight.

## M10 — Typed config options & composer pickers (2026-11-14)

**Scope shipped.** Session `configOptions` are now typed end to end (select flat/grouped and boolean), with a lenient deserializer that keeps old `pult.db` rows and future option types loadable. The client advertises `session.configOptions.boolean`, the driver speaks `session/set_config_option` (string values without `type`, booleans with it), and the mock agent serves `model` (grouped: mock-fast/mock-pro, legacy mock-v1 that narrows thought levels), `thought_level` and a `web_search` toggle. Preflight caches the probe session's options, so the composer pills appear right after Connect. Picks persist per thread in the settings KV (`thread_config:<id>`), ride on `ThreadDetail.desiredConfig`, apply to the next run before the prompt (model first, then thought level), and fill `RunRecord.model`/`.effort`; a rejecting agent logs a warning and emits a Notice instead of failing the turn. The composer renders select pills with group headers and boolean toggles; `/chat` picks apply once to the new thread and are cleared; Esc closes a popover without cancelling the run. Providers and Diagnostics show the option count.

**Verification.** Rust 100/100 (typed parsing incl. grouped skip-invalid, wire shapes, capabilities, golden config round-trip with `-32602`, preflight cache, apply-before-prompt, stale pick does not fail the turn, live mid-run pick keeps the run healthy, deterministic apply order), clippy `-D warnings` clean. Frontend typecheck/lint green, vitest 98/98. Gemini final review: 1 blocker + 2 majors + 3 minors; all fixed with tests (live config sequencing via the run's answer channel, empty-map hydrate no longer wipes picks, deterministic apply order, lenient group options, settings cleanup on delete, live options only for the selected instance).

**Decisions.**

1. **One event writer per run:** a live `set_config_option` is queued to the run loop through the existing answer channel; the loop owns `next_seq`. Direct DB writes from the IPC command raced the run's counter and could fail the turn.
2. **Apply order is fixed, not HashMap order** — `model` first, then thought level, because agents narrow dependent option lists when the model changes.
3. **Lenient by construction:** null/unknown/broken option entries are skipped, never fatal for the whole picker or transcript.
4. **Picks are optimistic in the UI and verified by the agent:** the store updates immediately, the backend persists, and the next `session/set_config_option` is the source of truth.

**Known issues / gaps.**

- `RunRecord.model`/`.effort` name the requested values; when an agent rejects a stale pick the record still shows it (the run uses the agent default). Cosmetic until a run-details surface reads these fields.
- Option ids `model` / `thought_level` / `reasoning_effort` drive the record fields; agents using a different id with `category: "model"` are shown correctly in the picker but leave the record fields empty.
- Real CLI legs (Codex/OpenCode/Claude/Gemini) were not exercised this round; the mock covers the protocol shapes.
- No GUI/Playwright pass.

## M9 — Chat, thread lifecycle & navigation integrity (2026-11-14)

**Scope shipped.** The daily loop is now internally consistent. Hydration: `threads_get` carries `activeRunId` and `desiredMode` into the store; a live run no longer flips to "pult restarted while this run was active" when you switch threads, transcript events are deduped by id (both replay orders), a stale snapshot cannot resurrect a finished run, and `threads_get` reads the live-run id before the runs. Composer: Esc stops the run unless a palette/dialog/picker/slash/@ layer owns the key (layers advertise `data-escape-layer`), slash picks keep their leading `/`, the approval bar exposes every offered option (A/S/D), the textarea is read-only while a decision is pending, and `@` opens a debounced workspace file list (`workspace_files`, BFS with VCS/build skips and 3000/200 caps). Session mode: picked modes persist per thread in the settings KV (no schema change), survive restarts via `ThreadDetail.desiredMode`, apply to the next run before its prompt, and never leak from `/chat` into an existing thread; the picker prefers the remembered mode over a finished run's mode. Thread lifecycle: rename, pin, snooze, settle and delete (two-step confirm, worktree hint) live in `ChatHeader`; deleting the active thread cancels its run, drops store state and lands on `/chat` only on success; the `working` shelf no longer accepts drops. Navigation: route-aware breadcrumbs replace the static `pult / chat`, the sidebar's fake "Add project…" is an honest workspace entry, and the terminal label uses the active shell + workspace folder. Links: `open_external_url` opens http(s) in the system browser (validated, one argv element, no shell) and backs elicitation URL mode and PR links; a failed open shows an error instead of silently accepting. `fresh` detail: vitest now actually runs `*.test.tsx` (three suites had been silently skipped since M7).

**Verification.** Rust 91/91 (workspace walk, desired-mode apply on the mock, delete-mid-run cleanup, URL validation), clippy `-D warnings` clean. Frontend typecheck/lint green, vitest 92/92 across 14 files. Gemini final review: 4 majors + 7 minors; the majors (mode leak from `/chat`, picker shadowing, Esc through picker/header layers, delete-mid-run runtime leak) fixed with tests, cheap minors fixed in the same pass (dedupe both directions, BFS for `@`, `key={threadId}`, store cleanup, URL whitespace/quotes, honest chevron). Playwright smoke (including the new breadcrumb assertion) was **not** verified: the local Vite dev server hangs at `[optimizer] scanning/bundling dependencies` and answers no HTTP; no live WebView2 walkthrough this round.

**Decisions.**

1. **Thread-scoped preferences in the settings KV, not a schema migration** — `thread_mode:<id>` survives restarts and costs no migration; `desiredMode` rides on `ThreadDetail` instead of a new IPC command.
2. **Overlay ownership is a DOM contract** (`data-escape-layer`), not a global key router: any layer that owns Esc marks itself, and the composer checks the document. One rule, no hook-order traps with window listeners registered in different orders.
3. **Esc cancels only when nothing is above it**; the slash and `@` menus are treated as layers too, so typing Esc never kills a turn mid-word.
4. **`@` mentions are server-walked, BFS, hard-capped** — the UI never touches the filesystem and a monorepo cannot stall the IPC worker.
5. **External links: validate in Rust, open with the OS handler, never a shell** — `rundll32 url.dll,FileProtocolHandler` on Windows, `open`/`xdg-open` elsewhere; http(s) only, whitespace/quotes/control chars rejected.

**Known issues / gaps.**

- Playwright smoke and the live WebView2 pass remain unverified this round (dev-server optimizer hang; no window run while the machine was gaming).
- `@` mentions are thread-scoped (no mentions on `/chat` before a thread exists).
- Sidebar rows have no context menu; bulk thread actions require opening each thread (ruling in the M9 ledger).
- `AgentPicker`/`ModePill` Esc handlers still rely on their backdrop layer rather than calling `preventDefault` themselves.

## UX pass — composer-driven controls, one-click agents, resizable panes (2026-11-14)

**Scope shipped.** The §6.1 composer contract, finally all the way: the control bar now
carries instance ▸ session mode ▸ permission pill (moved out of the chat header, which keeps
thread identity only), a status line with the run target (workspace path · git branch,
`\?\?\` prefix stripped, home shortened to `~`), a "+" attach button, and a progress hairline
traveling the composer's top edge while a turn runs (hidden under
`prefers-reduced-motion`). One-click agents: detection gained Codex (official
`@agentclientprotocol/codex-acp` bridge — the handshake was probed live on this machine:
"Codex 2.6.0, loadSession, image ✓") and OpenCode (native `opencode acp`); every detected
CLI carries a prefilled command, and the Connect button in Providers/onboarding adds the
instance and immediately runs a preflight (spawn → initialize → cache caps → kill; no prompt
is ever sent, so the check is free) reporting Connected / needs sign-in / error on the row.
Resizable panes (§6.1 "resizable", shipped late): drag the sidebar edge (220–480 px) or the
right panel's (300–720 px); the handle is a keyboard-complete `separator`
(Arrows/Home/End) and widths persist in the settings table. A real settings gear in the
topbar plus `Ctrl+,` through the palette registry (rebindable). Brand icon: prompt-glyph
mark (accent chevron + caret on the T3 dark square) replacing the placeholder sliders —
regenerated the full icon set. Boot hygiene: `reset_orphaned_run_states()` flips threads
stuck in `working`/`waiting` by a killed process to drafts (no dead spinners, `updated_at`
untouched).

**Verification.** Rust 86/86 (incl. the orphan-reset store test), clippy `-D warnings` clean;
typecheck/lint green, vitest 54/54, Playwright smoke 5/5. Release bundle rebuilt with the new
icon and signed updater artifacts; the running instance swapped to it and the composer bar /
resize handles / connect rows verified over CDP screenshots. Live evidence for the codex
adapter: `npx -y @agentclientprotocol/codex-acp` answered the initialize handshake on this
machine.

**Bugs fixed on the way.**

1. Onboarding "Add" **replaced the whole instance list** with the one agent
   (`providersInstancesSave([spec])` on a fresh array) — now appends.
2. Adding an agent in settings did not refresh the composer's agent picker (ui store loaded
   instances once at mount) — every add/remove now refreshes the store.
3. Detection test would have rejected the new `opencode` id and the now-mandatory one-click
   commands — updated with the stricter invariant (every detected agent ships a command).

**Decisions.**

1. **Controls follow the decision point** (the layout thesis of this pass): anything that
   parameterizes the next message lives in the composer bar; the header carries identity.
   The panel toggles stay in the topbar because they shape the workspace, not the message.
2. **Preflight instead of a test prompt**: connecting should never cost tokens or touch a
   session, so the check is initialize-only; `needs_auth` surfaces from `authMethods` with
   the agent's own sign-in command in the tooltip.
3. **Resize persistence on commit, not on every pixel** — pointer-up / keyboard step writes
   the setting once (`layout` JSON key), keeping the settings table quiet during drags.
4. **Widths live in the ui store** (view state), persisted through the generic settings
   table rather than a new backend concept.

**Known issues / gaps.**

- OpenCode is connected via its documented native `opencode acp` mode, but the CLI is not
  installed on this machine — the adapter command is upstream-verified, the live handshake
  was not exercised here (Codex was).
- Panel widths persist but are not per-thread (global layout, as in reference IDEs).

## M8 — Distribution (2026-11-14)

**Scope shipped.** Bundler config per OS: `bundle.targets: "all"` produces the NSIS installer
and MSI on Windows (dmg/deb/AppImage on macOS/Linux by the same config), with
`createUpdaterArtifacts: true` so every bundle ships with a sidecar `.sig`. Updater plugin
(`tauri-plugin-updater`) wired with the `updater:default` capability and a real minisign
keypair: the public key lives in `tauri.conf.json`, the private key was generated outside the
repo (`~/.tauri/pult.key`, empty passphrase) via `tauri signer generate` — documented in the
README together with the endpoint swap procedure (placeholder `releases.pult.local`; nothing
calls the updater at startup, so the placeholder is harmless). First-run notes for macOS
Gatekeeper in the README. README rewritten around real screenshots (`docs/screenshots/`:
dark/light/graphite chat, palette, diff panel, appearance settings — captured from the live
app over CDP), config reference, keyboard map, and the build/distribution story. CHANGELOG
introduced with per-milestone entries. Version stays 0.1.0 (dev line, unreleased).

**Verification.** `pnpm tauri build` completed end-to-end with signing:
`pult_0.1.0_x64_en-US.msi` (7.7 MiB NSIS setup alongside) plus **two updater signatures**
(`.msi.sig`, `.exe.sig`) produced with `TAURI_SIGNING_PRIVATE_KEY` — proving the keypair and
the updater artifact pipeline work. The release binary (`target/release/pult-core.exe`)
launched standalone — embedded production assets serve at `tauri.localhost/chat`, no dev
server — and was killed after the smoke check. Frontend gates green (typecheck/lint/vitest
54/54/build, Playwright 5/5), Rust gates green (85/85, clippy `-D warnings`).

**Decisions.**

1. **Dev keypair committed as pubkey-only** — the private key never enters the repo;
   the README's procedure regenerates both for production.
2. **Updater stays inert** until an endpoint+pubkey pair that actually resolves is
   configured: the plugin registers but no code path calls it at startup, so shipping the
   placeholder is safe.
3. **Screenshots from the real window over CDP** (not mockups): they double as the visual
   record of the M7 themes/palette/diff work.

**Known issues / gaps.**

- One commit+push (author "pult demo") landed in `fixtures/mock-repo` during the M8
  walkthrough containing the dirty walkthrough state (README modification + an untracked
  demo file). No auto-commit path exists in the code (store `refresh` is read-only; the
  commit/push buttons require clicks), so the most plausible cause is a stray CDP click on
  the diff-panel action chain during screenshot automation; the mock `gh` log shows no
  `pr create`, matching a chain stop after push. No recurrence observed; the fixture repo is
  a demo playground by design.
- Windows builds are unsigned (no Authenticode cert in this environment); CI signing is a
  documented seam, not wired.
- macOS/Linux bundles are configured but not exercised on this machine (Windows-only dev
  box); `targets: "all"` delegates to the bundler per host.

## M7 — Polish: themes, palette, keybindings, error states, smoke suite (2026-11-14)

**Scope shipped.** Themes (§6.6): `themes/light.css` and `themes/graphite.css` override only
the token block (dark stays the default in `tokens.css`); a vitest suite parses all three
files and asserts WCAG ≥ 4.5:1 for every text token on canvas/surface/chrome/raised, accent
foreground on accent, and diff foregrounds on canvas — the light palette was tuned until it
passed (`--text-tertiary` went #737373 → #6b6b6b). `settings.appearance` offers theme cards
with live swatches and a 10-stop accent hue picker that regenerates accent/mention/monogram
tokens via HSL (bright hues flip `--accent-fg` to the canvas ink by computed luminance).
Settings persist through new `settings_get`/`settings_set` IPC commands over the §4.5 sqlite
settings table; the store hydrates at boot and applies before first paint. Command palette
(§6.7): one data registry (`lib/commands.ts`) drives both the ⌘K palette (type-to-filter, ↑↓,
Enter, sections: Navigate/Actions/Threads/Appearance/Settings, recent threads included) and
the global hotkey handler; keyboard hints show the effective binding. Keybindings page rebinds
the five bound commands (click, press, Esc cancels, reset per row); overrides persist. The
sidebar search button and "Add project…" footer buttons now do real things (palette; the
/chat workspace strip) instead of being dead controls. Error states (§8 M7): agent crash —
an `AcpConn` death flag distinguishes a mid-run process death from our own `kill()` and emits
the `agent:process` `crashed` event the banner was waiting for; storage — thread-load
failures raise a global banner; protocol — the run-level CrashBanner gained "Retry last
message" (re-dispatches the last user turn). All three render a designed recovery path
(dismiss / open diagnostics / retry), never a silent stall. A route-level error card replaces
blank panes on render crashes. FPS overlay (§6.5) behind `?fps=1` or `localStorage["pult.fps"]`,
showing rolling fps + worst frame time. Long transcripts render a 300-item tail window with
"Earlier messages (N hidden)" expansion so a 10k-event thread stays bounded. Playwright smoke
suite (`tests/e2e`, 5 specs) runs against the vite dev server in system Edge (WebView2's
engine — no chromium download): shell boots with zero console errors, palette opens/filters/
switches themes, settings routes render, accent pick regenerates tokens live, fps flag works.
Empty states audited across routes/shelves/panels (already designed in M0–M6; the a11y pass
added `aria-current` settings nav, radiogroups for theme/accent with `aria-checked`,
labels/aria-labels on new controls, and the palette is a keyboard-complete `dialog/listbox`).

**Verification.** Rust 85/85, clippy `-D warnings` clean. Frontend typecheck/lint green,
vitest 54/54 (theme contrast 10, hotkeys/palette 6), build green, Playwright smoke 5/5. Live
walkthrough in the real window over CDP: Ctrl+K opened the palette, "Theme: Light" applied
`data-theme=light`, the purple accent set `hsl(270 …)` on `--accent`, and **after a page
reload both were restored from the backend settings table** (settings_get/set end-to-end);
rebinding palette-open to Ctrl+Alt+P worked (old combo dead, new combo live, reset restored
Ctrl+K); the agent-crash banner appeared after a real mid-turn process death
(MOCK_CRASH_MID_TURN=1 set through the providers UI), "Open diagnostics" navigated and
dismissed, and a recovery run finished `end_turn` after the env was removed through the same
UI.

**Bugs found and fixed during the walkthrough.**

1. **Bare modifier keydowns captured as bindings** — pressing Ctrl+Alt+P fired a keydown
   whose key is `"Control"` first, so the recorder stored `Mod+Control`, which then matched
   every subsequent Ctrl press and hijacked the keyboard. Fixed twice over: the recorder
   ignores Control/Shift/Alt/Meta keydowns, and `setKeybinding` refuses bindings that end in
   a bare modifier.
2. **Case-sensitive hotkey matching** — `matchesBinding` compared the binding's `"K"` against
   the event's lowercase `"k"`, so the palette default never matched; the smoke suite caught
   it. Keys are now normalized on both sides.
3. **Mid-run agent deaths emitted no `crashed` process event** (only spawn failures did), so
   the crash banner never fired for the most common crash shape. `AcpConn` now tracks
   `dead`/`killed` and `run_turn` emits `crashed` before its own `kill()`.

**Decisions.**

1. **Themes are pure token-block overrides** under `data-theme` — no component ever branches
   on the theme name, and the contrast test reads the same CSS files the app ships (via fs;
   vitest's `css: false` stubs `?raw` imports, which is why the first attempt failed).
2. **One command registry** (`lib/commands.ts`) is the single source for palette entries and
   hotkey defaults (`DEFAULT_BINDINGS` derives from it), so a command can never be reachable
   one way and not the other.
3. **Settings are JSON rows keyed by string** (`theme`, `accent_hue`, `permission_mode`,
   `keybindings`) through the existing §4.5 settings table — no schema churn; the store
   validates every value on hydrate (bad values fall back to defaults).
4. **Smoke suite runs in a plain browser against the vite server** (isTauri() guards stub
   IPC): shell/palette/themes/settings are UI-level and covered there; backend-involving
   flows stay with the CDP walkthroughs, which run the real WebView2 without stealing focus.
5. **Transcript windowing is a bounded tail, not a virtual scroller**: rendering the last
   300 items with chunked expansion keeps DOM size deterministic for huge threads without
   committing to a virtualization library in v1.
6. **Playwright excludes `*.spec.ts` from vitest** (`include` patterns) so the two runners
   never cross-import.

**Known issues / gaps (next milestones).**

- Keybindings UI covers the five global commands; composer-scoped keys (Enter/Esc/A/S/D) are
  documented as fixed rather than rebindable.
- The mock's orphaned `working` statuses after restart (M6 note) also make the palette show
  stale "working" threads until they run again.
- FPS overlay measures rAF cadence only; a full perf profile (long-task traces) is out of
  scope for v1.
- Real-CLI legs of acceptances remain environment-blocked (see M6 entry).

## M6 — Agent matrix, modes, diagnostics (2026-11-14)

**Scope shipped.** `~/.pult/config.toml` is the agent matrix source of truth: `[[instances]]`
(id, displayName, driver `mock`|`acp`, command, args, env) loaded at startup, saved through a
whole-table patch so unrelated keys survive, falling back to the built-in mock when the file
has none. Detection scans PATH for known CLIs (claude/gemini/codex/dsh, PATHEXT-aware) and the
`/welcome` wizard offers one-click "Add" with prefilled adapter argv; `/settings/providers`
edits instances (add/edit/delete → persisted immediately); the chat AgentPicker links to it
("Manage agents…"). Session modes (§5.4): caps cached per instance at handshake, the header
picker appears only when the agent advertises modes, `runs_set_mode` forwards
`session/set_mode` to the live connection and the agent's `current_mode_update` echo flows
back as a `mode_change` event that flips the picker label mid-run. Diagnostics (§8 M6):
`/settings/diagnostics` shows every instance's caps, a process-event ring
(starting/spawned/running/crashed/needs_auth), and "Frames" — the last 60 raw protocol frames
of the live connection (600-char truncation), with a typed error when no session is live.
IPC: `providers_detect_installed`, `providers_instances_save`, `runs_set_mode`,
`diagnostics_frames`.

**Verification.** Rust 85/85 (config round-trip incl. unrelated-key preservation, missing-file
fallback, detection candidates), clippy `-D warnings` clean. Frontend typecheck/lint green,
vitest 50/50, build green. Live walkthrough in the real window over CDP: detection listed the
installed CLIs (Codex CLI found, mock + custom instances configured); a custom ACP instance
(`node fixtures/mock-acp-agent.mjs`) ran end-to-end in a real thread (prompt → streamed
updates → diff); **mid-run mode switch verified end-to-end** — picker showed "Code" during an
active turn, clicking "Architect" flipped the label via the agent's echo (store
`view.modeId: "architect"`), after fixing the crash below; diagnostics frames captured on a
live run (7 raw frames: → initialize, → session/new, → session/prompt, ← session/update…)
and the typed "no live session" error renders when idle; instances persisted across two app
restarts (config.toml drove the list each boot, including an env patch that changed mock
behavior). **Environment limitation:** real Claude Code / Gemini CLI are not installed on this
machine (only Codex, which has no native ACP yet), so the real-CLI leg of the acceptance is
blocked by the environment — the machinery is verified through the custom ACP instance, and
the wizard's suggested commands match the adapters' documented invocations.

**Bugs found and fixed during the walkthrough.**

1. **`runs_set_mode` aborted the whole app** ("panic in a function that cannot unwind,
   STATUS_STACK_BUFFER_OVERRUN"): `runtime.set_mode` called `tokio::spawn` from a sync Tauri
   command, which runs on the main thread — outside any reactor. Fixed by making
   `runs_set_mode`/`runs_cancel` async commands (Tauri runs them on tokio) and replacing the
   bare `tokio::spawn` in `set_mode`/`cancel` with `Handle::try_current()` that degrades to a
   typed error instead of an abort. The Stop button (`runs_cancel`) carried the identical
   landmine and was fixed in the same stroke.
2. **Diagnostics page infinite re-render** ("Maximum update depth exceeded"): a zustand
   selector returned `s.processEvents[id] ?? []` — a fresh array every getSnapshot, which
   React's useSyncExternalStore treats as an endless update loop. Fixed by selecting the
   stable record and defaulting in render.

**Decisions.**

1. **Whole-table patch for config.toml saves** — parse the file as a `toml::Table`, replace
   only the `instances` key: serde-struct round-trips would silently drop user keys
   (a `theme = …` line survives a save, verified in a test).
2. **Modes appear after first handshake, UI refreshes on `run_finished`.** Modes live in the
   caps cache, which fills when a connection handshakes; the instances list re-fetches on
   ChatHeader mount and on run finish, so after a cold restart the picker materializes once
   the first run on that instance completes. Verified live (picker absent → warm-up run →
   picker visible).
3. **Frames ring on the connection, not the store** — 60 most recent frames per live AcpConn
   (both directions, truncated to 600 chars) makes diagnostics zero-cost until opened and
   truthful by construction; no live session → typed `git.no_…`-style error surfaced verbatim
   in the UI.
4. **`MOCK_SLOW_TURN` env on the custom instance** stretches mock turns (25→300 ms per
   message) so mid-run interactions (mode switch, frame capture) are reliably exercisable —
   the default echo turn finishes in ~700 ms, faster than any UI interaction.

**Known issues / gaps (next milestones).**

- After an app restart, threads interrupted mid-run keep `working` status in the sidebar
  until their next turn (runs don't survive restart by design; statuses are not resynced at
  boot).
- Real-CLI acceptance leg (Claude Code / Gemini CLI over their ACP adapters) pending
  installation of those CLIs on this machine; Codex lacks native ACP.
- Detection is a PATH scan without version probing (deliberate: cheap, offline); agents
  behind adapters may still need sign-in (`needs_auth` status renders in diagnostics).

## M5 — Terminals (2026-11-14)

**Scope shipped.** Per-thread PTY terminals with a real pseudo-console: `runtime/ptys.rs`
runs the user's shell (default `powershell -NoLogo`, argv override available) through
portable-pty/ConPTY in the thread's workspace, streaming output over a blocking reader
thread → channel → coalescing task (24 ms windows, §4.3 batching discipline) as
`terminal:pty` events (base64 so multi-byte splits survive the JSON bridge) with a
`terminal:ptyExit` summary. IPC: `terminal_pty_create/write/resize/kill/list` (input arrives
base64-encoded so arrow keys and pastes pass through untouched). The right panel's Terminal
tab is now the real surface: chips per terminal (live dot / exit code, kill ✕), an xterm.js
pane (fit addon follows container resizes → PTY resize; scrollback 5000; JetBrains Mono;
T3-matched colors), copy/paste wired into the key handler (Ctrl+Shift+C copies, Ctrl+C
copies when a selection exists so shells still get ^C, Ctrl+V pastes). Terminal tool rows
from the agent's `terminal/*` callbacks mirror into the panel read-only ("Agent terminals"
section — title, status dot, output preview; the mock wraps its terminal flow in an
execute-kind tool_call row for exactly this). Restart policy (§8 M5 acceptance alternative):
PTYs are children of the app, so a restart ends them by definition — the registry is
memory-only, the list re-syncs from the backend on thread open, and the empty state says so
in plain words. The acceptance's `top`-style TUI renders through `fixtures/tui-demo.mjs`
(alternate screen buffer, cursor positioning, box drawing, colors, live redraws).

**Verification.** Rust 82/82 (3 new PTY tests: full round-trip — spawn, output through the
sink events, exit event, closed-input typed error, live interactive shell echo — plus
resize/unknown-terminal typed errors; both play the terminal side of the ConPTY handshake),
clippy `-D warnings` clean. Frontend typecheck/lint green, vitest 50/50, build green. Live
walkthrough in the real window over CDP: "+ New terminal" spawned PowerShell whose prompt
showed the thread workspace; typing `Get-ChildItem …` through xterm.js echoed and rendered
the listing; `node fixtures/tui-demo.mjs` rendered the full-screen TUI mid-animation
(screenshot in-session — colored box, live load bar, updating process rows) and exited
cleanly through the alt-screen restore; the chip ✕ killed the terminal and the pane
reported it; a mock "terminal" turn surfaced its tool row in the Agent terminals mirror
("Run cmd /c echo mock-term-ok · completed · mock-term-ok (exit 0)"). The app restarted
mid-milestone during a rebuild and the terminal list came back empty with the documented
restart policy.

**Decisions.**

1. **ConPTY handshake stays with the real terminal.** On session start the child's console
   emits `\x1b[6n` (cursor-position report) and STALLS its renderer until the terminal side
   answers — discovered when a raw test harness saw only the request and nothing else. In
   pult the answer flows from xterm.js (which knows the true cursor) through
   `terminal_pty_write`; the backend never forges it, and the tests play the same role over
   the public API. A debug binary proved the theory: answering `\x1b[1;1R` unblocks the
   stream immediately.
2. **`try_wait` polling inside the coalescer tick instead of a blocking `wait()` thread**:
   portable-pty's Child is not cloneable, and waiting under the state lock would deadlock
   write/resize/kill; the poll is a cheap syscall on the same 24 ms tick.
3. **base64 both directions.** PTY bytes are arbitrary (UTF-8 splits at chunk boundaries,
   control sequences); JSON strings mangle them, base64 doesn't. xterm.js writes decoded
   strings; input is encoded from UTF-8 bytes.
4. **Backfill ring per terminal in the store**: chunks arriving while no pane is attached
   (tab switched, thread unmounted) replay on re-attach (capped ~512 KiB), so switching
   tabs never loses the tail.
5. **canonicalize() `\\?\` prefix stripped for the child's cwd** — PowerShell would
   otherwise print the `FileSystem::\\?\C:\…` location as the prompt.

**Known issues / gaps (next milestones).**

- Paste is wired but not exercised in the walkthrough (CDP automation cannot grant
  WebView2 clipboard-read); copy works through the selection path.
- A restarted app cannot reattach to pre-restart PTYs (they are OS children); the panel
  documents this and starts fresh — a persistence story would need an external process
  supervisor (deliberately out of scope).
- Terminal output lives in memory only (store backfill + xterm scrollback); nothing
  persists to disk (M3's ring buffer for agent terminals is likewise memory-only).
- The ACP `terminal/*` callbacks remain pipe-based (no PTY for agent shells) — agents that
  run TUIs through the callback would see degraded rendering; the ACP surface has no
  resize, so this matches the protocol.
- Single workspace pinned per PTY at creation; no cwd switcher yet.

## M4 — Git, diffs, one-click PR (2026-11-14)

**Scope shipped.** `git/mod.rs` shells out to real `git` (§4.4, no git2 crate), all paths
absolute: `status` (porcelain v1 `-z` with branch/ahead/behind and rename-safe parsing),
`diff` (byte-exact), `commit` (stage-everything matching the panel), `push` (creates upstream
via `origin` when missing, typed `git.no_remote` otherwise), `pr_create` (`gh pr create`,
URL parsed from stdout, `git.gh_missing` typed state), `worktree_create/remove` under
`<repo>/.pult/worktrees/<name>` with a `pult/<name>` branch, and `checkpoint` — the hidden
`refs/pult/checkpoints/<runId>` ref written automatically on every run finish (§4.4 "data is
cheap"; best-effort, skipped for non-repo workspaces). The diff projection runs through a
**scratch index**: copy the real index to a temp file (or `read-tree --empty` in a fresh
repo), `git add -N .`, then `git diff HEAD` — untracked files appear and the user's index is
never mutated, yet the bytes ARE `git diff` output. `git diff --no-renames` keeps the parser
deterministic; per-file sections are split verbatim so file slices concatenate back to the
raw text. Threads gained `workspace` / `main_repo` / `worktree_name` (migration v3):
`threads_create` takes an optional workspace + worktree flag (worktree threads work in a
fresh `git worktree`, session cwd pinned there; `.pult/` stays invisible via
`.git/info/exclude`, never the user's `.gitignore`), `threads_delete` removes the worktree
(best-effort) and keeps the branch. The right panel's Diff tab is now the full diff surface:
branch pill with ↑ahead/↓behind, directory-grouped file tree with diffstats and per-file
reviewed checkboxes (hash-gated, auto-reset when a file's diff changes), Unified/Split toggle
(own renderer — `lib/diffSplit.ts` parses hunks, tracks line numbers, pairs del/add runs),
commit ▸ push ▸ create-PR header actions whose disabled states explain themselves via
tooltip, agent-suggested commit messages ("Suggested commit message:" lines prefill with
"Use suggested"), and a `/pull-requests` skeleton page listing PRs opened this session.
The composer gained pult-local `/commit <message>` (never sent to the agent). The mock agent
on "commit" prompts modifies a tracked file (README.md) and creates an untracked one so both
diff projections are exercised; `fixtures/bin/gh.cmd` + `PULT_GH` override stand in for the
GitHub CLI in dev (gh is not installed on this machine).

**Verification.** Rust 80/80 (14 new git tests: byte-exact diff tracked-only and
with-untracked against a manual scratch-index reference, file-slices-concatenate-to-raw,
fresh-repo fallback, explicit base, status parsing, commit round-trip + typed
nothing-to-commit, push to a bare remote with upstream set + typed no-remote, worktree
create/remove round-trip with isolation check, checkpoint ref content, mock-gh pr_create
override, non-repo typed error, slugify), clippy `-D warnings` clean. Frontend
typecheck/lint green, vitest 50/50 (8 new diffSplit tests), build green. Live walkthrough in
the real window over CDP: a thread pinned to `fixtures/mock-repo` ran the mock ("please make
demo changes to commit") → the diff panel showed the tracked README modification + 2 new
files; the store's `diff.raw` was **byte-identical to `git diff`** (589 bytes, `cmp`) and the
per-file slices concatenated back to it; "Use suggested" prefilled the commit message →
Commit (`5262b5c feat: mock demo changes`, 3 files) → Push (bare remote `mock-remote.git`
received it, upstream set, badge flipped to ↑0) → Create PR (mock gh logged
`pr create --title "feat: mock demo changes" …` and the panel showed the PR URL, listed on
/pull-requests); a second thread with the worktree toggle worked in
`.pult/worktrees/please-make-demo-changes-to-comm-16` on branch `pult/…` — its README edit
stayed in the worktree while the main repo's status stayed empty, the header showed the
worktree badge, the panel showed the worktree branch; deleting the thread removed the
worktree and pruned the registration (branch kept). Checkpoint refs appeared for every
finished run including the worktree one. Split/Unified rendering and the reviewed checkbox
verified via screenshots.

**Decisions.**

1. **Scratch-index diff instead of composing untracked diffs by hand**: `git add -N` into a
   copied temp index means git itself renders every byte (new-file headers, index lines, "\ No
   newline" markers), so byte-exactness is by construction. The real index is never touched.
2. **`git diff HEAD` (with the fresh-repo fallback to plain `git diff`) as the panel's base**:
   staged+unstaged+untracked in one projection — what "what did this thread change" means;
   an explicit base is still available via the IPC.
3. **PR gating keys on `pushedSha`, not on "has unpushed work"**: pushing is not a
   prerequisite for the PR button once a push succeeded this session (a first draft disabled
   the PR button right after a successful push — caught in the walkthrough).
4. **Worktree threads keep their branch on delete** — the worktree directory and its
   registration go, but any commits/checkpoints stay reachable ("data is cheap"); the
   thread's `main_repo`/`worktree_name` columns drive cleanup.
5. **`PULT_GH` env override for the gh program** (tests + dev walkthrough) since Windows
   `Command::new("gh")` only resolves `.exe`; the mock `gh.cmd` is driven through it.
6. **`__pult` dev hook on window** exposes the stores (+threadsDelete) so CDP automation can
   assert store state and drive IPC without DOM scraping.

**Known issues / gaps (next milestones).**

- Checkpoint refs are written but invisible in the UI (checkpoints/rollback UI is out of
  scope per §8; refs are the cheap data layer).
- Diff panel highlights lines by diff kind only; Shiki code highlighting inside diff lines
  (§5 "Shiki + per-line classes") lands with the M7 polish pass.
- PR history lives in memory per session; the /pull-requests page is a skeleton (list +
  empty state) until the settings/projects suite.
- The git store resets on reload: pushedSha/lastCommit are session-scoped (the PR button
  re-arms after any successful push; a cross-restart "already pushed" projection would need
  persisted refs — M7).
- Mock's second turn starts a fresh session (no resume in that path), so turn numbering
  restarts — cosmetic in the walkthrough; real resume is covered by M2's session/load tests.
- `git_status`/`git_diff` run git subprocesses per refresh; no caching/debounce beyond the
  frontend's 600 ms — fine at fixture scale, revisit if large repos lag.

## M3 — Permissions & client callbacks (2026-11-14)

**Scope shipped.** Permission system (§5.5): `runtime/permissions.rs` with the four modes —
`supervised` always asks, `auto_edit` auto-allows edit-kind inside the workspace (rootless
POSIX paths map under the workspace; `..` anywhere or a drive path outside means "ask"),
`auto` allows everything non-destructive, `full_access` allows everything — each resolution
decided BEFORE surfacing, with `remembered` allow_always decisions (settings key
`remembered_permissions`, keyed (instance, tool class)) short-circuiting everything. Every auto
resolution writes an `ApprovalResponse { auto: true }` event (the "never silent" trace row —
the timeline renders it as a "Auto-allowed by permission mode" line) and replies to the agent
directly. Mode is chosen from a pill in the chat header (per-thread override + persisted
default). Surfaced approvals gained the mini-card pinned above the composer, keyboard answers
(`A` allow once · `S` allow always · `D` decline — the textarea is locked in "Decision needed"
so plain letters are safe), keyboard hints on the card buttons, and OS notifications when the
window is unfocused (tauri-plugin-notification behind the `EventSink.notify` seam; the focus
check lives in the AppHandle impl). Elicitation (§5.5): `elicitation/create` is surfaced —
transcript event + fan-out — and the run parks in the answer queue until the schema-driven
`ElicitationModal` (form: string/enum/number/integer/boolean/array-checkbox fields with
required validation; url mode; honest unknown-mode fallback) answers accept/decline/cancel
with typed content; the mock echoes the picked value. Terminal callbacks (§5.5):
`runtime/terminals.rs` runs `terminal/create` (sandbox-checked cwd), a combined stdout+stderr
ring buffer per terminal with char-boundary truncation and the agent's optional
`outputByteLimit`, `terminal/output` polling with `exitStatus`, detached `wait_for_exit`
(a task answers so the event stream never stalls), `kill`, `release`. fs callbacks: writes now
compute a unified diff (similar crate) with +added/-removed stats and persist a `FileChanged`
event feeding the right panel's "Files" tab (diffstat rows, expandable diff). The event log
carries `file_changed` and `elicitation_request` kinds; hydration replays both. Sidebar
threads got drag between shelves.

**Verification.** Rust 66/66 (protocol 21 incl. terminal/elicitation serde shapes · store 10 ·
runtime 18: permissions policy 8, terminals 4 incl. a real spawn/output/wait/kill round-trip,
queue 2, M2 pair, and five new M3 runtime goldens — elicitation round-trip, terminal round-trip,
auto_edit-without-UI (assert via event log, §8), reject_once round-trip, allow_always
remembered-across-turns — plus the sandbox `../` typed-error test), clippy `-D warnings` clean.
Frontend typecheck/lint green, vitest 42/42 (5 new modal tests), build green. Live walkthrough
over CDP in the real window: the elicitation modal rendered the mock's color schema (Accept
disabled until the required field was picked; the agent echoed `you picked {"color":"red"}`);
terminal callbacks echoed `mock-term-ok (exitCode:0)`; switching the pill to Auto edit made the
next turn complete with zero approval cards and one trace row in the timeline; the Files tab
listed the mock's write with a diffstat after reload. Screenshots captured in-session.

**Decisions.**

1. **Pending requests live in the run loop**, not the shared Inner: the run task owns its
   surface/answer flow; `push_answer` only validates that the run is active. A first attempt
   checked an Inner-side copy of the pending map — two sources of truth deadlocked the tests
   until it was removed.
2. **Remembered decisions key on (instance, tool class)** — the ACP ToolKind of the pending
   call, not the option kind: a first draft stored `allow_always` itself as the class, so the
   remembered lookup never matched and turn 2 hung waiting for a surfaced request.
3. **Wait-answer from a detached task**: `terminal/wait_for_exit` resolves from a spawned task
   so a hung process cannot block the event stream (§9 no blocking lanes).
4. **Rootless POSIX paths count as inside the workspace for the policy** (they remap under the
   root exactly like the fs sandbox), with any `..` component treated as an escape — matches
   how agents whose `cwd` IS the workspace send paths.
5. **`similar` crate** for the unified diffs (char-boundary truncation discipline stays
   hand-rolled in the terminal ring).

**Known issues / gaps (next milestones).**

- OS notifications are implemented but not exercised in the walkthrough (the window was
  focused); the unfocused path is untested manually.
- The terminal ring is memory-only: `terminal/output` after an app restart reports unknown —
  M5's PTY panel reattach policy will define persistence.
- Elicitation url mode currently reports accept to the agent; the in-app webview sheet is
  still to come (§5.5) — the modal shows the URL instead.
- Diff computation is per-write: consecutive writes to one file produce separate FileChanged
  events (latest wins in the Files tab) — a cumulative thread diff arrives with M4's diff panel.
- Config options are still raw passthrough (M6 pickers).

## M2 — Chat UX complete (2026-11-14)

**Scope shipped.** Streaming markdown in the timeline (`components/chat/Markdown.tsx`:
react-markdown + remark-gfm tables/task-lists + remark-math/rehype-katex, Shiki 4.6 code blocks
with a module-singleton highlighter, 150 ms streaming debounce, unknown-lang fallback, copy
button; hand-scoped `.md` CSS on the T3 tokens — no typography plugin). Composer finished:
slash-commands menu fed by `available_commands_update` (keyboard-navigable listbox, insert on
Enter/click), capability-gated image attach (`promptCapabilities.image` — paste and file picker,
chips with remove, sent as base64 `image` content blocks), queue rows rendered from the
backend-owned queue with per-row remove, queue hint states, Stop. Backend queue (migration v2):
`queue_items` table, queue-aware `runs_dispatch` → `SendOutcome`, auto-dispatch of the oldest
queued message inside `finalize_run`, `queue:update` fan-out, `runs_queue_remove`. Event
contract extended: `commands_update`, `session_info` (live thread auto-rename from the agent),
`config_options` (raw passthrough, pickers in M6), `compaction` with `compactionId` +
summary replace/append patch semantics, `RunFinished.error`. Timeline: collapsible thinking
group with duration, compaction divider, usage line on the finish divider (`used/size/cost`),
crashed-run banner with Copy diagnostics, user image chips. Persistence + reload: `threads_get`
now carries `queue` and `activeRunId`; a DB-running run the runtime no longer holds is marked
interrupted ("pult restarted while this run was active") instead of blocking the composer
forever. Resume: mock agent declares `loadSession`, replay chunks verified end-to-end;
`session/load` response parsed with a dedicated `LoadSessionResult` (no `sessionId` per schema).
Global event fan-in (`lib/runEvents.ts`): run events, new `run:started` (covers backend-created
runs from auto-dispatch), queue updates — subscribed once at the app root. Sidebar shelves got
HTML5 drag with persisted status/pinned moves.

**Verification.** Rust 47/47 (protocol 19 · events 2 · store 10 incl. queue FIFO · driver 6 ·
golden 7 incl. image round-trip · runtime 2: queue auto-dispatch + session/load resume driven
through AgentRuntime against the real mock), clippy `-D warnings` clean. Frontend typecheck/lint
green, vitest 37/37, production build ok. M2 acceptance walked through in the real window over
CDP (WebView2 remote debugging): paste chip appears only after capabilities are cached → image
sent → mock echoes `[image image/png …]` into the markdown; `/` opens the agent menu and
inserts the command; a second message queued mid-turn auto-dispatched after `run_finished`
(its own approval card appeared); webview reload rebuilt identical state including the pending
approval card and the queued row; killing the mock node process mid-turn produced the RUN
CRASHED banner with `rpc error -32603: agent process exited` and Copy diagnostics, and the
thread accepted a new message immediately (resume via session/load replayed the transcript).
Screenshots captured in-session.

**Decisions.**

1. **Backend owns the queue** (M1 kept it UI-side): FIFO sqlite table keyed by thread, instance
   bound at enqueue time, popped on `finalize_run`. UI renders `queue:update` state; cancel
   still per-row. This survives reload and keeps one writer.
2. **`run:started` event** added: the UI previously only learned of runs it dispatched itself,
   so auto-dispatched runs were invisible until the next full hydrate.
3. **Zombie-run recovery**: `ThreadDetail.activeRunId` distinguishes live runs from DB zombies;
   hydration downgrades the latter to failed with a human-readable cause. A stale approval card
   of a terminal run is cleared, so the composer never deadlocks after a restart.
4. **M1 bug found by the new runtime tests**: permission replies went back to the agent keyed
   with the internal `s`/`n` prefix (`sagent-2`) instead of the original wire id — golden tests
   missed it because their harness replied with the original `RequestId`. `pending_permissions`
   is now a `key → RequestId` map.
5. **Second M1 bug caught in the live walkthrough**: `tokio::spawn` inside a sync tauri command
   panics ("no reactor running") — `runs_dispatch` is now async so dispatch runs on the tokio
   worker. The M1 window smoke never dispatched a run, so this stayed latent.
6. **Sandbox path mapping**: rootless POSIX-absolute paths (`/repo/src/main.rs`) resolve against
   the workspace root (agents run with `cwd` = workspace); drive/UNC paths still must stay
   inside the root. The mock tolerates typed fs errors instead of crashing the turn (real-agent
   behavior).
7. **EventSink trait** replaces the raw `AppHandle` in AgentRuntime: `tauri::test` linking
   breaks Windows test binaries (STATUS_ENTRYPOINT_NOT_FOUND — test exes get no comctl32 v6
   manifest), so runtime tests use an in-memory sink; a permission "pump" answers surfaced
   requests like the UI would.
8. Shiki ships with the pure-JS regex engine (`createJavaScriptRegexEngine`) — the default WASM
   engine's `shiki/wasm` module is not installed and fails in jsdom and at runtime alike.

**Known issues / gaps (next milestones).**

- Bundle chunk >500 kB (Shiki langs + KaTeX) — code-split with the M7 perf pass if the desktop
  startup ever cares.
- Config options are stored raw and rendered nowhere until the M6 pickers.
- The mock's canned turn still hardcodes `/repo/src/main.rs`; a fresh workspace shows a
  "(read failed: …)" line — realistic fs-error surface, but a seedable fixture workspace would
  make the first turn prettier.
- tauri-specta bindings swap still deferred (the hand-typed contract grew; the seam remains
  `lib/ipc.ts`).
- Terminal callbacks still return method-not-found (M5); elicitation auto-cancels (M3).

## M1 — ACP core + mock agent (2026-11-14)

**Scope shipped.** Full ACP wire stack driven by the pinned schema: `protocol/acp-schema.json`
(v1.31.0 from agentclientprotocol releases; `acp-meta.json` beside it). Layers: NDJSON codec
(tokio-util FramedRead/Write, malformed lines logged-and-skipped, property tests: 500 seeded
round-trips + garbage interleaving), JSON-RPC 2.0 envelope with typed error codes, hand-written
serde types mirroring the schema subset (all 14 `session/update` variants, lenient inputs,
`_meta` preserved). Universal driver (`drivers/acp`): spawn/handshake/session resolution
(`session/load` when `loadSession` with graceful new-session fallback), prompt/cancel/set_mode,
id→oneshot correlation with per-method timeouts, stderr captured to tracing. Runtime: one run =
one spawned connection, event loop persisting normalized `Event`s (sqlite WAL via the store) and
fanning out to the UI (`run:event`, `thread:update`, `agent:process`), supervised permission
policy surfacing `session/request_permission` as an approval card, fs callbacks sandboxed to the
workspace root with `-32002`-style typed errors, elicitation auto-cancelled (modal lands in M3).
IPC: 13 commands wired through tauri (threads CRUD, runs dispatch/cancel/permission/queue-ack,
instances list). UI wiring: typed `AppEvent` union, pure `applyRunEvent` reducer (streaming
merge, tool lifecycle, plan, approvals, queued rows), full MessagesTimeline render path,
composer dispatch/queue/stop, instance picker, sidebar thread rows. Mock agent
(`fixtures/mock-acp-agent.mjs`, zero-dep Node) with failure modes MOCK_HANG / MOCK_CRASH_MID_TURN /
MOCK_BAD_JSON / MOCK_SLOW_TURN.

**Verification.** Rust 40/40 (protocol 19 · events 2 · store 9 · driver 4 · golden 5 · lib 2),
clippy `-D warnings` clean; frontend typecheck/lint/vitest 31/31; production build green.
Golden tests drive the REAL mock process end-to-end: happy path (thought → plan → read tool
lifecycle → fs round-trip → permission round-trip → diff → streamed echo → notice → `end_turn`),
cancel mid-turn, MOCK_BAD_JSON resilience, MOCK_CRASH_MID_TURN typed failure, MOCK_HANG killable.
**First streamed echo: 37.8ms** (§8 budget 50ms; measured from prompt-on-the-wire to first
update — process spawn excluded, see decision 1). Desktop window launches (`pnpm tauri dev`).

**Decisions.**

1. **Connection-per-run for M1** (spec says per-instance pooling): the mock is single-session;
   pooling lands with the agent matrix (M6). The 50ms echo budget is therefore measured from
   prompt-on-the-wire; with pooling the full send→echo path should fit 50ms including reuse.
2. **Schema beat the spec text twice** (§0.2 working as intended): `ToolKind` has 10 values
   (`switch_mode` added in v1.31.0), and the mock agent found five more brief-level mistakes
   (e.g. `LoadSessionResponse` carries no `sessionId`; `Diff` content is structured
   `{path, oldText?, newText}`, not a unified-diff string). Golden tests caught a real runtime
   bug: sandboxed writes to not-yet-existing directories failed until `create_dir_all` was added.
3. **serde `rename_all_fields = "camelCase"`** on every tagged enum — variant tags snake_case,
   payload fields camelCase, exactly matching the TS contract the UI builds on.
4. **tauri-specta still deferred** (now to early M2): rc.29 verified to pair with specta
   `=2.0.0-rc.28` via crates.io metadata, but the hand-typed `lib/ipc.ts` contract is already
   stable across the UI, so the binding swap is mechanical and can happen without blocking M2.
5. **TypeScript 5.9.3** carried over from M0 (typescript-eslint peer range).
6. **Queued messages are UI-side in M1** (backend ack only); the queued text auto-dispatches as a
   fresh run from the store in M2 together with composer-queue semantics.

**Known issues / gaps (next milestones).**

- Queue auto-dispatch after `run_finished` is M2 (queued rows display today, but a queued text
  waits for the user to send it).
- `available_commands_update` / `config_option_update` / `session_info_update` (auto-rename) and
  compaction summary chunks are parsed but not projected to events yet — slash menu, config
  pickers, and thread auto-rename land in M2.
- Instances registry is the built-in mock only; config.toml parsing and detection are M6.
- specta-generated bindings swap (see decision 4).

## M0.1 — T3 Code retheme + unslop UI copy (2026-11-14)

**Retheme.** Replaced the M0 palette with T3 Code's stock dark theme, extracted from their actual
source (`packages/shared/src/themePalettes.ts` → `T3_CODE_DARK_THEME_COLORS`, `apps/web/src/index.css`
dark block — reference clone kept in the draft workspace). Surfaces are now neutral true black
(#000 canvas, #0a0a0a chrome, #111 surface, #141414 raised, #1e1e1e input) with 8–14% white-alpha
borders, #f5f5f5→#818181 text hierarchy, and the stock blue accent #346bf1 (hover #3061d9) — chosen
by the user from T3's five built-in accent themes. The blue-gray _cast_ of the old surfaces is gone;
blue now lives only in the accent. Also adopted from T3: SVG fractal-noise grain on body (3.5%),
composer blur 16px + saturate(1.08) with their composer shadow, `rounded-2xl` composer, explicit
accent-hover instead of brightness filters, accent-agnostic `--mention-bg` via color-mix (ready for
the §6.6 theme picker). Icon regenerated in the new palette.

**Unslop pass.** Rewrote UI copy per the unslop core contract (two-pass, minimal repairs, strings
validated with the skill's scanners — 0 hard violations). Fixed: em-dash constructions, "no X, no Y"
cadence, synonym cycling across the shelf hints and panel empty states, "and all" tri-list, raw
enum ids shown as UI copy (permission badge now maps to Supervised / Auto edit / Auto / Full access),
and internal milestone jargon leaking into tooltips ("lands in M6", "agent matrix milestone") —
replaced with honest "Coming soon" states. Composer placeholder, aria labels, and status lines kept.

**Verification.** typecheck / eslint / prettier / vitest 7-7 green; banned-phrase and structure
scans clean; visual check via browser screenshot (true-black surfaces, blue accent only).

**Known issues.** Silhouette scan reports a missing reference fixture in the skill itself (not a
finding against the copy). Fonts stay Inter/JetBrains Mono per the pinned spec (T3 ships system
mono; not adopted — user asked for the color scheme, not the fonts).

## M0 — Skeleton & tokens (2026-11-14)

**Scope shipped.** Tauri 2 + React 19 + TypeScript (strict) skeleton; three-pane layout as real
components (Topbar / Sidebar / ChatColumn / RightPanel + ui primitives Button/Badge/Kbd); §6.2
design tokens in `src/styles/tokens.css` mapped onto Tailwind v4 via `@theme inline`; Inter
Variable + JetBrains Mono bundled (fontsource, cyrillic subsets included); frameless window with
drag region + custom minimize/restore/close controls; single-instance + window-state plugins;
tracing init (stderr); typed `app_version` command returning `Result<_, PultError>` with the
`{ code, message }` IPC error shape (§4.3); zustand stores (ui / settings / threads); TanStack
file routes (`/`→`/chat` redirect, `/chat`, `/thread/$threadId`, `/welcome`); vitest suite;
GitHub Actions CI workflow.

**Verification.**

- `pnpm typecheck` (tsc -b, strict) ✅
- `pnpm lint` (eslint flat + prettier check) ✅
- `pnpm test` — 7/7 vitest ✅
- `cargo clippy -- -D warnings` ✅
- `cargo test` — 2/2 ✅
- `pnpm build` (tsc + vite production bundle) ✅
- `pnpm dev` serves in a plain browser (isTauri() guards) ✅; UI visually reviewed via
  screenshot against §6 (three panes, tokens, empty states).
- `pnpm tauri dev` on Windows ✅ (window runs; MSVC toolchain links).

**Decisions.**

1. **TypeScript pinned to 5.9.3**, not 7.x: typescript-eslint 8.72 peers `typescript <6.1`; the
   native TS 7 compiler is not yet supported by the lint stack. Revisit when typescript-eslint
   ships TS 7 support.
2. **tauri-specta deferred to M1.** The exact tauri/specta rc pairing must be verified against
   upstream docs at build time (§0 "never invent"); M0 proves the IPC bridge with a plain typed
   command instead. The generated-bindings seam (`src/lib/ipc.ts`) is marked for replacement.
3. **Icons** generated from `scripts/gen-icon.mjs` (pure-Node PNG writer, placeholder mark:
   sliders on dark rounded square) → `pnpm tauri icon`. Replace with real brand art before M8.
4. **Frameless window controls are client-side** (`@tauri-apps/api/window`), guarded by
   `isTauri()` so `pnpm dev` in a plain browser also renders. Drag region via
   `data-tauri-drag-region`; capabilities grant the needed `core:window:*` permissions.
5. **pnpm-workspace.yaml** holds `onlyBuiltDependencies` (esbuild, @tailwindcss/oxide) — the
   pnpm ≥10 location for that setting; single-package workspace.

**Deviations from the spec.** None material. Additions only: pnpm-workspace.yaml (tooling),
placeholder icon set (brand art is an M8 concern).

**Known issues.**

- `window-state` plugin will restore size/position from second launch onwards; first launch is
  centered 1440×900 per config.
- Route-aware breadcrumbs land in M2 (topbar shows static "pult / chat").
- Rust file logs (`~/.pult/logs`) arrive with M1's store work; tracing currently goes to stderr.
