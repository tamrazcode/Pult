# Pult

**A local-first Agent Development Environment.** One desktop workspace for the coding
agents already on your computer — Codex, Claude Code, opencode, Antigravity and anything
else that speaks the Agent Client Protocol (ACP).

Bring your own subscription. Pult is not an agent, stores no API keys, and keeps chats in
a local SQLite database.

## Download

Install the latest Windows build from
[GitHub Releases](https://github.com/tamrazcode/Pult/releases/latest):

`pult_<version>_x64-setup.exe` (NSIS)

A clean install opens a four-step onboarding: detect agents, connect the ones you want,
tour git/worktrees + browser + terminal, then create a local profile.

## Features

- **Agents over ACP** — add any ACP CLI as `command + args`; run agents side by side and
  keep each thread's session alive.
- **Streaming chat** — thoughts, tool calls, plans, diffs and approvals. Consecutive
  tools fold into one smart activity row with the current action and elapsed time;
  expanding shows readable file excerpts, commands and diffs.
- **Git built in** — live per-thread diff, per-file review, commit → push → PR, isolated
  worktrees and hidden checkpoints per run.
- **Real terminal** — ConPTY per thread (xterm.js), plus terminals the agent opens.
- **Built-in browser** — a native child webview: any site opens regardless of
  `X-Frame-Options`/CSP, and local HTML/JS/CSS works from a token-scoped loopback server.
- **Queue & steering** — keep typing while an agent runs; queued messages can be edited
  in the composer, reordered by dragging, or sent immediately with Steer.
- **Seven languages**, light/dark/graphite themes, a living ASCII backdrop, and an
  unmistakable orange Full access mode.
- **Local profile & plugins** — a customizable profile card and a declarative plugin
  folder (`~/.pult/plugins`).
- **Background notifications** — native toast + soft chime when a run ends while Pult is
  in the background.
- **Background commands** — agents can run long builds/tests with `run_background` and
  end their turn; Pult wakes the thread with the exit status and output tail.
- **Self-sufficient providers** — one click installs the CLI into Pult's own folder and
  downloads a portable Node when the machine has none; npm errors are readable.
- **GitHub updates** — checks Releases in the background, downloads with a progress ring,
  installs silently and restarts.

## Build from source

Prerequisites: Node 22+, pnpm 10+, Rust stable, and the Tauri system dependencies for your
OS.

```sh
pnpm install
pnpm tauri dev      # desktop app
pnpm dev            # UI only in a browser (no IPC bridge)
```

## Configuration

`~/.pult/config.toml` is the agent matrix:

```toml
[[instances]]
id = "codex"
display_name = "Codex"
driver = "codex-acp"
command = "codex-acp"
args = []
enabled = true
```

Runtime data stays outside the app bundle:

```
~/.pult/pult.db      chats, runs, settings, local profile
~/.pult/plugins/     declarative plugins
~/.pult/config.toml  provider instances
```

## Updates

Pult checks GitHub Releases shortly after launch and every six hours. The footer button
checks on demand; an available update shows a badge, then installs silently and restarts.
Release artifacts are signed with the Tauri updater key.

## License

MIT — see [LICENSE](LICENSE).
