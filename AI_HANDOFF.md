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
- **CONFIRMED:** GitHub CLI access works. The private repository defaults to
  `main`; production evidence is `prod@489303b`, `uat@b7615cf` is its ancestor,
  and the only PR is stale draft PR #1. No remote tags or releases exist.
- **BLOCKED:** GitHub returns HTTP 403 for branch protection and rulesets on the
  current private-repository plan. GitHub Pro is required for enforcement.
- **PLANNED:** release-only provider UI tests and the 8–12 hour soak profile
  remain outside normal PR CI.

## Next step

Confirm that `prod@489303b` is the deployed source and authorize the proposed
non-force `main`/`uat` migration. Then integrate this cleanup from a new branch
based on the synchronized `uat`; do not cherry-pick it without its 30 `cli-fix`
prerequisite commits.
