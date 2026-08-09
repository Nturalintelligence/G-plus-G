# G+G AI handoff

## Главное правило сопровождения

Если функция работает в проверенной сборке, не менять её логику, селекторы,
тайминги или жизненный цикл «заодно». Изменение допустимо только при наличии
воспроизводимого дефекта или прямого требования владельца и обязательно должно
получить отдельный регрессионный тест. Смежный рефакторинг обязан сохранять уже
подтверждённое поведение без изменений.

## Goal

Stabilize the 0.1 base application after the completed Snake cleanup, without
starting the experimental protocol router or Secure Code Runtime.

## Current state

- **CONFIRMED:** cleanup branch `fix/remove-snake-artifacts` was created from
  GitHub `cli-fix` SHA `4dd3fde7c1dad428491c3f06eb5c816f5827998e`.
- **CONFIRMED:** the renderer terminal and TwoTier command-string execution
  bridges were removed. CLI proposals now remain behind the TaskCompiler,
  persistent FSM, and explicit approval boundary.
- **CONFIRMED:** Snake output, live Snake generator, duplicate repair assets,
  and empty design prototypes were removed.
- **CONFIRMED:** `G_PLUS_G_EXECUTION_V1` is a proposal only and is not part of
  this cleanup.
- **CONFIRMED:** GitHub CLI access works. On 2026-08-08 the owner approved an
  atomic non-force migration: `main`, `uat`, and retained rollback ref `prod`
  now point to production SHA `489303b`.
- **CONFIRMED:** cleanup checkpoint `849f177` was merged without rebase or
  cherry-pick into `agent/integrate-cleanup-into-uat`; merge SHA `e4723bf`.
- **CONFIRMED:** no remote tags or releases exist; draft PR #1 is stale.
- **CONFIRMED:** draft PR #2 targets `uat`; runtime-tested head `36191d2`
  passed local packaging/smoke and GitHub `CI / verify`.
- **CONFIRMED:** PR #2 was merged into `uat` as `b215a5e`; all base fixes are
  being developed on `fix/core-functionality-0.1`.
- **IMPLEMENTED:** attachment staging/storage/provider-delivery safety,
  explicit finalization and READY/STREAMING separation, prompt lifecycle,
  project/settings corrections, and project-scoped CLI V1 controls.
- **TESTED:** current local gate passes build, Electron typecheck, 42 files / 192
  tests, 37 security tests, and the 86-file production source guard.
- **BLOCKED_BY_AUTH:** current-SHA ChatGPT/Gemini text, attachment, response-file,
  conversation-reopen and orchestration smoke remains manual.
- **BLOCKED:** GitHub returns HTTP 403 for branch protection and rulesets on the
  current private-repository plan. GitHub Pro is required for enforcement.
- **PLANNED:** release-only provider UI tests and the 8–12 hour soak profile
  remain outside normal PR CI.

## Next step

Build and hash the SHA-bound test installer, publish a draft fix PR to `uat`,
then let the user install and manually authenticate the isolated ChatGPT and
Gemini profiles. Run only the short smoke in `docs/FEATURE_MATRIX.md`; do not
start the experimental branch or full soak before the base provider gate.
