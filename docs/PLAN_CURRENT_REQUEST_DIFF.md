# Diff: существующий план и текущее задание владельца

Дата: 2026-08-10

Baseline: `fix-branch`, `e7fae00` + известные локальные изменения.
Источники: `multi_llm_orchestrator_plan.txt`, `docs/PLAN_RU.md` и текущее
восстановительное задание владельца.

## Уже предусмотрено исходным планом

- local-first SQLite source of truth;
- provider isolation через `ModelAdapter`;
- отдельные persistent browser profiles;
- bounded orchestration и пользовательский контроль;
- manual/sequential/parallel/debate modes;
- response binding к конкретному ходу;
- state/FSM, recovery и diagnostics;
- Project State, decisions и artifact export;
- renderer/preload/main boundaries;
- security, no CAPTCHA bypass и no secret logging;
- attachment handling на уровне общей архитектуры;
- release/acceptance strategy.

## Отсутствует или недостаточно определено в старом плане

- semantic classification `TRIVIAL/NORMAL/COMPLEX` без keyword triggers;
- `NO_MATERIAL_DELTA` и другие typed stop reasons;
- специальная regression «оба тут?»;
- основной экран READY_ANSWER только с atomic final;
- отдельный persistent discussion trace/drawer/export;
- cached `ProviderSessionSnapshot`, TTL и single staggered startup probe;
- точный event producer → persistence → IPC → Quality Center map;
- official ChatGPT/Gemini export import с preview/dedupe/rollback;
- provider-versioned attachment capability matrix;
- visual regression/contrast matrix для themes;
- microstep test policy вместо полного gate после каждой мелочи.

## Противоречия

| Старое положение | Текущее требование |
|---|---|
| Пользователь видит ответы моделей в общей ленте | В READY основной экран показывает только atomic final; discussion скрыто отдельно |
| Debate продолжается до consensus/limit | Следующий round только при material delta/open question/real contradiction |
| Confirmation/check после фиксированного числа turns | Trivial task завершается после одного содержательного ответа каждого нужного provider |
| Тяжёлый acceptance после каждого этапа | Microstep получает одну focused проверку; full gate только checkpoint/CI/release |
| Gemini troubleshooting требует system Chrome | Владелец требует встроенный browser, как у GPT |
| План ориентирован на создание продукта | Текущая задача — восстановление уже существующего продукта без redesign |

## Устаревшие положения и статусы

- Старые branch/SHA/version/test counts в `GEMINI.md` удалены из активной инструкции.
- PR #2 уже merged, а не draft.
- `implementation-status.md` заявляет live endurance и Quality Center, но текущий
  пользовательский опыт и более новые evidence требуют повторной проверки.
- Старые auth root-cause statements нельзя считать доказанными без DOM/log evidence.
- Старый system-Chrome Gemini flow не соответствует выбранному владельцем UX.
- Package smoke/PASS относится к конкретному старому runtime SHA, не к dirty tree.

## Уже реализовано в production, но не обязательно работает end-to-end

| Область | Фактический уровень |
|---|---|
| Orchestration modes/FSM/outcomes | Реализовано и локально тестировалось; semantic trivial stop отсутствует |
| READY/STREAMING wiring | Реализовано; atomic visual behavior и скрытие discussion требуют проверки |
| Persistent provider profiles | Реализовано; restart cached status/probe policy отсутствует |
| Prompt lifecycle/finalization | Реализовано; лишние rounds воспроизводятся пользователем |
| Attachment staging/storage/delivery | Значительная часть реализована; live provider/response-file path неполны |
| CLI V1 approval/broker | Реализовано; host process не является Secure Runtime |
| Quality metrics/dashboard | Заявлено; пользователь видит пустой Quality Center, путь требует аудита |
| Theme/settings modal | Реализовано; light-theme contrast/backdrop defect не закрыт |

## Заявлено реализованным, но фактически не подтверждено

- стабильная authorization ChatGPT/Gemini после restart;
- Gemini login completion в текущем DOM;
- READY atomic final без intermediate rows;
- discussion trace как отдельный persistent UI;
- Quality Center с реальной activity после restart;
- все пять attachment formats у обоих providers;
- response file download → persistence → renderer card;
- automatic context rollover end-to-end;
- full current-SHA provider matrix.

Эти пункты получают `UNVERIFIED_MANUAL`, `PARTIAL` или `BLOCKED_BY_AUTH`, а не
`WORKS`/`DONE`.

## Новые требования владельца

1. Маленькие изменения без архитектурной самодеятельности.
2. Минимальные focused tests; не package/smoke после каждой мелочи.
3. Рабочие функции замораживаются после ручного подтверждения.
4. Semantic stopping и отсутствие пустых подтверждений.
5. READY_ANSWER и discussion — разные представления и persistence paths.
6. Cached auth status и ровно один безопасный background probe.
7. Theme исправляется через tokens/stacking evidence, не случайным цветом.
8. Quality Center показывает только реальные persisted events.
9. Импорт начинается с официальных exports; Web bulk — experimental.
10. Attachment capability truthfulness и полный traced pipeline.
11. Secure Code Runtime остаётся запрещённым текущим scope.
12. В Git отправляются только адекватные проверенные checkpoints; локальный мусор
    отсеивается до push.

## Что можно проверить и исправить локально без авторизации

- semantic stopping classifier/policy и orchestration regression;
- READY renderer filtering/buffering и discussion persistence на fixtures;
- auth state machine/cache/probe scheduling на fake adapters без live requests;
- theme tokens/modal stacking через local Electron fixtures;
- Quality Center repository/query/IPC/UI на локальной SQLite;
- import parser contract/fixtures/ADR без provider access;
- attachment staging/storage/dedupe/security fixtures;
- CLI V1 regression;
- docs/status consistency.

## Что требует ручной авторизации владельца

- реальный ChatGPT/Gemini login и restart persistence;
- один background auth probe каждого provider;
- «оба тут?» через реальные web sessions;
- READY/STREAMING live behavior;
- provider upload/download и conversation URL persistence;
- provider DOM/challenge/expired-session cases.

Live проверки выполняются коротко, последовательно и только после локального gate.

## Что требует отдельной ветки/ADR

- official export import и особенно Web UI bulk import;
- additive schema для большого нового persistence domain, если она затрагивает
  несколько подсистем;
- Secure Code Runtime / `G_PLUS_G_EXECUTION_V1`;
- platform sandbox backend;
- замена SQLite, Electron или provider automation architecture.

## Предлагаемый порядок минимальных изменений

1. **Закрыть текущий auth checkpoint.** Не смешивать его diff с orchestration.
   Владелец вручную подтверждает или отклоняет login completion.
2. **Semantic stopping.** Characterization «оба тут?» → минимальная policy → один
   focused regression → ручной provider smoke позже.
3. **READY_ANSWER.** Сначала characterization текущего renderer/store, затем скрытие
   intermediate rows и отдельный discussion view без изменения providers.
4. **Auth snapshot/probe.** Fake-adapter state-machine tests; затем один короткий
   restart UAT владельца.
5. **Theme.** Один воспроизводимый modal/section defect, tokens/stacking fix и один
   local visual checkpoint.
6. **Quality Center.** Trace producer→DB→query→IPC→UI; исправить только разрыв.
7. **Attachments.** Capability matrix и один формат/путь за checkpoint.
8. **Import.** Сначала ADR и official export fixtures в отдельной ветке.

## Блокер перед первым production checkpoint

Текущий worktree уже содержит незавершённый `src/gemini-adapter.ts`. До изменения
orchestration нельзя смешивать его с новым блоком. Нужен один из двух результатов:

- владелец подтверждает Gemini login → auth diff получает отдельный локальный commit;
- владелец отклоняет результат → auth diff точечно исправляется или откатывается по
  rollback archive.

Никакой push до этого решения не выполняется.
