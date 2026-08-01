# G+G AI Handover & Change Log (Для ИИ-разработчиков)

Этот файл вести всем ИИ-разработчикам (Gemini, Antigravity, Codex, Claude). После выполнения каждой команды/фичи вносится новая запись о том, что изменилось, какие файлы затронуты и какие ветки использовались.

---

## 📜 Журнал Изменений (Change Log)

### [2026-08-01 14:07] Feature: AI Models Hub & Language Lock
- **Ветка**: `feature/ai-models-hub`
- **Изменения**:
  1. **Языковой Лок (Language Locking)**: В [`src/orchestrator/prompt-builder.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/src/orchestrator/prompt-builder.ts) добавлена строгая директива отвечать на языке обращения пользователя (на русском, если запрос на русском).
  2. **Центр Управления ИИ (AI Models Hub)**: В UI добавлен отдельный модуль управления провайдерами с индивидуальными ролями (Архитектор, Кодер, Валидатор) и пер-модельными кастомными промптами.
  3. **Очистка Истории & Авторизация**: Отдельные кнопки входа в родном Chromium и сброса локальной истории конкретного ИИ.
- **Статус**: В разработке.

---

### [2026-08-01 13:58] Fix: Dedicated Chromium Browser Login & Cloudflare Challenge Prevention
- **Ветка**: `dev` -> `uat`
- **Изменения**:
  1. Возвращен запуск встроенного Chromium Playwright (`headless: false`) для ручной авторизации, чтобы куки сохранялись строго в `profiles/chatgpt` и `profiles/gemini`.
  2. В `ChatGptAdapter` и `GeminiAdapter` устранены блокировки Cloudflare `CHALLENGE_REQUIRED`.

---

### [2026-08-01 13:36] Feature: Antigravity Workbench (Ctrl+V Paste & Terminal Engine)
- **Ветка**: `dev` -> `uat`
- **Изменения**:
  1. Добавлена вставка скриншотов из буфера обмена (`Ctrl + V`) в Composer с отображением превью картнок.
  2. Реализован `Terminal Execution Engine` ([`src/terminal/terminal-engine.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/src/terminal/terminal-engine.ts)) для исполнения консольных команд и IPC мост `terminal:execute`.
