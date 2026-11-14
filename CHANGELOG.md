# Changelog

All notable changes to pult. Format follows [Keep a Changelog](https://keepachangelog.com);
versions are milestone snapshots of the 0.1.0 development line (unreleased).

## [0.1.0] — milestone line

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
