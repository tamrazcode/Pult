# Contributing to Pult

Thanks for helping. Pult is a local-first desktop Agent Development Environment:
Tauri 2 (Rust) + React 19 + Zustand + TanStack Router + Tailwind CSS v4.

## Prerequisites

- Node.js 22+ and pnpm 10
- Rust stable (edition 2021) and the Tauri 2 prerequisites for your OS
- Windows: WebView2 runtime (ships with Windows 11)
- Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
- macOS: Xcode command line tools

## Run and verify

```sh
pnpm install
pnpm tauri dev        # full desktop app
pnpm dev              # UI only (no IPC; browser surfaces show fallbacks)

pnpm typecheck
pnpm lint             # eslint + prettier --check
pnpm test             # vitest
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm tauri build --no-bundle
pnpm exec playwright test   # browser smoke (no Tauri IPC)
```

## Architecture

- `src/` — React UI, stores, i18n catalogs (`src/lib/i18n/locales`), components.
- `src-tauri/src/protocol/` — ACP JSON-RPC types and framing.
- `src-tauri/src/drivers/` — agent drivers (ACP stdio, mock, golden tests).
- `src-tauri/src/runtime/` — sessions, queue, permissions, terminals, PTYs.
- `src-tauri/src/store/` — SQLite (append-only events, WAL, migrations).
- `src-tauri/src/git/` — diff, checkpoints, worktrees, push/PR.
- `src-tauri/src/ipc/` — Tauri commands (the only UI boundary).
- `src-tauri/src/browser/` — native child webview + token-scoped local server.
- `protocol/` — pinned ACP schema (do not edit by hand).
- `fixtures/` — mock ACP agent and git fixtures used by tests.

## Pull requests

- Keep the change focused; do not mix refactors with behavior changes.
- Add or update tests for every behavior change.
- UI copy goes through the i18n catalogs; English is the source of truth and
  every locale must keep the same keys.
- Never commit secrets, `~/.pult/pult.db`, `outputs/`, or `docs/reviews/`.
- Run the verification commands above and paste the results in the PR.

By contributing you agree that your changes are licensed under the MIT license
in [LICENSE](LICENSE).
