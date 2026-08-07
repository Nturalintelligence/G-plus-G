# Decisions

## Cleanup scope

- **CONFIRMED:** Remove the complete Snake vertical slice and task-specific
  generated artifacts.
- **CONFIRMED:** Keep legitimate ChatGPT and Gemini provider adapters.
- **CONFIRMED:** Only `G_PLUS_G_CLI_TASK_V1` is recognized as a CLI proposal.
  Markdown fences, legacy tags, trigger words, and prose never authorize work.
- **CONFIRMED:** Every new CLI proposal requires explicit approval. Model fields
  cannot waive policy.
- **CONFIRMED:** Remove the renderer terminal and TwoTier execution bridges;
  they bypassed the durable FSM and approval service.
- **REJECTED:** Retaining command strings or `cmd /c` for compatibility. Process
  execution must use an executable plus argv with the shell disabled.
- **CONFIRMED:** Verification commands come from an exact read-only registry;
  currently only `git diff --check` and `git status --porcelain` are accepted.
- **CONFIRMED:** Actual filesystem changes are compared before/after execution
  and must remain inside `allowedPaths` and outside `forbiddenPaths`.
- **CONFIRMED:** Desktop CLI execution uses a managed application-data workspace,
  never the launcher's current working directory.
- **CONFIRMED:** On 2026-08-08 the owner approved a one-time atomic non-force
  fast-forward of `main` and `uat` to deployed `prod@489303b`; `prod` remains a
  rollback ref and is no longer a parallel development target.
- **CONFIRMED:** Integrate cleanup by a merge commit from preserved `849f177`
  into a new branch based on synchronized `uat`; do not rewrite its history.
- **CONFIRMED:** Keep dependency remediation in a separate lockfile PR because
  all three current high advisories are dev/build-only and production audit is 0.
- **PLANNED:** `G_PLUS_G_EXECUTION_V1` and sandboxed code execution belong to
  separate architecture and implementation PRs.
