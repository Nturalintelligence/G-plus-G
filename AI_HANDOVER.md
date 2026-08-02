# G+G AI Handover & Change Log (Для ИИ-разработчиков)

Этот файл вести всем ИИ-разработчикам (Gemini, Antigravity, Codex, Claude). После выполнения каждой команды/фичи вносится новая запись о том, что изменилось, какие файлы затронуты и какие ветки использовались.

---

## 📜 Журнал Изменений (Change Log)

### [2026-08-02 14:10] Feature: Two-Tier AI Collaboration Pipeline (Web AI Strategy Board + CLI Executors)
- **Ветка**: `feature/ai-models-hub`
- **Изменения**:
  1. **CLI Executor Bridge**: Реализован [`src/cli-executors/cli-executor-bridge.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/src/cli-executors/cli-executor-bridge.ts) для автономного неинтерактивного вызова `gemini` CLI (v0.50.0) и `codex` CLI (v0.145.0).
  2. **Двухуровневый Оркестратор**: Создан [`src/orchestrator/two-tier-orchestrator.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/src/orchestrator/two-tier-orchestrator.ts), связывающий Стратегический ИИ-совет (ChatGPT & Gemini Web) и Тактических ИИ-исполнителей (CLI).
  3. **Стандарты UI уровня Telegram/Instagram**: В промпты добавлены строгие правила по коммерческому дизайну (стекломорфизм, адаптивные темы, анимации).
  4. **Автоматический цикл проверки**: Парсинг тегов `[[G_PLUS_G_CLI_TASK:...]]`, исполнение тасков на диске, сбор результатов тестов/сборки и отправка отчета обратно Совету.
- **Тесты**: Добавлены [`tests/cli-executor-bridge.test.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/tests/cli-executor-bridge.test.ts) и [`tests/two-tier-orchestrator.test.ts`](file:///c:/Users/onadl/OneDrive/Рабочий стол/G-plus-G/tests/two-tier-orchestrator.test.ts).

---

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
