# Phase E.2 — компактные интерактивные сообщения

Дата проверки: 2026-08-25.

## Причина дефекта

Карточки наследовали избыточную минимальную геометрию и не имели независимого слоя действий. Поэтому короткий текст занимал лишнюю высоту, а появление управляющих элементов могло влиять на размер сообщения. Общий строковый IPC-валидатор также применял `trim()`, что не позволяло гарантировать побайтовое сохранение исходного Markdown при копировании.

## Реализация

- Высота карточки определяется содержимым, ширина ограничена, длинный Markdown переносится без горизонтального overflow.
- Вложения остаются отдельным блоком сообщения.
- Сохранены отдельные состояния user, ChatGPT, Gemini, final, system, partial и cancelled.
- Единственное действие `Копировать` размещено абсолютным overlay и доступно по hover и keyboard focus без изменения геометрии карточки.
- Копируется исходный текст и Markdown; внутренние consensus markers, UAT markers и protocol envelope исключаются.
- Clipboard IPC не изменяет пробелы или переводы строк. Ошибка показывает понятное сообщение и пишет только длину и тип ошибки, без содержимого.

## Проверки

- `npm run check`: 61 test files, 278 tests — PASS.
- Focused message tests: 12 tests — PASS.
- Security tests: 37 tests — PASS.
- Security source guard: 104 production files — PASS.
- Electron smoke: 1920×1080 dark, 1366×768 light, 1100×700 dark — PASS.
- Browser zoom: `1` (100%).
- Windows display scale: `1.5` (150%).
- Hover и keyboard-only focus не меняют bounding box карточки.
- После перезапуска сохранены transcript, attachment и действие копирования.
- Во всех трёх размерах `scrollWidth <= clientWidth`.

Примечание среды: системный clipboard недоступен для обратного чтения из автоматизированной desktop-сессии (даже PowerShell probe возвращает пустое значение). Поэтому реальный Electron smoke подтверждает успешный renderer→IPC вызов и состояние `Скопировано`, а точное содержимое, сохранение Markdown и очистка внутренних маркеров покрыты отдельными unit/contract tests.

## Полноэкранные кадры

- `docs/screenshots/phase-e2-messages-1920x1080-dark.png`
- `docs/screenshots/phase-e2-messages-1366x768-light.png`
- `docs/screenshots/phase-e2-messages-1100x700-dark.png`
