# Roadmap

- **CONFIRMED:** complete Snake/legacy execution cleanup and regression gates.
- **CONFIRMED:** `main`/`uat` migrated non-destructively to production
  `489303b`; cleanup integrated on a dedicated PR branch.
- **IMPLEMENTED:** cleanup PR #2 merged to `uat`; base 0.1 attachment,
  orchestration, prompt, desktop and CLI V1 fixes are isolated on
  `fix/core-functionality-0.1` and locally packaged at runtime SHA `337abb01fd0c`.
- **BLOCKED_BY_AUTH:** run the short ChatGPT/Gemini provider matrix against the
  packaged test installer before declaring feature freeze.
- **PLANNED:** upgrade the private repository plan for protections, establish
  release provenance, and collect closed UAT evidence.
- **PLANNED:** design-only recognition/schema/UI phase for
  `G_PLUS_G_EXECUTION_V1`.
- **PLANNED:** isolated Python/Node runtime only after platform, sandbox backend,
  approval, capabilities, and residual-risk decisions are approved.

No Secure Code Runtime implementation belongs in the cleanup PR.
