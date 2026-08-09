# G+G — inventory правил и инструкций для ИИ

Дата аудита: 2026-08-09

Статус: `STAGE_0 / REVIEW_REQUIRED`
Назначение: показать владельцу все найденные источники правил до продолжения
production-разработки. Этот файл ничего не отменяет и не меняет автоматически.

## Baseline

- Рабочая копия: `C:\Users\onadl\OneDrive\Рабочий стол\G-plus-G`.
- Ветка: `fix-branch`.
- HEAD: `e7fae00d18dcbd465541bdb5f7918d6e96303e5b`.
- Remote: `https://github.com/Nturalintelligence/G-plus-G.git`.
- PR #2: `MERGED`, не draft; `agent/integrate-cleanup-into-uat` → `uat`;
  последний check `CI / verify` завершён `SUCCESS`.
- PR: <https://github.com/Nturalintelligence/G-plus-G/pull/2>.
- До начала этого inventory рабочее дерево уже было изменено:
  `M docs/PROJECT_MASTER.md`, `M src/gemini-adapter.ts`, `?? sample.txt`.
- В ходе stage 0 production-код не изменялся. Создан только этот inventory.
- `sample.txt` не читался, не менялся и не добавлялся в Git.

## Шкала приоритетов

| Приоритет | Значение |
|---|---|
| P0 | Ограничения среды выполнения и текущая прямая команда владельца. Они выше файлов репозитория. |
| P1 | Канонические проектные, security и подтверждённые architecture decisions. |
| P2 | Правила отдельной области: Git, release, UAT, adapters, prompts. |
| P3 | Status, handoff, historical plan и operational documentation; это доказательства/контекст, а не разрешение на новую работу. |
| P4 | Runtime-промпты внутри продукта. Они управляют моделями G+G, но не являются инструкциями разработчику Codex. |

Точный текст внутренних системных инструкций среды не копируется. Ниже зафиксировано
только их практическое влияние на этот проект.

## Полный inventory

| Источник | Область | Приоритет | Краткое содержание и требуемые действия | Конфликты, дублирование и риск широкой переработки | Рекомендация |
|---|---|---:|---|---|---|
| Инструкции среды Codex (не файл репозитория) | Все действия агента | P0 | Соблюдать иерархию инструкций, разрешения файловой системы, защищать данные, не выполнять destructive/remote действия без полномочий, не выдавать непроверенное за факт. | Не могут быть отменены файлом проекта. Полный скрытый prompt не является проектным артефактом. | Оставить вне репозитория; в проекте фиксировать только последствия. |
| Текущий запрос владельца (`pasted-text.txt`, attachment `9b3a96de-...`) | Текущий цикл | P0 | Сейчас: только read-only inventory, создать этот файл, показать правила и остановиться. Production-код до согласования не менять. Далее описывает staged repair. | Внутренний конфликт: требует characterization + общий regression gate после каждого изменения и одновременно наследует более свежую команду владельца о microchanges/minimal tests. Будущие разделы очень широки, но stage barrier запрещает запускать их сразу. | Оставить текущим task contract; перед stage 1 владелец выбирает gate policy. |
| `docs/PROJECT_MASTER.md` | Весь репозиторий | P1 | Сам объявлен канонической точкой входа. Не трогать проверенно работающие функции; auth — только по прямой команде; одна рабочая копия; один логический блок; честные статусы; защита секретов; без CAPTCHA bypass/retry spam; точечный rollback; microchanges; minimal checks; ручной UAT для `VERIFIED_USER`. | Внутри файла старый workflow всё ещё требует после блока «общую сборку/проверку», что конфликтует с новыми пунктами 10–13. Дублирует GEMINI/handoff/release docs. | **Оставить каноническим**, затем устранить внутренний конфликт и добавить явную матрицу «размер изменения → gate». |
| `GEMINI.md` | AI onboarding, repo-wide | P2 | Читать архитектуру/логи/код; не доверять одной документации; ограниченные waits; миграции; секреты; git/release discipline; provider adapter constraints. | Метаданные устарели (ветка, SHA, версия, числа тестов). Требует `npm run check` перед каждым commit и обновление changelog, конфликтуя с minimal-tests. Фраза «если код расходится — обнови и код, и документ» может расширять scope. Старые auth-описания опасны. | **Сократить/объединить**: оставить durable rules и ссылку на PROJECT_MASTER; исторический status вынести. |
| `AI_HANDOFF.md` | Передача состояния между агентами | P2/P3 | Cleanup checkpoint, frozen zones, known state, следующий шаг, запрет Secure Runtime. | Статус быстро устаревает. Содержит утверждение о точной auth root cause и старый next step, которые владелец оспаривал/изменил. Дублирует PROJECT_MASTER, ROADMAP, TEST_EVIDENCE. | Оставить как датированный handoff, но не считать текущей истиной; обновлять только подтверждёнными фактами. |
| `README.md` | Пользовательская эксплуатация и команды | P3 | Запуск, отправка, backup/restore, diagnostics, manual acceptance. | Повторяет release/testing команды; отдельные примеры могут устаревать. Не должен становиться автоматическим work queue. | Оставить; сократить инженерные mandates до ссылок на canonical docs. |
| `docs/architecture.md` | Architecture boundaries | P1 | SQLite source of truth; adapters replaceable; renderer без прямого FS/DB; preload/IPC boundary; persisted conversation/turn semantics. | Конфликтов с запросом нет. Краткий документ может отставать от кода. | Оставить; изменения архитектуры проводить через ADR и проверку фактического кода. |
| `docs/SECURITY_MODEL.md` | Security/trust boundaries | P1 | Model text/files/URLs untrusted; CLI только proposal → approval/FSM/`shell:false`/scope audit; renderer isolation; attachment integrity/SSRF rules; Secure Runtime только PLANNED. | Дублирует DECISIONS и executor prompt, но это полезное защитное дублирование. | Оставить без ослабления. |
| `docs/DECISIONS.md` | Подтверждённые решения | P1 | Только `G_PLUS_G_CLI_TASK_V1`; никаких keyword/code-fence execution; no command strings; exact verifier registry; managed workspace; no history rewrite; runtime отдельно. | Cleanup-specific решения смешаны с долгоживущими. | Оставить; позднее разнести на numbered ADR/decision log. |
| `docs/GIT_WORKFLOW.md` | Git/branches/releases | P1/P2 | `main` production, `uat` integration; PR/review/CI; no force/delete; rollback `prod`; promotion `uat → main`. | Говорит создавать feature/fix от `main`, тогда как текущий запрос предписывает `fix/core-functionality-0.1` после cleanup merge, а реально открыта `fix-branch`. Требуется решение владельца до branch mutation. | Оставить, но обновить точный approved branching flow после выбора владельца. |
| `.github/CODEOWNERS` | GitHub ownership | P2 | Владелец для main/preload/orchestrator/storage/adapters/release/workflows. | Не обеспечивает protections сам по себе. | Оставить. |
| `.github/workflows/ci.yml` | PR и push в `main`/`uat` | P2 | `npm ci`, security guard, full check, desktop build на Windows. | Полный gate уместен в CI, но не означает необходимость запускать его локально после каждой микроправки. | Оставить; использовать как PR gate. |
| `docs/RELEASE_CHECKLIST.md` | Только release candidate | P2 | Frozen SHA, clean install/upgrade/rollback, full gates, provider matrix, soak, evidence. | Дублирует UAT/testing/GEMINI. Опасен, если применять к каждому маленькому шагу. | Объединить с UAT в один release gate; явно пометить `RELEASE_ONLY`. |
| `docs/UAT_RUNBOOK.md` | Закрытый UAT на VM | P2 | Полный install/provider/attachment/CLI/rollback/soak/evidence профиль, только с owner approval и test accounts. | Очень тяжёлый и создаёт live traffic. Не относится к microchange gate. | Оставить `RELEASE_ONLY`; не запускать без отдельной команды. |
| `docs/testing.md` | Исторический acceptance | P2/P3 | Full check/build, 50-marker provider tests, recovery, backup/restore; challenge stops automation. | 50 запросов каждому провайдеру противоречат актуальному запрету spam и короткому smoke. Дублирует UAT. | Сократить; перенести тяжёлые сценарии в UAT/soak, пометить ручными. |
| `docs/adapter-development.md` | Изменения provider adapters | P2 | Собственный persistent profile/lock; fail closed on ambiguous DOM; stop on challenge; pre-send snapshot; no secret logging. | Конфликта нет; release matrix тяжёлый, но scoped. | Оставить. |
| `docs/PROMPT_PROTOCOL.md` | Prompt/orchestration contract | P1/P2 | Bounded context, untrusted peer data, explicit FINALIZE, READY/STREAMING split, attachment semantics, honest PARTIAL status. | Заявляет implementation state, который требует сверки с кодом/UAT. | Оставить контракт; status привязывать к SHA/evidence. |
| `docs/FEATURE_MATRIX.md` | Feature status | P3 | TESTED/IMPLEMENTED/PARTIAL/BLOCKED/PLANNED с evidence и ручными gates. | Дата/branch/SHA устаревают; `IMPLEMENTED` легко ошибочно принять за реально работающую функцию. | Оставить, добавить `verifiedAt`, SHA и owner-UAT column; не использовать как разрешение на работу. |
| `docs/implementation-status.md` | Историческая реализация vs plan | P3 | Список foundations, acceptance gaps, запрет production-ready без matrix. | Утверждает live 20x20 и quality dashboard, тогда как более новые evidence/known issues фиксируют ручные пробелы. | Сверить и затем объединить с FEATURE_MATRIX либо архивировать как snapshot. |
| `docs/ROADMAP.md` | Отложенные этапы | P3 | Base stabilization, UAT, protections, позже design/runtime. | Может восприниматься как автоматическая очередь задач. Branch/SHA state не совпадает с текущей веткой. | Оставить только как backlog; каждую задачу начинать по отдельной команде. |
| `docs/KNOWN_ISSUES.md` | Known defects/blocks | P3 | GitHub plan, dependency audit, auth/live gaps, response files, rollover, CLI host risk. | Некоторые PR/SHA/status сведения устарели. | Оставить; обновлять только воспроизводимым evidence. |
| `docs/TEST_EVIDENCE.md` | История проверок | P3 | Команды, результаты, artifact hashes, manual boundaries. | Старые PASS относятся к старым SHA; auth tests не равны owner UAT. | Оставить append-only; на каждой записи обязательны SHA/date/scope. |
| `docs/ARTIFACT_AUDIT.md` | Cleanup evidence | P3 | Решения по временным/сгенерированным/релизным артефактам. | Cleanup scope не является текущим общим разрешением удалять файлы. | Оставить историческим audit. |
| `docs/first-run.md`, `docs/troubleshooting.md` | Пользовательская эксплуатация | P3 | Login, profiles, challenge, reset, browser, backup. | `troubleshooting.md` утверждает, что Gemini **обязан** входить через обычный Chrome; это прямо противоречит текущей команде владельца использовать встроенный браузер и текущему production flow. | После решения владельца исправить Gemini-раздел; пока пометить конфликтным. |
| `CHANGELOG.md` | История релизов | P3 | Что было заявлено изменённым по версиям. | Не является доказательством работы и не должен обновляться на каждую незавершённую микроправку. | Оставить; менять на checkpoint/release, не на каждый эксперимент. |
| `multi_llm_orchestrator_plan.txt` | Исходный большой план | P3 | Фундаментальная архитектура, UX, storage, provider automation, testing и этапы. | Очень широкий; многие пункты исторические. Если принять за активную команду, провоцирует перепроектирование всего продукта. | Оставить source plan; на stage 1 сравнить с реальностью и сделать русскую current-version без автоматического исполнения backlog. |
| `C:\Users\onadl\Downloads\CODEX_PROJECT_CLEANUP_PROMPT.md` | Завершённый внешний cleanup task | P3 historical | Широкий audit/removal/security/Git/UAT, agents, cleanup branch. | Был оправдан для cleanup, но теперь может снова спровоцировать массовые удаления, полный gate и работу по всему repo. | Не удалять внешний файл; считать завершённым историческим заданием, не текущей спецификацией. |
| `C:\Users\onadl\Downloads\G_PLUS_G_SECURE_CODE_RUNTIME_PLAN.md` | Внешний experimental proposal | P3 historical | Изолированный runtime без CLI, строгий `G_PLUS_G_EXECUTION_V1`, sandbox/policy/approval. | Прямо запрещён текущим заданием. Не является IMPLEMENTED. | Оставить proposal; не переносить в production и не создавать experimental branch сейчас. |
| `src/orchestrator/productive-protocol.ts` | Runtime behavior моделей G+G | P4 | Few useful turns, material delta, evidence, CLI envelope only, explicit DONE. | Фраза «не заменять local action инструкцией, если executor доступен» и default desktop capability могут провоцировать лишние execution proposals, хотя approval/schema ограничивают риск. Не является instruction Codex-разработчику. | Оставить runtime contract; позднее отдельно проверить против semantic stopping policy. |
| `src/orchestrator/prompt-builder.ts` | Runtime relay/finalization prompts | P4 | Minimal delta, evidence, peer data untrusted, language lock, final answer without service markers. | Может порождать лишние раунды, если stopping logic не завершает trivial task; менять только вместе с characterization. | Оставить; stage 5 текущего запроса требует отдельного scoped анализа. |
| `src/orchestrator/prompt-registry.ts` | Runtime prompt lifecycle | P4 | Versioning/evaluation/rollback механика prompts. | Наличие механики не доказывает UX или live behavior. | Оставить; не менять сейчас. |
| `src/cli-executors/executor-prompt.ts` | Runtime constraints CLI executor | P4 | Только текущий workspace; no links/UNC/device/protected roots; allowed/forbidden paths и acceptance criteria. | Дублирует Security Model намеренно. | Оставить. |
| `package.json` scripts | Local/CI commands | P2 | `check` строит/typechecks/tests; `desktop:start` сначала строит; `package` пишет build info, устанавливает Chromium, строит и создаёт release; backup/restore меняют runtime data. | Запуск `package`, restore, browser install или endurance как «обычной проверки» создаёт лишние изменения/сеть/риск. | Оставить scripts; документировать side effects и запускать broad/mutating scripts только по соответствующему gate/команде. |
| `scripts/write-build-info.mjs` | Build/package | P2 | Перезаписывает `build-info.json` текущим SHA/time. | Делает working tree dirty; нельзя считать read-only проверкой. | Оставить; `RELEASE_ONLY`. |
| `scripts/install-local-browser.mjs` | Build/package | P2 | Скачивает/устанавливает Chromium в `node_modules`. | Сеть и большой filesystem side effect. | Оставить; только setup/package по команде. |
| `scripts/security-source-guard.mjs` | Security gate | P2 | Read-only scan production source на запрещённые legacy/personal markers. | Broad substring guard может давать false positives, но сам код не меняет. | Оставить; менять список только отдельным security-review. |
| `scripts/endurance-dialogue.ts` | Live provider soak | P2 | Создаёт проект, открывает ChatGPT/Gemini и выполняет 40 provider turns. | Прямо конфликтует с запретом spam, если запустить без отдельного UAT разрешения; создаёт внешние запросы и локальные данные. | Оставить, но пометить `MANUAL_LIVE_UAT_ONLY`; не запускать сейчас. |

## Не найдено

В репозитории не найдены:

- `AGENTS.md` ни в одном каталоге;
- `CODEX.md`;
- `CLAUDE.md`;
- Copilot instructions;
- `.rules`;
- `.cursor`;
- `CONTRIBUTING.md`;
- formal numbered ADR directory/template;
- активный custom `core.hooksPath`;
- custom Git hooks (есть только стандартные sample hooks Git).

Из именованных AI instruction files найден только `GEMINI.md`.

## Правила, которым агент реально следует сейчас

1. P0-ограничения среды и текущая команда владельца.
2. Stage-0 stop: только inventory; никакой дальнейшей production-правки.
3. Сохранение чужого dirty worktree и `sample.txt`.
4. Канонические ограничения `PROJECT_MASTER`, `SECURITY_MODEL`, `DECISIONS`.
5. Никаких push/merge/force/destructive операций в этом этапе.
6. Никаких provider probes, login attempts, package/smoke/full test gate в этом этапе.
7. Нельзя повышать статус до рабочего без соответствующего evidence и owner UAT.

## Конфликты с текущим запросом владельца

| Конфликт | Источники | Решение до следующего этапа |
|---|---|---|
| Minimal focused check против полного gate после каждого изменения | `PROJECT_MASTER` 10–13 и последняя команда владельца против старого workflow того же файла, `GEMINI.md`, текущего attached §2/§14 | Владелец выбирает: рекомендовано focused gate на microstep, full CI на checkpoint/PR, package/smoke только release или отдельная команда. |
| Встроенный Gemini browser против обязательного system Chrome | Прямая команда владельца/current code против `docs/troubleshooting.md` и старого `system-browser-login` guidance | Текущая команда владельца выше; после UAT обновить troubleshooting. |
| Текущая branch policy | `GIT_WORKFLOW.md`, attached request и фактическая `fix-branch` | Не менять ветки до решения владельца. |
| Auth freeze против текущей auth work | PROJECT_MASTER freeze, затем прямая команда владельца и pre-existing dirty auth diff | Прямая команда дала узкое исключение; новый stage-0 stop снова замораживает production до review. |
| Старые status claims против текущего evidence | GEMINI, AI_HANDOFF, ROADMAP, implementation-status, TEST_EVIDENCE, PROJECT_MASTER | Нужен один SHA-bound status register; не выбирать удобную версию документа. |

## Неоднозначные и опасно широкие правила

1. Большой исходный plan и будущие разделы текущего задания перечисляют почти все
   подсистемы. Они не являются разрешением реализовать всё подряд.
2. Старый cleanup prompt разрешал repo-wide поиск и удаление в другом контексте.
   Повторно применять его без inventory запрещено.
3. `GEMINI.md`: «если код расходится, обнови код и документ» может превратить
   локальную задачу в несвязанный рефакторинг.
4. Требование полного gate после каждой малой правки провоцирует test/package churn,
   который владелец прямо запретил.
5. Runtime productive protocol поощряет execution proposal вместо инструкции
   пользователю; безопасные schema/approval границы есть, но product behavior требует
   отдельной проверки.
6. Status-слова `IMPLEMENTED`, `TESTED`, `CONFIRMED` без актуального SHA, даты и
   manual gate могут создать ложное ощущение готовности.

## Инструкции, которые могли способствовать прошлым поломкам

- Repo-wide cleanup prompt: слишком широкий scope при слабом разделении cleanup/auth/UI.
- Большой исторический plan: удобен как vision, опасен как активный backlog.
- `GEMINI.md` с автоматическим «синхронизировать код и документ».
- Дублирующие next-step/status указания в `AI_HANDOFF`, ROADMAP и PROJECT_MASTER.
- Устаревшая обязательная system-Chrome инструкция Gemini.
- Обязательный общий gate/packaging на каждом шаге, отвлекающий от короткого ручного
  подтверждения реальной функции.
- Недоказанное auth root-cause утверждение в handoff, записанное как факт.

## Правила о файлах вне фактической задачи

Активного правила, разрешающего произвольно менять несвязанные файлы, не найдено.
Наоборот, PROJECT_MASTER и GEMINI требуют узкого scope. Риск создают косвенные
формулировки:

- старый cleanup prompt требует полного repo-wide исправления всех найденных проблем;
- GEMINI предлагает одновременно обновлять расходящиеся code/docs;
- большой plan и ROADMAP могут восприниматься как автоматический work queue;
- runtime productive protocol рекламирует project/desktop workspace capabilities.

Эти источники не должны расширять текущую задачу без прямого решения владельца.

## Правила о ложной готовности

Правил, прямо разрешающих объявлять незавершённую функцию готовой, не найдено.
Наоборот, PROJECT_MASTER, FEATURE_MATRIX, implementation-status, productive protocol
и security broker это запрещают. Реальный риск — stale status prose:

- `IMPLEMENTED` может означать только наличие wiring без packaged/live UAT;
- старый PASS относится только к записанному SHA и scope;
- mock, class, button или typecheck не доказывают пользовательский сценарий;
- auth/provider/attachments требуют отдельного manual evidence.

## Дублирование

- Git/release/test commands повторяются в `GEMINI.md`, README, PROJECT_MASTER,
  testing, RELEASE_CHECKLIST и UAT_RUNBOOK.
- Текущий статус повторяется и расходится в AI_HANDOFF, ROADMAP, FEATURE_MATRIX,
  implementation-status, KNOWN_ISSUES и TEST_EVIDENCE.
- CLI security rules повторяются в SECURITY_MODEL, DECISIONS, productive protocol,
  executor prompt и schema. Это дублирование в основном защитное и может остаться.
- Auth guidance повторяется в GEMINI, PROJECT_MASTER, handoff, FEATURE_MATRIX,
  troubleshooting и first-run; сейчас эти версии конфликтуют.

## Рекомендации владельцу по очистке

Ничего не удалять до решения владельца.

Предлагаемый последующий набор документов для изменения:

1. `docs/PROJECT_MASTER.md` — оставить единственным canonical rule entrypoint;
   устранить внутренний конфликт gate policy.
2. `GEMINI.md` — сократить до durable AI onboarding и ссылок, удалить из активной
   части устаревшие branch/SHA/test/auth facts.
3. `AI_HANDOFF.md` — превратить в датированный checkpoint без недоказанных root cause.
4. `docs/troubleshooting.md` — привести Gemini login guidance к выбранному владельцем UX.
5. `docs/testing.md`, `docs/RELEASE_CHECKLIST.md`, `docs/UAT_RUNBOOK.md` — разделить
   focused/checkpoint/CI/release/live-soak gates и убрать дублирование.
6. `docs/FEATURE_MATRIX.md` + `docs/implementation-status.md` — выбрать один active
   SHA-bound status register; второй архивировать или сделать ссылкой.
7. `docs/ROADMAP.md` и `multi_llm_orchestrator_plan.txt` — явно пометить backlog/reference,
   который не разрешает автоматическое выполнение.
8. Добавить ADR trigger/template, docs freshness fields, rule precedence и правило
   сохранения untracked user files.

Предлагаемые удаления сейчас: **нет**.

Предлагаемые production-code изменения сейчас: **нет**.

## Точка остановки

Stage 0 завершён. До решения владельца нельзя:

- переходить к переводу/сравнению plan;
- писать characterization tests;
- менять production-код;
- создавать/переключать ветки;
- запускать полный regression/package/smoke/provider UAT;
- начинать Secure Code Runtime или импорт чатов.
