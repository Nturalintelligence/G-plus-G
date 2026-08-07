# Known issues

| Status | Severity | Issue | Reproduction / evidence | Workaround / next owner |
|---|---:|---|---|---|
| BLOCKED | P0 | Production default-branch migration is unconfirmed. | GitHub `main@b876b38` is 45 commits behind `prod@489303b`. | Confirm deployed SHA, then authorize exact non-force migration; keep `prod` for rollback. |
| BLOCKED | P0 | Branch protections/rulesets are unavailable for this private repository plan. | GitHub API returns HTTP 403 requiring Pro or public visibility. | Upgrade to GitHub Pro; do not make the private repository public merely for protections. |
| CONFIRMED | P1 | `uat` is two commits behind `prod`; cleanup is based on divergent `cli-fix`. | `prod...uat = 2/0`; `uat...cli-fix = 1/30`. | Synchronize production baseline, then merge cleanup on a new integration branch. |
| CONFIRMED | P1 | No remote tags or GitHub releases exist, while the package is `0.1.0-beta.1`. | GitHub refs/releases and `package.json`. | Release owner establishes provenance before tagging. |
| CONFIRMED | P1 | The only GitHub Actions run (`CI / quality`) failed. | Run on `prod@489303b`. | Observe a green cleanup workflow and its exact context before making a check required. |
| CONFIRMED | P1 | `npm audit` reports two high-severity dependency findings. | Clean `npm ci` on 2026-08-07. | Review in a separate dependency/security PR; do not mix upgrades into cleanup. |
| PLANNED | P1 | Release-only provider UI matrix and 8–12 hour soak are not automated. | `docs/testing.md` and this cleanup's test evidence. | Release/UAT owner executes the closed profile before promotion. |
| BLOCKED | P1 | Anthropic is generic-web exploratory only; OpenRouter is not implemented. | Provider registry and release runbook review. | Do not mark either provider PASS without implementation and security review. |
