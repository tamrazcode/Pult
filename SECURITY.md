# Security policy

## Reporting

Please do not open a public issue for a vulnerability. Use the repository's
**Security → Report a vulnerability** (GitHub Security Advisories) flow, or
contact the maintainer privately. Include the version, OS, reproduction steps,
and the impact you expect. We will acknowledge within a few days.

## Threat model

Pult is a local-first desktop app that runs agent CLIs **as your user**. It is
not a sandbox for those processes.

- Agents and their tools inherit the user's file, network and process rights.
  Permission modes decide what pult asks about, not what the OS allows.
- The UI renders agent output as Markdown/data URLs; raw HTML is never injected
  into the app webview.
- The built-in browser is a native child webview. Local files are served only
  through a loopback server bound to `127.0.0.1` on a random port; every URL
  carries a 128-bit token and canonical path checks reject traversal.
- Workspace file and terminal callbacks are constrained to the thread workspace;
  UNC/network paths are refused.
- `~/.pult/config.toml` holds provider commands (no API keys by design) and is
  written atomically. `~/.pult/pult.db` holds transcripts; treat it as private.

## Supported versions

Security fixes land on `main`. Release builds are produced from tagged commits.
