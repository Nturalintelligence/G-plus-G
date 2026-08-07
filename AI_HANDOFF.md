# G+G AI handoff

## Goal

Remove task-specific Snake artifacts and restore the rule that only a validated
`G_PLUS_G_CLI_TASK_V1` envelope can enter approval and execution.

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
- **BLOCKED:** GitHub returns HTTP 403 for branch protection and rulesets on the
  current private-repository plan. GitHub Pro is required for enforcement.
- **PLANNED:** release-only provider UI tests and the 8–12 hour soak profile
  remain outside normal PR CI.

## Next step

Finish SHA-bound packaging/evidence, push the integration branch, and open a
draft PR to `uat`. Do not merge until closed provider UAT and release soak pass.
