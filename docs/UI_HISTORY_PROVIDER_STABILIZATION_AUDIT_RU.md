# Аудит стабилизации UI, истории и provider artifacts

Дата: 2026-08-25. Ветка: `fix/clipboard-and-provider-attachments`.

Этот документ фиксирует причины и порядок работ до production-изменений.
Installer, updater, GitHub Release, merge, push и пользовательские web-чаты в
рамках этапа не затрагиваются.

## 1. Header, системная рамка и уведомления

### Фактическое состояние

- `BrowserWindow` создаётся с обычной Windows-рамкой и без явного application
  menu. Electron поэтому показывает стандартную светлую menu/title область.
- В renderer статус — обычный `<span class="status">` внутри `.header-actions`
  рядом с кнопкой «Спецификация».
- Статус ограничен только `max-width: 40vw`, одной строкой и ellipsis. Он всё
  равно участвует во flex-геометрии, не имеет close/timeout и центра истории.
- Десятки разнородных вызовов `setStatus` не содержат уровня и lifecycle.

### Решение

- Сохранить нативные Windows window controls, но использовать проверенный
  `titleBarStyle: hidden` + `titleBarOverlay`, а renderer-header сделать
  drag-region. Интерактивные элементы получают `-webkit-app-region: no-drag`.
- Сохранить функциональное Electron menu с accelerator-ами, включив
  `autoHideMenuBar`; Alt продолжит открывать меню.
- В header закрепить brand и «Спецификацию». Уведомление вынести в отдельный
  компактный overlay/toast, не влияющий на постоянную геометрию header;
  максимум две строки, tooltip, close и bounded auto-dismiss для info.
- Проверить maximize/restore/native controls через Electron smoke, а также
  1920×1080, 1366×768 и 1100×700 в dark/light при browser zoom 100%.

## 2. Icon pipeline

### Фактическое состояние

- Единственный master-like asset — два theme SVG 256×256 с фоновым квадратом.
- `BrowserWindow.icon` ссылается на `dist/desktop/logo.png`, но исходника и
  воспроизводимого шага генерации этого PNG в Vite assets нет.
- В `package.json` отсутствуют `buildResources`, Windows `.ico`,
  `installerIcon`, `uninstallerIcon` и явная shortcut icon-конфигурация.
- Найденный `dist/desktop/logo.png` — generated output, 892029 байт; полагаться
  на него как на master нельзя. `.ico` в репозитории отсутствует.

### Решение

- Добавить отдельный прозрачный square master с безопасными внутренними
  отступами и воспроизводимый генератор PNG/ICO.
- Валидировать ICO frames: 16, 20, 24, 32, 40, 48, 64, 128, 256; alpha/canvas и
  отсутствие clipping/случайного opaque background.
- Подключить source PNG/ICO к development window и electron-builder config, но
  installer не собирать. Start Menu/executable/installer проверять только при
  следующем отдельно разрешённом package gate.

## 3. Stop lifecycle и append-only transcript

### Фактическое состояние

- USER entry сохраняется до provider send — это корректно.
- ASSISTANT entry создаётся только после полного возврата `ask()` через
  `persistResponse`. `RESPONSE_UPDATED` передаётся лишь в React `streaming`.
- `stop()` отменяет adapters; catch возвращает только уже завершённый массив
  `responses`. Частичный текущий ответ не попадает в SQLite.
- Renderer после run/error вызывает `openProject()`, затем очищает `streaming` и
  optimistic state. Поэтому неперсистентный частичный текст визуально исчезает.
- Отдельная SYSTEM-запись об остановке и статус PARTIAL у transcript entry в
  текущей схеме отсутствуют.

### Решение

- Зарезервированный assistant entry ID использовать как durable partial entry:
  upsert очищенного `RESPONSE_UPDATED` с debounce/monotonic content.
- При completion тот же entry финализировать, не добавляя дубликат.
- При stop сохранить последний partial, пометить turn `CANCELLED` и добавить
  append-only SYSTEM entry «Обсуждение остановлено пользователем» ровно один
  раз на run.
- Не удалять/пересобирать предыдущие entries. Проверить stop во время первого
  ответа, между ходами, artifact generation/download, restart и следующий run.

## 4. Provider result lifecycle

### Фактическое состояние

- Adapter events описывают только submitted/response text/completed/timeout;
  generation, selection, rendered result и download не являются состояниями.
- Response completion зависит от исчезновения Stop и возвращения ровно одного
  composer. Image-generation/selection UI поэтому выглядит как зависание.
- Downloader ранее принимал любой `<img>`; это уже локально исправлено, но
  generated image, inline image, external image, preview и provider file пока
  не имеют отдельных типов/evidence.
- Download logic ожидает только Playwright `download` event или явный HTTPS
  download anchor. Provider JS controls могут показывать overlay/selection и не
  создавать event сразу.
- Gemini live TXT вернулся code block. Он честно не является provider file.

### Решение

- Ввести независимый provider-result classifier и FSM:
  `SUBMITTED → GENERATING → AWAITING_USER_SELECTION → RESULT_RENDERED →
  DOWNLOAD_AVAILABLE → DOWNLOADING → STORED`, плюс terminal FAILED/TIMED_OUT/
  CANCELED.
- Evidence типизировать: `PROVIDER_FILE`, `GENERATED_IMAGE`, `INLINE_IMAGE`,
  `EXTERNAL_IMAGE`, `PREVIEW`, `CODE_BLOCK`, `DECORATIVE`.
- Progress продлевает только idle deadline при изменившемся evidence; absolute
  deadline неизменяем. Selection — детерминированный first-result policy только
  если явно включена и покрыта fixture, иначе `AWAITING_USER_SELECTION`.
- Сохранять оригинал только через authenticated download/validated URL или
  доказанный provider blob; применять redirect/domain/MIME/size/hash policy,
  managed storage и assistant-entry binding.
- Code block может иметь отдельное действие «Сохранить текст как файл» с
  source `local-from-response`; оно не засчитывается как live provider file.

## 5. Composer state detection

### Фактическое состояние

- ChatGPT/Gemini перебирают selector groups и принимают visible+editable nodes,
  но затем требуют `length === 1`.
- Не проверяются enabled state, overlay/modal, current conversation ownership и
  generation/selection/download UI.
- `waitForResponse` использует наличие ровно одного composer как признак
  завершения. Отсутствие composer приводит к raw `AmbiguousElementError` или
  общему timeout, хотя фактическое состояние может быть нормальным промежуточным.

### Решение

- Вынести provider page-state classifier: CHAT_READY, GENERATING,
  AWAITING_SELECTION, PREVIEW_OPEN, DOWNLOAD_OVERLAY, CONVERSATION_MISSING,
  LOGIN_REQUIRED, CHALLENGE, LOADING, UI_CHANGED.
- Composer candidates ранжировать по visible/editable/enabled, conversation
  container и отсутствию перекрывающего modal; одинаковый DOM-node
  дедуплицировать между selector groups.
- Пользователю отдавать типизированные понятные ошибки/статусы; selector counts
  и evidence оставлять в диагностике.

## Порядок commits и gates

1. `fix(ui): stabilize application header and notifications` — включая icon
   source/config/validation, но без package/installer build.
2. `fix(runtime): preserve transcript when runs are stopped`.
3. `fix(providers): handle interactive generated artifacts`.
4. `fix(providers): harden composer state detection`.
5. `test(uat): verify generated artifact lifecycle` после всех локальных gates.

Перед live UAT: полный check, security, focused lifecycle/FSM/classifier tests,
Electron UI/crash-restart smokes. Live traffic — не более одного нового image
scenario на ChatGPT и Gemini за попытку; TXT только у доказанно способного
provider. UNKNOWN/TIMEOUT не отправляется повторно вслепую.
