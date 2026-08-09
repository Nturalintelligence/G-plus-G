# G+G — актуальный план развития (русская редакция)

Статус документа: `CURRENT_PLAN / OWNER_REVIEW`

Дата сверки: 2026-08-10

Исходник: `multi_llm_orchestrator_plan.txt`, версия 1.0, уже написан по-русски.

Этот файл не заменяет исходный подробный план и не объявляет backlog выполненным.
Он сохраняет структуру исходных разделов и добавляет текущий статус относительно
ветки `fix-branch` / baseline `e7fae00` с незакоммиченными локальными правками.

Статусы:

- `IMPLEMENTED` — production wiring существует; это не равнозначно live UAT;
- `LOCALLY_TESTED` — указанная локальная автоматика ранее проходила на записанном SHA;
- `PARTIAL` — часть пути существует, обязательная часть отсутствует;
- `BLOCKED_BY_AUTH` — требуется короткая ручная проверка владельцем;
- `PLANNED` — production implementation отсутствует;
- `FROZEN` — не менять без отдельного воспроизводимого дефекта и команды владельца.

## 1. Идея проекта — IMPLEMENTED / PARTIAL

Локальный Electron-оркестратор ChatGPT Web и Gemini Web через видимые Playwright
sessions существует. Структурированный Project State и export существуют; импорт
истории провайдеров и полный response-file flow отсутствуют.

## 2. Основные принципы — IMPLEMENTED

SQLite остаётся локальным source of truth; провайдеры изолированы адаптерами;
пользователь сохраняет контроль; автономность ограничена. Подтверждённые working
features замораживаются, а изменения делаются микрошагами.

## 3. Границы первой версии — PARTIAL

ChatGPT/Gemini, local persistence, основные orchestration modes и Electron UI есть.
Live provider matrix, READY visual behavior, Quality Center, некоторые attachment
пути и restart-auth требуют проверки/исправления.

## 4. Рекомендуемый стек — IMPLEMENTED

TypeScript, Node.js, Electron/React, Playwright и SQLite используются фактически.
Перенос storage или замена архитектуры не входят в текущий scope.

## 5. Высокоуровневая архитектура — IMPLEMENTED / FROZEN

Renderer → preload/IPC → main/application services → orchestrator/adapters/storage.
Обход этих границ запрещён. Изменение нескольких крупных подсистем требует ADR.

## 6. Структура проекта — IMPLEMENTED

Фактическая структура отличается от раннего layout, но разделение apps/src/tests/docs
сохранено. Реструктуризация ради соответствия старому дереву не нужна.

## 7. Контракт адаптера — IMPLEMENTED / BLOCKED_BY_AUTH

`ModelAdapter` реализован для ChatGPT/Gemini. Bounded waits, response binding,
challenge handling и persistent profiles существуют; реальные DOM/session сценарии
остаются manual boundary.

## 8. Изоляция browser profiles — IMPLEMENTED / UNVERIFIED_MANUAL

Профили и locks разделены по provider. Cached startup status, последовательный
single-probe и TTL ещё не реализованы полностью.

## 9. Обнаружение элементов — PARTIAL

Есть наборы selectors и ambiguity checks. DOM drift остаётся внешним риском;
authorization/composer признаки нельзя смешивать без доказанного контракта.

## 10. Завершение ответа — IMPLEMENTED / BLOCKED_BY_AUTH

Используются generation/composer/stability признаки, а не один таймер. Live
streaming/empty/interrupted/provider-DOM matrix не закрыта на текущем SHA.

## 11. Привязка ответа к ходу — IMPLEMENTED / LOCALLY_TESTED

Pre-send snapshots, fingerprints и turn/submission identities существуют.
Live wrong/stale binding остаётся release UAT.

## 12. Состояния оркестратора — IMPLEMENTED / LOCALLY_TESTED

Run/turn/attempt FSM, interruption/recovery и typed outcomes существуют.
Семантическое завершение trivial discussion требует отдельного исправления.

## 13. Режимы оркестрации — IMPLEMENTED / PARTIAL

MANUAL, SEQUENTIAL, PARALLEL и DEBATE существуют. DEBATE ограничен round limits,
но trivial/normal/complex budget и material-delta stopping ещё не реализованы.

## 14. Безопасная передача ответов — IMPLEMENTED

Peer content помечается как untrusted, ограничивается по размеру, service markers
удаляются из public output. Нельзя исполнять найденный Markdown/code.

## 15. Локальная модель данных — IMPLEMENTED / PARTIAL

SQLite хранит projects/runs/turns/attempts/messages/events/conversations и CLI FSM.
Отдельные persistent discussion traces, auth snapshots, import provenance и полная
activity model требуют проверки или новых additive migrations.

## 16. Управление контекстом — PARTIAL

Prompt lifecycle, bounded context, memory/checkpoint hooks существуют. Автоматический
desktop rollover в новый provider conversation не закрыт end-to-end.

## 17. Экспорт артефактов — IMPLEMENTED / PARTIAL

Project/spec export и hash manifest существуют. Discussion export и import rollback
ещё не являются готовыми пользовательскими функциями.

## 18. Ошибки и восстановление — IMPLEMENTED / PARTIAL

Диагностика, interrupted recovery, bounded retry и attachment UNKNOWN policy есть.
Provider offline/expired/partial-login matrix и response-file reconciliation неполны.

## 19. Наблюдаемость — PARTIAL

Redacted logs/metrics существуют. Пользователь сообщил пустой Quality Center;
нужно проследить producer → persistence → query → IPC → UI, не рисуя fake data.

## 20. Безопасность — IMPLEMENTED / FROZEN

Renderer isolation, strict IPC, CLI approval/FSM/`shell:false`, path audit,
attachment integrity и SSRF policy являются обязательными границами.

## 21. Desktop UI — PARTIAL

Основные project/settings/orchestration/CLI/attachment controls существуют.
READY_ANSWER, discussion drawer и light/dark modal contrast требуют scoped UAT/fixes.

## 22. Поэтапная реализация — SUPERSEDED BY MICROSTEP POLICY

Исторические этапы полезны как reference. Текущая работа: один дефект, один
characterization contract, один минимальный diff, одна связанная проверка.

## 23. Стратегия тестирования — UPDATED

Microstep: одна focused проверка + diff review. CI/checkpoint: необходимые suites и
typecheck/build. Package/provider matrix/soak: только release или отдельная команда.

## 24. Метрики качества — PARTIAL

Metrics/storage primitives заявлены, но реальное отображение после restart не
подтверждено. Нужна честная local activity model либо исправление существующего пути.

## 25. Ключевые риски — ACTIVE

DOM drift, CAPTCHA/rate limit, stale status docs, profile locks, wrong response
binding, destructive migrations, secrets, scope creep и тестовый/provider spam.

## 26. Первый реальный релиз — NOT READY

Нужны короткий owner provider smoke, READY behavior, сохранение sessions/projects,
attachments, response-file path, Quality Center и release provenance.

## 27. Работа с coding agent — UPDATED

Не передавать весь план как автоматический backlog. Каждый этап начинается прямой
командой владельца; рабочее поведение не трогается; незавершённое не называется
готовым; push выполняется только для адекватного проверенного checkpoint.

## 28. Итоговое решение — CURRENT

Сохраняется существующий Electron + Playwright + SQLite продукт. Базовые функции
доводятся локальными изменениями. Импорт чатов идёт отдельным ADR/branch после базы.
`G_PLUS_G_EXECUTION_V1` и Secure Code Runtime сейчас не трогаются.

## Ближайшие checkpoints

1. Зафиксировать и вручную подтвердить текущую Gemini/ChatGPT authorization work.
2. Исправить лишние orchestration rounds на characterization «оба тут?».
3. Отделить READY_ANSWER от discussion trace и подтвердить persistence.
4. Ввести cached auth snapshot + один последовательный background probe без сообщений.
5. Исправить theme/modal contrast по фактическому DOM/tokens.
6. Проследить и восстановить Quality Center activity path.
7. Проверить attachment pipeline и честно классифицировать capability matrix.
8. После стабилизации создать ADR официального export import.

Ни один следующий checkpoint не начинается как широкая параллельная переделка.
