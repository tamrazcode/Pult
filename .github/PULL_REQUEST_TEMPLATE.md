## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## How to verify

<!-- Commands you ran and the result. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml --lib`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

## Screenshots / recordings

<!-- For UI changes, before/after in dark and light themes if possible. -->

## Checklist

- [ ] Tests cover the behavior change
- [ ] UI copy goes through `src/lib/i18n/locales` (English source, all locales in sync)
- [ ] No secrets, local databases, `outputs/` or `docs/reviews/` added
