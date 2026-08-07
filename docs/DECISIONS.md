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
- **PLANNED:** After deployed-SHA confirmation, migrate `prod@489303b` to `main`
  and `uat` by non-force fast-forward as a documented one-time exception.
- **PLANNED:** `G_PLUS_G_EXECUTION_V1` and sandboxed code execution belong to
  separate architecture and implementation PRs.
