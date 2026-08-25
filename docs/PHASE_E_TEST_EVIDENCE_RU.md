# Phase E — test evidence

Дата: 2026-08-25. Ветка: `fix/clipboard-and-provider-attachments`.

## Автоматические проверки

- `npm run check`: PASS — 60 test files, 275 tests.
- `npm run test:security`: PASS — 37 tests.
- `npm run security:guard`: PASS — 103 production source files.
- `npm run desktop:build`: PASS (development Electron build, не installer).
- `git diff --check`: PASS.

## Visual / Electron smoke

- browser zoom: строго `1` (100%);
- доступный Windows scale текущей машины: 150%;
- sidebar: 36 длинных Unicode-проектов, 1920×1080 dark, 1366×768 light, 1100×700 dark;
- specification: 105 событий, независимый scroll, fixed footer, 1366×768 light и 1100×700 dark;
- сообщения: компактная карточка `тест`, hover/focus action, исходный текст проверен через системный clipboard;
- batch/trash: явный выбор двух проектов, перемещение и восстановление без удаления transcript;
- provider panel: раскрытие ChatGPT, capabilities, auth state, last check и безопасные действия;
- во всех новых сценариях `documentElement.scrollWidth <= clientWidth`.

Полнооконные screenshots находятся в `docs/screenshots/phase-e-*.png` и `docs/screenshots/sidebar-long-list-*.png`.

Phase D не перепроверялась live. Статус: `IMPLEMENTED_LOCALLY / LIVE_UAT_BLOCKED_EXTERNAL`.
