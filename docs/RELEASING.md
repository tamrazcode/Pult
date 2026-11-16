# Releasing Pult

## What goes into the installer

The NSIS bundle contains only the compiled app and its web assets. User data is
never packaged: the SQLite store, workspaces, chats, screenshots, outputs and
keys live outside the bundle (for example `~/.pult/pult.db`). A clean install
therefore starts with an empty database and the onboarding wizard.

## One-time GitHub setup

1. Create the repository and push `main`.
2. Fill `repository`, `homepage` and `bugs` in `package.json` / `Cargo.toml`.
3. Generate the updater key **once** and keep the private key out of git:

   ```powershell
   pnpm tauri signer generate -w $HOME/.tauri/pult.key
   ```

   Put the printed public key into `src-tauri/tauri.conf.json` →
   `plugins.updater.pubkey`. The private key and its password go into GitHub
   Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`,
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).

4. Replace `OWNER` in the updater endpoint with the real GitHub owner:

   ```
   https://github.com/OWNER/pult/releases/latest/download/latest.json
   ```

## Build a Windows installer

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$HOME\.tauri\pult.key" -Raw
pnpm tauri build --bundles nsis
```

Artifacts land in `src-tauri/target/release/bundle/nsis/` plus the generated
`.sig`. Upload the setup `.exe`, its `.sig`, and `latest.json` to a GitHub
Release. `latest.json` must list the platform entry:

```json
{
  "version": "0.1.1",
  "notes": "What changed",
  "pub_date": "2026-11-16T12:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "url": "https://github.com/OWNER/pult/releases/download/v0.1.1/pult_0.1.1_x64-setup.exe",
      "signature": "<contents of the .sig>"
    }
  }
}
```

## Verify

1. Install on a clean Windows machine or VM.
2. First launch shows the onboarding wizard and creates a fresh
   `~/.pult/pult.db`.
3. Bump the version, publish a release, and press the footer update button in an
   older build: it should show the badge, download with a progress ring, install
   silently and restart.

## Checks before tagging

```powershell
pnpm typecheck
pnpm lint
pnpm test
cargo test --lib --manifest-path src-tauri/Cargo.toml
cargo clippy --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings
pnpm exec playwright test
```
