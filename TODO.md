# pult — что ещё не сделано

Обновлено 2026-11-16. Текущие автоматические проверки (Windows): `pnpm typecheck`, `pnpm lint`,
`pnpm test` (vitest), `cargo test`, `cargo clippy --all-targets -- -D warnings`,
`pnpm tauri build --no-bundle` — зелёные, кроме известного флейка окружения в ConPTY-тесте
(`runtime::ptys::tests::pty_round_trip_output_exit_and_input_write`).

## Релизные блокиеры

- [ ] **Подпись Windows** (Authenticode): NSIS-инсталлятор пока без подписи, SmartScreen предупреждает.
- [ ] **Updater endpoint**: сейчас заглушка `releases.pult.local` в `src-tauri/tauri.conf.json`.
      Нужен реальный HTTPS-хостинг + приватный ключ подписи в CI.
- [ ] **macOS / Linux**: сборки не проверялись; нужны dmg + notarization и deb/AppImage.
- [ ] **Реальная приёмка агентов**: вход, запрос с tool call, отказ/разрешение, картинки,
      stop, restart/resume, смена модели, два параллельных чата — с реальными подписочными
      аккаунтами. Матрица и колонка `Last verified` — в README.

## Проверить руками (автотесты это не доказывают)

- [ ] Новая строка активности: авто-раскрытие во время работы, авто-сворачивание после, детали read/execute/edit, свечение; на реальном агенте с длинным tool-потоком.
- [ ] Fast mode: молния появляется только у провайдера с boolean-опцией, где id/name содержит `fast`; проверить фактический id опции Codex.
- [ ] ASCII-фон: шлейф за мышью, медленный пульс в покое, постепенная вспышка по клику.

- [ ] Тёмная/светлая/Graphite/Liquid темы на 1040×680 и 1440×900, масштаб текста 125%+.
- [ ] Screen reader (Windows Narrator/NVDA): ApprovalCard, диалог удаления, Settings.
- [ ] Кэш иконки Windows Explorer после смены `.ico` (может держаться до перезапуска Explorer).

## Технический долг

- [ ] `PRODUCT.md` / `DESIGN.md` отсутствуют: зафиксировать токены, компоненты и состояния.
- [ ] Скрипты проектов хранятся в localStorage, а не в SQLite (осознанный shortcut).
- [ ] Встроенный браузер: нативный child webview работает, но страницы с `target=_blank` и
      скачивания пока не перехватываются; нужен `on_new_window`/download handler, если понадобится.
- [ ] История чата грузится целиком: добавлена бюджетная обрезка IPC (16 МБ) и one-pass
      `hydrateThread`, но постраничная загрузка появится после измерения на реальных объёмах.
- [ ] Проверить и при необходимости ускорить ConPTY-тест (флейк на медленной машине).

## Публикация на GitHub (open source)

- [ ] Создать репозиторий (без README/LICENSE), добавить remote и запушить `main`.
- [ ] Заполнить `repository`/`homepage`/`bugs` в `package.json` и `Cargo.toml` реальным URL.
- [ ] Включить Issues, branch protection для `main`, Dependabot.
- [ ] Секреты репозитория: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`;
      заменить `releases.pult.local` на реальный HTTPS-endpoint апдейтера.
- [ ] Windows Authenticode + macOS `codesign`/`notarytool` для релизных артефактов.
- [ ] Тег `v0.1.0` и GitHub Release с NSIS/dmg/AppImage + `.sig`.
- [ ] Проверить, что в истории нет `pult.db`, `outputs/`, `docs/reviews/`, ключей (уже в `.gitignore`).

## Отклонено осознанно

- OS-sandbox для агентских CLI: агенты — локальные процессы с правами пользователя; обещать
  sandbox нельзя. Ограничение — по проекту/режиму/типу инструмента.
- Автовоспроизведение старого транскрипта в новую сессию при сбое `session/load`: вместо этого
  показывается сохранённое предупреждение о сбросе контекста.
