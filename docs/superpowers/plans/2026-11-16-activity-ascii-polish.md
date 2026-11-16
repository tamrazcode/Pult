# План: умная строка активности, живой ASCII-фон и доводка композера (2026-11-16)

## Контекст

Пользователь просит:

1. Убрать бегущую полоску сверху композера. **Сделано** (`Composer.tsx`, `index.css`).
2. Красная кнопка стоп: заливной белый скруглённый квадрат по центру. **В работе.**
3. Заметнее градиент у Send / Queue / Stop. **В работе.**
4. Очередь сообщений приклеена к композеру, без подписи «Keep typing…», уже окна ввода. **Сделано** (`Composer.tsx`).
5. Внутренние тени-объём у карточки композера. **Сделано** (`tokens.css`, `light.css`, `Composer.tsx`).
6. Все tool/thought/trace строки свернуть в одну умную строку Thinking/Working; авто-раскрытие во время работы и авто-сворачивание после; короткие умные подписи; подробное раскрытие в стиле T3 (файл + строки + код, команда + вывод, Open diff); медленное плавное свечение по тексту строки.
7. ASCII-фон на пустом чате: живой шлейф за мышью, медленное неровное пульсирование в покое, клик — постепенная неровная вспышка вместо мгновенного большого круга.

## Инварианты

- Без новых npm/Rust зависимостей.
- 7 локалей (en, ru, de, es, fr, ja, zh) в паритете, `{{placeholders}}` сохраняются.
- `prefers-reduced-motion` отключает анимации (свечение, шлейф, пульс).
- Существующие проверки: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test --lib`, `cargo clippy -D warnings`, Playwright, release build.
- Таймлайн: assistant/user/notice/compaction остаются отдельными; группируются только подряд идущие tool/thought/trace.

## T01 — Композер: стоп и градиент

- [ ] `Composer.tsx`: заменить `<Square />` на заливной белый скруглённый квадрат (`span` 10×10, `rounded-[2px]`, `bg-white`), по центру круга.
- [ ] Усилить градиент: `from-white/35 via-white/10 to-black/15` (плюс мягкий верхний внутренний блик) для Send, Queue, Stop; disabled Send/Queue — без градиента.
- [ ] Тест: кнопка Stop содержит заливной индикатор; градиентные классы присутствуют на всех вариантах.
- [ ] Проверка: `pnpm test tests/composer.test.tsx`.

## T02 — ASCII-фон: шлейф, покой, клик

Файлы: `src/lib/asciiWave.ts`, `src/components/chat/LivingAscii.tsx`, `tests/ascii-wave.test.ts`.

- [ ] `asciiWave.ts`:
  - `rippleValue`: медленный неровный пульс — сумма двух синусов с несоизмеримыми частотами (период ~3.5–5 с), без резких колец.
  - Новый `trailValue(x, y, point, now)`: мягкое затухающее пятно от точки шлейфа (age ~600–900 мс, радиус ~40–60 px).
  - `pulseValue`: плавный bloom — сила нарастает ~600 мс, radius растёт с 6 px, жизнь ~2.6 с, лёгкая угловая неровность; в момент 0 вклад = 0 (никакого мгновенного диска).
  - `cellBrightness` принимает `trail: Ripple[]` и учитывает его.
- [ ] `LivingAscii.tsx`:
  - `trailRef`: точки указателя (не чаще ~35 мс / 6 px, максимум 16), затухают ~800 мс.
  - `pointerRef` остаётся для медленного пульса в покое; на `pointerleave` пульс гаснет, шлейф доигрывает.
  - Клик добавляет `pulse` со strength ~0.9; расчёт только в bounding box точки (быстрый отсев по квадрату расстояния).
- [ ] Тесты: `pulseValue` в 0 мс ≈ 0, максимум позже, ноль после ~2.6 с; `trailValue` спадает с возрастом и расстоянием; `rippleValue` меняется медленно.
- [ ] Проверка: `pnpm test tests/ascii-wave.test.ts`.

## T03 — Извлечение деталей инструментов

Новый `src/lib/toolDetails.ts` (чистые функции) + `tests/tool-details.test.ts`.

- [ ] `toolPath(item)`: `locations[0]` → `rawInput` (`path`, `file_path`, `filePath`, `target_file`, `filename`) → путь из title.
- [ ] `toolLineRange(item)`: `rawInput` (`offset`+`limit`, `start_line`+`end_line`, `line`) → `{ start, end }`; fallback — regex `lines? (\d+)(?:-(\d+))?` из title/вывода.
- [ ] `toolCommand(item)`, `toolQuery(item)`: `command|cmd|script`, `query|pattern|regex|q`; fallback title.
- [ ] `toolOutputText(item)`: `rawOutput`/`content` через `readableToolValue`, срезать служебные `^\s*\d+[→\t]` префиксы.
- [ ] `numberedExcerpt(text, start, maxLines=40)`: массив `{ n, text }`, обрезка и признак `truncated`.
- [ ] Тесты на все экстракторы и нумерацию.

## T04 — Умная строка активности

Файл: `src/components/chat/MessagesTimeline.tsx`.

- [ ] `TimelineRows`: группа из **1+** подряд идущих tool/thought/trace рендерится одним `ActionGroupRow`; 0s-thought по-прежнему отфильтрованы.
- [ ] `ActionGroupRow`:
  - `active` = streaming thought или tool pending/in_progress.
  - `open` стартует как `active`; при смене `active` авто-открытие/закрытие; ручной toggle сохраняется до следующей смены.
  - активная подпись по kind: thought → `Thinking · Ns`; read → «Reading file»; edit/write/move/delete → «Editing file»; execute → «Running command»; search → «Searching files»; fetch → «Fetching»; иначе → `Working` / title.
  - завершённая: одиночная мысль → `Thought for Ns`, иначе `summarizeActionGroup`.
  - слева: ASCII-спиннер при active, иначе иконка; подпись с классом свечения при active.
  - раскрытие: хронологический список деталей без вложенных кнопок-аккордеонов.
- [ ] `ActionDetail` (внутри файла или отдельный компонент):
  - read: заголовок «Read <path>», диапазон строк, нумерованный `<pre>` (до 40 строк), `+N more lines`.
  - edit/write/delete/move: путь + кнопка «Open diff» (открывает правую панель на вкладке diff); вывод, если есть.
  - execute: `$ command` + stdout/stderr.
  - search: запрос + результаты.
  - thought: текст мысли.
  - fallback: title + читаемый вывод; маленький Raw-toggle на случай сырых данных.
  - изображения из payload сохранить.
- [ ] Убрать отдельный `ToolRow`/`ThoughtGroup` из основного потока (оставить только внутри раскрытия).
- [ ] Тесты: одиночный tool сворачивается; активная группа авто-раскрыта и показывает детали; после завершения авто-свернута; подписи по kind; read-экспонат с номерами строк; edit показывает Open diff; мысль видна в раскрытии; Raw скрыт по умолчанию.
- [ ] Обновить существующие тесты, которые ждут отдельных строк/ручных аккордеонов.

## T05 — i18n

- [ ] Добавить ключи (en): `chat.action.reading`, `editing`, `running`, `searching`, `fetching`, `readFile`, `editedFile`, `openDiff`, `moreLines`, `command`, `output`.
- [ ] Перевести на ru/de/es/fr/ja/zh; паритет и плейсхолдеры проверить `tests/i18n.test.ts`.

## T06 — Свечение

- [ ] `src/styles/index.css`: `.activity-shimmer` — градиент `text-tertiary → text-primary/accent → text-tertiary`, `background-size: 220%`, `background-clip: text`, медленная анимация 4–6 с, `ease-in-out`; `prefers-reduced-motion` → без анимации и прозрачности.
- [ ] Применять только к подписи активной строки.

## T07 — Гейты и ревью

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test --lib`, `cargo clippy --all-targets -D warnings`.
- [ ] Playwright.
- [ ] Gemini review дельты; исправить Critical/Important.
- [ ] Release build + перезапуск приложения.
- [ ] Обновить TODO/CHANGELOG одной строкой.

## T08 — Full access: оранжевый акцент

- [ ] `ComposerControls.tsx` ModePill: при `permissionMode === "full_access"` иконка, текст и стрелка — `text-warning`; в меню выбранная строка получает `bg-warning/10`, оранжевый заголовок и галочку.
- [ ] Тест: Full access даёт warning-классы на пилюле и выбранной строке.

## T09 — Убрать «…», перенести Options в пикер провайдера

- [ ] Удалить `ComposerOverflowMenu` и кнопку `MoreHorizontal` из `Composer.tsx`.
- [ ] В `ProviderModelPicker` добавить секции `AgentModePicker` и `ConfigOptionPickers` (без model/reasoning) — туда переезжают Collaboration mode, Fast mode и прочие опции агента.
- [ ] Fast mode: если у выбранного провайдера есть boolean-опция с `fast` в id/name, показывать рядом с пикером кнопку-молнию (`Zap`), tooltip `composer.fastMode`; клик переключает опцию, включённая — акцентная. Если опции нет — кнопки нет.
- [ ] i18n: `composer.fastMode` (и подпись секции `composer.options`, если нужна).
- [ ] Тесты: «…» больше нет; опции видны в пикере; молния появляется только при fast-опции и переключает её.
