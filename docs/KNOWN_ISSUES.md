# Known issues

| Status | Severity | Issue | Reproduction / evidence | Workaround / next owner |
|---|---:|---|---|---|
| BLOCKED | P0 | Branch protections/rulesets are unavailable for this private repository plan. | GitHub API returns HTTP 403 requiring Pro or public visibility. | Upgrade to GitHub Pro; do not make the private repository public merely for protections. |
| CONFIRMED | P1 | No remote tags or GitHub releases exist, while the package is `0.1.0-beta.1`. | GitHub refs/releases and `package.json`. | Release owner establishes provenance before tagging. |
| CONFIRMED | P1 | The only GitHub Actions run (`CI / quality`) failed. | Run on `prod@489303b`. | Observe a green cleanup workflow and its exact context before making a check required. |
| CONFIRMED | P2 | `npm audit` reports three high findings in dev/build dependencies. | 2026-08-08: `fast-uri@3.1.4` via electron-builder/ajv, `js-yaml@4.3.0` via electron-builder, `nanoid@3.3.16` via Vite/PostCSS. `npm audit --omit=dev` reports 0. | Separate lockfile-only dependency PR targeting `fast-uri>=3.1.5`, `js-yaml>=4.3.1`, `nanoid>=3.3.17`; no major update indicated. |
| PLANNED | P1 | Release-only provider UI matrix and 8–12 hour soak are not automated. | `docs/testing.md` and this cleanup's test evidence. | Release/UAT owner executes the closed profile before promotion. |
| BLOCKED | P1 | Anthropic is generic-web exploratory only; OpenRouter is not implemented. | Provider registry and release runbook review. | Do not mark either provider PASS without implementation and security review. |
