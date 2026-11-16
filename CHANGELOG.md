# Changelog

All notable changes to pult. Format follows [Keep a Changelog](https://keepachangelog.com);
versions are milestone snapshots of the 0.1.0 development line (unreleased).

## [0.1.0] — milestone line

### UI polish, native browser, i18n and open-source prep (2026-11-17)

- **Native browser:** the preview surface is now a Tauri child `Webview` instead of a
  sandboxed iframe. Any http(s) site renders regardless of `X-Frame-Options`/CSP, and local
  HTML/JS/CSS assets are served from a token-scoped `127.0.0.1` server with canonical path
  checks, so ES modules and relative imports work. The child HWND is hidden whenever a
  modal, the palette or another surface owns the screen.
- **Chrome:** sidebar toggle moved left of the logo (T3-style), app name capitalized to
  “Pult”; header/sidebar/footer separator lines removed; middle header action got a page
  icon; header toggles no longer shift when the right panel opens; footer refresh pinned
  right; the thread `…` menu removed (pin stays, destructive actions live in the context
  menu); thread title matches project-name size with a hover-only rename pencil.
- **Sidebar:** search is borderless and matches project names as well as thread titles;
  “No project” icon aligns with project badges.
- **Composer:** permission pill is flat (no surface); workspace radios in project dialogs
  are app-styled; keybindings render `Kbd + Kbd` with visible `+`.
- **Timeline:** every consecutive tool/thought/trace run now lives in one smart activity
  row that auto-expands while the agent works, folds away on completion and labels the
  current action (“Reading file”, “Running command”, …). Expanded details show numbered
  read excerpts, command output and an **Open diff** action; a slow glow sweeps the active
  label. Completed sub-second “Thought for 0s” rows are suppressed and the live timer
  switches to minutes.
- **Composer:** queued messages attach to the input as a narrower rounded cap (the
  “Keep typing…” hint is gone); the card gets inner-shadow depth, Send/Queue/Stop a soft
  gradient, and Stop a filled square. Full access is tinted orange in the pill and menu.
  The `…` overflow is gone: session modes and agent options move into the provider/model
  popover, and a provider fast-mode option becomes a lightning toggle.
- **Welcome:** the living ASCII backdrop leaves a fading trail behind the pointer, breathes
  slowly while idle, and a click blooms gradually instead of drawing an instant disk.
- **Queue & activity:** queued messages form one glass cap above the composer with equal
  padding, physical pointer drag and composer-based editing that restores the draft.
  Activity rows stay collapsed by default and merge action + elapsed time into one label
  (`Running command · 12s`); the shimmer loops without a jump.
- **Details:** long sidebar names fade out on the right instead of an ellipsis; the project
  widget header opens Explorer; the app icon mark is slightly smaller inside its tile.
  Screenshots the agent writes outside the workspace render in Full access.
- **Updates:** the sidebar footer checks Pult itself through GitHub Releases: a badge when
  an update exists, a determinate download ring, silent install and automatic restart.
- **Backdrop:** ASCII glyphs rest in neutral gray (independent of the theme) at slightly
  lower brightness; pointer trails and click blooms take the theme color, white on Graphite.
- **Profile & onboarding:** a local profile card (avatar/initials, nickname, @handle,
  accent) lives in Settings, and a clean install walks through a four-step wizard:
  agent constellation, provider connection, git/browser/terminal tour, profile creation.
- **Notifications:** background run completion/error shows a native notification with a
  soft synthesized chime; both are switchable in Settings → Chat.
- **Plugins:** `~/.pult/plugins` manifests are discovered and can be enabled; the current
  milestone is declarative only (commands/slots metadata, no code execution).
- **Shortcuts & status:** B/T/F/D/P open right-panel surfaces; working threads show an
  ASCII spinner on the right, finished unread ones a theme dot.
- **i18n:** zero-dependency typed catalogs, language picker (English default, Russian,
  German, Spanish, Japanese, Chinese, French), persisted per install, `Intl` date/number
  formatting and localized IPC error codes.
- **Open source:** MIT `LICENSE`, `CONTRIBUTING.md`, `SECURITY.md`, issue/PR templates,
  hardened CI and `.gitignore`; dead `ProjectCard`/`badge` and the duplicate root SVG
  removed.

### Connection fixes — OpenCode/Codex and Antigravity (2026-11-14)

- `session/new` / `session/load` always send the schema-required `mcpServers` array;
  fixes `-32602 Invalid params` from OpenCode 2.3.0 and Codex ACP 2.6.0.
- Google Antigravity detected through its standalone `agy_acp_server.exe`; official
  zip verified by sha256, cold-start initialize timeout 60 s; OAuth sign-in verified live.

### M12 — Usage insights (2026-11-14)

- `/usage`: last valid ACP usage snapshot per run, KPIs for context at run end and latest
  reported cost (never summed), Runs/Threads/Providers slices, provider filter, empty/error states.
- `Store::usage_report` over existing tables (no migrations), `usage_report` IPC via
  `spawn_blocking`, corrupt/legacy payloads skipped.
- Navigation: breadcrumb, palette command, sidebar entry with active state.
- Antigravity detection intentionally out of scope (no verifiable invocation).

### M11 — ACP sign-in flow (2026-11-14)

- Typed auth methods (terminal args/env), `AcpConn::authenticate`, and strict `-32000`
  auth-required classification (no false Needs sign-in on start/RPC errors).
- `AgentRuntime::authenticate`: spawn → initialize → authenticate → fresh session probe →
  kill; cached methods/status survive navigation; terminal methods are rejected over RPC.
- Providers and onboarding share Sign-in actions: agent buttons, copyable terminal command
  with Re-check, honest fallback; Re-check refreshes the cached badge.
- Mock agent reproduces auth-required, success, still-required, failure and terminal scenarios.

### M10 — Typed config options & composer pickers (2026-11-14)

- ACP `configOptions` typed end to end: select (flat/grouped) and boolean, lenient
  deserialization for old DB rows, boolean capability advertised, `session/set_config_option`.
- Composer pills for model and thought level (group headers), boolean toggles; picks persist
  per thread, apply before the next prompt (model first), fill `RunRecord.model`/`.effort`,
  and never fail a turn when the agent rejects a stale value.
- Preflight caches session config options; Providers/Diagnostics show them; `/chat` picks
  apply once and are cleared; Esc closes a picker without stopping the run.
- Mock agent serves model/thought/toggle options and validates `set_config_option`.

### M9 — Chat, thread lifecycle & navigation integrity (2026-11-14)

- Thread hydration keeps live runs alive: `activeRunId`/`desiredMode` travel with
  `threads_get`, events are deduped by id, stale snapshots cannot resurrect finished runs.
- Composer: Esc stops the run only when no layer owns it; slash picks keep their `/`;
  approval offers once/always/reject; decisions lock the textarea; `@` lists workspace files.
- Session mode persists per thread (settings KV), applies before the next prompt, never
  leaks from `/chat` into another thread, and survives restarts.
- Threads: rename, pin, snooze, settle, delete (two-step, worktree hint) in the header;
  deleting a live thread cancels its run and cleans store/runtime state.
- Navigation: route-aware breadcrumbs, honest workspace entry, terminal label with shell
  and folder; external http(s) links open in the system browser from PR/elicitation.
- Vitest now runs `*.test.tsx` suites (three had been silently skipped).

### UX pass — composer-driven controls, one-click agents, resizable panes (2026-11-14)

- Composer control bar (§6.1): agent instance ▸ session mode ▸ permission pill moved into
  the composer where the decision happens; the header keeps thread identity only. Status
  line shows the run target (workspace path · git branch); attach became a "+" like the
  reference apps; a progress hairline travels the composer's top edge while a turn runs
  (reduced-motion aware).
- One-click agents: detection now covers Codex (official `@agentclientprotocol/codex-acp`
  bridge — handshake verified live) and OpenCode (native `opencode acp`), each with a
  prefilled command. "Connect" in Providers/onboarding adds the instance AND verifies the
  handshake immediately (spawn → initialize → caps → shutdown, no prompt, no cost),
  reporting Connected / needs sign-in / error on the row. Fixed the onboarding bug where
  adding an agent wiped the rest of the instance list.
- Resizable panes (§6.1): drag the sidebar's or right panel's edge (220–480 / 300–720 px),
  keyboard-adjustable via a proper `separator` role, widths persist across restarts.
- Settings: a real gear button in the topbar + `Ctrl+,` hotkey (rebindable); settings.open
  joined the palette registry.
- Brand icon: real prompt-glyph mark (chevron + caret) replaces the placeholder sliders.
- Boot hygiene: threads stuck in `working`/`waiting` by a previous shutdown reset to drafts
  (no dead spinners after a crash).

### M8 — Distribution (2026-11-14)

- Bundler config per OS: `bundle.targets: "all"` (NSIS installer on Windows, dmg on macOS,
  deb/AppImage on Linux), `createUpdaterArtifacts` for signed update bundles.
- Updater plugin wired (`tauri-plugin-updater`, capability `updater:default`) with placeholder
  endpoint + pubkey — inert until configured; signing/endpoint procedure documented in README.
- README rewritten with real screenshots (docs/screenshots), config reference, keyboard map,
  build/distribution and macOS first-run notes; CHANGELOG introduced.
- Versioning: 0.1.0 dev line, one DEVLOG entry per milestone.

### M7 — Polish (2026-11-14)

- Themes: Light + Graphite as token-block overrides; WCAG ≥ 4.5:1 contrast suite; accent hue
  picker regenerating accent/mention/monogram tokens via HSL; appearance persists across
  restarts (settings_get/set IPC over the §4.5 settings table).
- Command palette (⌘K) over a single command registry; rebindable keybindings page with
  capture/reset; sidebar search + "Add project…" wired.
- Error states with designed recovery: agent-crash banner (real `crashed` process event),
  storage banner, run-crash card with "Retry last message", route-level error card.
- FPS overlay behind `?fps=1`; 300-item transcript window with chunked history expansion.
- Playwright smoke suite (5 specs) in system Edge against the vite server.
- Fixes: bare-modifier keybinding capture, case-sensitive hotkey matching, missing mid-run
  `crashed` event.

### M6 — Agent matrix, modes, diagnostics (2026-11-14)

- `~/.pult/config.toml` instances (mock/acp drivers, per-instance env) with whole-table
  TOML patch saves; PATH detection wizard (claude/gemini/codex/dsh); providers settings page.
- Session modes: header picker from cached caps, `runs_set_mode` to the live connection,
  mid-run label flip via the agent's `current_mode_update` echo.
- Diagnostics page: caps, process-event ring, last 60 raw protocol frames per live session.
- Fixes: sync-command tokio abort (set_mode/cancel), diagnostics page render loop.

### M5 — Terminals (2026-11-14)

- Real ConPTY per thread (portable-pty) streamed to xterm.js with fit/resize, copy/paste,
  backfill ring; agent terminal mirror; restart policy documented; TUI acceptance
  (`fixtures/tui-demo.mjs`) verified live.
- ConPTY CPR handshake answered by the real terminal, never forged in the backend.

### M4 — Git, diffs, one-click PR (2026-11-14)

- Byte-exact scratch-index diff (untracked included, user index untouched), porcelainless
  status with branch/ahead/behind, commit/push (upstream detection), `gh pr create` with
  typed failure codes, per-thread isolated worktrees, hidden checkpoint refs per run
  (`refs/pult/checkpoints/<runId>`).
- Diff panel: branch pill, diffstat, split/unified toggle, per-file reviewed checkboxes,
  Commit ▸ Push ▸ Create PR with disable-state tooltips; mock `gh` fixtures for testing.

### M3 — Permissions & client callbacks (2026-11-14)

- Four permission modes with auto-resolve before surfacing; approval cards with keyboard
  answers; remembered decisions; elicitation forms; sandboxed fs read/write callbacks;
  terminal callbacks; auto-edit flows; trace rows for silent resolutions.

### M2 — Chat UX complete (2026-11-14)

- Streaming timeline (markdown, tables, code), thoughts, plan cards, tool rows expandable to
  raw I/O, usage banner, queue-while-running, message queue UI, @file mentions, slash
  commands from `available_commands_update`, image attach when caps allow.

### M1 — ACP core + mock agent (2026-11-14)

- Pinned ACP JSON schema as the authoritative contract; NDJSON codec with id correlation;
  ACP driver spawn/handshake; runtime orchestration (runs, queue, resume); sqlite store with
  migrations and append-only events; golden transcript tests over all 14 session-update
  variants + failure modes (MOCK_BAD_JSON, MOCK_CRASH_MID_TURN, MOCK_HANG).

### M0 — Skeleton & tokens (2026-11-14)

- Tauri 2 + React 19 (TS strict) three-pane shell, T3 Code-matched token set with SVG grain,
  frameless window chrome, bundled Inter/JetBrains Mono, icon set, CI gates.
