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

- [x] `Composer.tsx`: заменить `<Square />` на заливной белый скруглённый квадрат (`span` 10×10, `rounded-[2px]`, `bg-white`), по центру круга.
- [x] Усилить градиент: `from-white/35 via-white/10 to-black/15` (плюс мягкий верхний внутренний блик) для Send, Queue, Stop; disabled Send/Queue — без градиента.
- [x] Тест: кнопка Stop содержит заливной индикатор; градиентные классы присутствуют на всех вариантах.
- [x] Проверка: `pnpm test tests/composer.test.tsx`.

## T02 — ASCII-фон: шлейф, покой, клик

Файлы: `src/lib/asciiWave.ts`, `src/components/chat/LivingAscii.tsx`, `tests/ascii-wave.test.ts`.

- [x] `asciiWave.ts`:
  - `rippleValue`: медленный неровный пульс — сумма двух синусов с несоизмеримыми частотами (период ~3.5–5 с), без резких колец.
  - Новый `trailValue(x, y, point, now)`: мягкое затухающее пятно от точки шлейфа (age ~600–900 мс, радиус ~40–60 px).
  - `pulseValue`: плавный bloom — сила нарастает ~600 мс, radius растёт с 6 px, жизнь ~2.6 с, лёгкая угловая неровность; в момент 0 вклад = 0 (никакого мгновенного диска).
  - `cellBrightness` принимает `trail: Ripple[]` и учитывает его.
- [x] `LivingAscii.tsx`:
  - `trailRef`: точки указателя (не чаще ~35 мс / 6 px, максимум 16), затухают ~800 мс.
  - `pointerRef` остаётся для медленного пульса в покое; на `pointerleave` пульс гаснет, шлейф доигрывает.
  - Клик добавляет `pulse` со strength ~0.9; расчёт только в bounding box точки (быстрый отсев по квадрату расстояния).
- [x] Тесты: `pulseValue` в 0 мс ≈ 0, максимум позже, ноль после ~2.6 с; `trailValue` спадает с возрастом и расстоянием; `rippleValue` меняется медленно.
- [x] Проверка: `pnpm test tests/ascii-wave.test.ts`.

## T03 — Извлечение деталей инструментов

Новый `src/lib/toolDetails.ts` (чистые функции) + `tests/tool-details.test.ts`.

- [x] `toolPath(item)`: `locations[0]` → `rawInput` (`path`, `file_path`, `filePath`, `target_file`, `filename`) → путь из title.
- [x] `toolLineRange(item)`: `rawInput` (`offset`+`limit`, `start_line`+`end_line`, `line`) → `{ start, end }`; fallback — regex `lines? (\d+)(?:-(\d+))?` из title/вывода.
- [x] `toolCommand(item)`, `toolQuery(item)`: `command|cmd|script`, `query|pattern|regex|q`; fallback title.
- [x] `toolOutputText(item)`: `rawOutput`/`content` через `readableToolValue`, срезать служебные `^\s*\d+[→\t]` префиксы.
- [x] `numberedExcerpt(text, start, maxLines=40)`: массив `{ n, text }`, обрезка и признак `truncated`.
- [x] Тесты на все экстракторы и нумерацию.

## T04 — Умная строка активности

Файл: `src/components/chat/MessagesTimeline.tsx`.

- [x] `TimelineRows`: группа из **1+** подряд идущих tool/thought/trace рендерится одним `ActionGroupRow`; 0s-thought по-прежнему отфильтрованы.
- [x] `ActionGroupRow`:
  - `active` = streaming thought или tool pending/in_progress.
  - `open` стартует как `active`; при смене `active` авто-открытие/закрытие; ручной toggle сохраняется до следующей смены.
  - активная подпись по kind: thought → `Thinking · Ns`; read → «Reading file»; edit/write/move/delete → «Editing file»; execute → «Running command»; search → «Searching files»; fetch → «Fetching»; иначе → `Working` / title.
  - завершённая: одиночная мысль → `Thought for Ns`, иначе `summarizeActionGroup`.
  - слева: ASCII-спиннер при active, иначе иконка; подпись с классом свечения при active.
  - раскрытие: хронологический список деталей без вложенных кнопок-аккордеонов.
- [x] `ActionDetail` (внутри файла или отдельный компонент):
  - read: заголовок «Read <path>», диапазон строк, нумерованный `<pre>` (до 40 строк), `+N more lines`.
  - edit/write/delete/move: путь + кнопка «Open diff» (открывает правую панель на вкладке diff); вывод, если есть.
  - execute: `$ command` + stdout/stderr.
  - search: запрос + результаты.
  - thought: текст мысли.
  - fallback: title + читаемый вывод; маленький Raw-toggle на случай сырых данных.
  - изображения из payload сохранить.
- [x] Убрать отдельный `ToolRow`/`ThoughtGroup` из основного потока (оставить только внутри раскрытия).
- [x] Тесты: одиночный tool сворачивается; активная группа авто-раскрыта и показывает детали; после завершения авто-свернута; подписи по kind; read-экспонат с номерами строк; edit показывает Open diff; мысль видна в раскрытии; Raw скрыт по умолчанию.
- [x] Обновить существующие тесты, которые ждут отдельных строк/ручных аккордеонов.

## T05 — i18n

- [x] Добавить ключи (en): `chat.action.reading`, `editing`, `running`, `searching`, `fetching`, `readFile`, `editedFile`, `openDiff`, `moreLines`, `command`, `output`.
- [x] Перевести на ru/de/es/fr/ja/zh; паритет и плейсхолдеры проверить `tests/i18n.test.ts`.

## T06 — Свечение

- [x] `src/styles/index.css`: `.activity-shimmer` — градиент `text-tertiary → text-primary/accent → text-tertiary`, `background-size: 220%`, `background-clip: text`, медленная анимация 4–6 с, `ease-in-out`; `prefers-reduced-motion` → без анимации и прозрачности.
- [x] Применять только к подписи активной строки.

## T07 — Гейты и ревью

- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `cargo test --lib`, `cargo clippy --all-targets -D warnings`.
- [x] Playwright.
- [x] Gemini review дельты; исправить Critical/Important.
- [x] Release build + перезапуск приложения.
- [x] Обновить TODO/CHANGELOG одной строкой.

## T08 — Full access: оранжевый акцент

- [x] `ComposerControls.tsx` ModePill: при `permissionMode === "full_access"` иконка, текст и стрелка — `text-warning`; в меню выбранная строка получает `bg-warning/10`, оранжевый заголовок и галочку.
- [x] Тест: Full access даёт warning-классы на пилюле и выбранной строке.

## T09 — Убрать «…», перенести Options в пикер провайдера

- [x] Удалить `ComposerOverflowMenu` и кнопку `MoreHorizontal` из `Composer.tsx`.
- [x] В `ProviderModelPicker` добавить секции `AgentModePicker` и `ConfigOptionPickers` (без model/reasoning) — туда переезжают Collaboration mode, Fast mode и прочие опции агента.
- [x] Fast mode: если у выбранного провайдера есть boolean-опция с `fast` в id/name, показывать рядом с пикером кнопку-молнию (`Zap`), tooltip `composer.fastMode`; клик переключает опцию, включённая — акцентная. Если опции нет — кнопки нет.
- [x] i18n: `composer.fastMode` (и подпись секции `composer.options`, если нужна).
- [x] Тесты: «…» больше нет; опции видны в пикере; молния появляется только при fast-опции и переключает её.

## T10 — Финальная доводка по замечаниям (2026-11-16, вечер)

- [ ] Очередь: убрать разделительные линии между сообщениями; равные отступы сверху и снизу; стеклянный фон как у окна ввода (тот же `--composer-tint`/blur).
- [ ] Перетаскивание очереди: pointer-драг «физически за сообщение» с плавным следованием, смена порядка на отпускании, без HTML5 DnD.
- [ ] Редактирование очереди в поле ввода: кнопка Edit переносит текст в композер, сохраняет текущий черновик; Enter/галочка сохраняют, Esc/крестик отменяют и возвращают черновик; inline-редактор удалить.
- [ ] Картинки агента: `read_image_data_url` принимает threadId и разрешает путь вне workspace при Full access; декодировать `%5C` и `C:Users…` в Markdown; тест на оба формата пути.
- [ ] Все мысли/действия по умолчанию свёрнуты (в т.ч. во время работы); авто-закрытие после завершения; свечение на `Thinking`, `Working for Ns` и начальном `Working…`.
- [ ] Убрать постоянные подложки/рамки у триггера выбора модели и молнии fast mode (hover остаётся).
- [ ] Тесты: очередь (отступы/стекло/драг/редактирование с сохранением черновика), markdown-картинки, timeline (collapsed by default, shimmer-классы), полный прогон.

## T11 — Одна строка статуса

- [ ] Не показывать отдельные `Running command` и `Working for Ns`: активная строка активности получает длительность (`Running command · 55s`, `Thinking · 12s`), общий таймер под ней скрывается, пока в ленте есть action-группа.
- [ ] Начальный `Working…` показывать только когда у запуска ещё нет `startedAt`, чтобы не дублировать `Working for Ns`.
- [ ] Таймер активной tool-строки тикает раз в секунду от старта запуска.
- [ ] Тесты: активная группа содержит действие и длительность в одной подписи; отдельного `Working for` нет; начальный статус один.

## T12 — Сайдбар и иконка

- [ ] Длинные названия проектов и тредов в сайдбаре не обрезаются многоточием, а плавно уходят в прозрачность справа (`fade-truncate`, mask-image).
- [ ] Уменьшить белый знак внутри иконки приложения (~86%), перегенерировать все размеры через `pnpm tauri icon`.
- [ ] Тест: у элементов сайдбара класс `fade-truncate`, многоточие не используется.
