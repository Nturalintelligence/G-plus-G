# G+G AI handoff

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

## Local protected integration (2026-08-09)

The only working copy is `C:\Users\onadl\OneDrive\Рабочий стол\G-plus-G`.
It remains based on `c562ade` and contains only verified, non-authentication
subsets selected from `337abb0`, plus documentation from `aa0486e`.

The following areas are deliberately frozen and were not imported: provider
login/session/status handling, project-delete authentication calls, ChatGPT and
Gemini adapter upload changes, Settings/login UI, destructive migration 9, and
the expanded destructive project cascade. Automated evidence for the local
variant is 42 test files / 192 tests plus a successful desktop production build.
Live provider login and delivery remain manual owner UAT, not an automated PASS.

## Next step

Build and hash a test artifact from the local protected variant, then let the
owner run the short manual smoke in `docs/FEATURE_MATRIX.md`. Do not publish or
merge this variant, change authentication, start the experimental branch, or
run the full soak before the owner confirms the local provider gate.
