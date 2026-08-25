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

The following areas were deliberately excluded from the earlier import:
provider login/session/status handling, project-delete authentication calls,
ChatGPT and Gemini adapter upload changes, Settings/login UI, destructive
migration 9, and the expanded destructive project cascade. That exclusion was
superseded only for the narrow login defect described below; upload and the
remaining destructive/settings areas stay frozen.
Runtime checkpoint `54a03e7` also removes the duplicate
`cliTasks:executors` registration that prevented the packaged main process from
creating its first window. The rebuilt installer and isolated packaged smoke
both pass; see `docs/TEST_EVIDENCE.md` for the artifact hash.

## Owner-authorized login correction (2026-08-09)

After the owner reproduced premature OAuth-window closure, the login freeze
received an explicit narrow exception. The confirmed observations were an early
window close and an incorrect authenticated result; the exact transient DOM
sequence was not proven and must not be presented as a confirmed root cause.

Passive provider probes at application startup and after login/reset were also
removed. On 2026-08-10 the owner confirmed that authorization currently works.
Status: `VERIFIED_USER`, `FROZEN`. This does not verify provider messaging,
attachments, response files or restart probing.

## Next step

Do not change authorization again without a new reproducible defect and direct
owner command. Continue the remaining base fixes as isolated local checkpoints;
do not start the experimental runtime or full soak.
# Phase C.1 handoff — 2026-08-24

- Production orchestration now emits one `ProviderTurnEnvelopeV1` through one
  adapter `sendMessage` call for each provider turn. Bootstrap, current task,
  peer/candidates, attachment references and continuation instructions share
  that atomic message.
- Migration 11 persists protocol version/hash/text/initialization/checkpoint by
  provider conversation. Successful completion advances state; failed or
  unknown turns do not.
- Reused conversations omit the base protocol; changed identities emit a short
  bounded delta. Projects and ChatGPT/Gemini conversations remain independent.
- No authenticated provider profile was opened. Live UAT remains owner-gated.
- Next authorized phase: Phase D response-file retrieval. Do not touch
  `experimental` or its runtime/stash.
# Phase D handoff — 2026-08-24

- ChatGPT/Gemini production adapters now inspect only the last bound assistant
  response and retrieve HTTPS links or explicit download controls through the
  existing authenticated Playwright context.
- Every direct URL/redirect/DNS hop remains allowlisted and SSRF checked.
  Download-event streams support validated provider-origin blob URLs. Bytes are
  bounded, MIME-sniffed, SHA-256 recorded and stored below the managed artifact
  root. Signed URL query/fragment data is not persisted.
- Migration 12 records filename/MIME/size and binds each result to the exact
  assistant transcript entry generated before submission. Renderer cards expose
  compact preview/open and explicit Save As; failed/quarantined results are not
  opened.
- Local tests/build only. Real provider controls/URLs remain
  `BLOCKED_BY_AUTH`; do not run live UAT without owner confirmation.
- Branch is intended to be pushed for continuation from another computer.

# Semantic stopping checkpoint — 2026-08-25

- Explicit trivial prompts (`тест`, presence checks, greetings and simple
  arithmetic) are capped at one discussion turn per selected provider followed
  by final synthesis. A two-provider `тест` run therefore has two discussion
  turns, not seven.
- Classification is deliberately conservative: attachments, implementation
  requests and all non-whitelisted short prompts keep the configured budget.
- This is locally tested only. Visible provider-message count remains part of
  the owner-gated live UAT.
