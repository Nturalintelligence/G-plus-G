# Git workflow

Target state: `main` is the only production branch and `uat` is the integration
branch for the next release candidate.

1. Create `feature/*`, `fix/*`, or `chore/*` from current `main`.
2. Run local gates and open a PR into `uat`; require review, CI, resolved
   threads, and squash merge.
3. Freeze an exact `uat` SHA, build the RC, and run heavy UAT on that artifact.
4. Promote the unchanged composition through `uat -> main`, tag `vX.Y.Z`, run
   production smoke, then synchronize `main -> uat`.

Hotfixes flow from `main` or a production tag through `hotfix/*`, checks, `main`,
patch tag, then back to `uat`.

For `main` and `uat`, configure PR-only changes, required checks, stale approval
reset, resolved threads, CODEOWNERS, and blocked force-push/deletion.

## Migration record (2026-08-08)

- The owner confirmed `prod@489303b` as the production source.
- `main` and `uat` were atomically non-force fast-forwarded to exact SHA
  `489303b`; `prod` remains unchanged as a rollback ref.
- Cleanup checkpoint `849f177` was preserved as local backup ref
  `backup/cleanup-849f177` and merged with `--no-ff` into a new branch based on
  synchronized `uat`. Merge SHA: `e4723bf`.
- Three conflicts were resolved explicitly: cleanup CI retained; unsafe TwoTier
  bridge deletion retained; the tested checksum/rollback-capable release tools
  retained.

Promotion remains `uat -> main` by PR. `prod` must not receive new production
work and must not be deleted until a later audited deprecation decision.
Protections/rulesets remain unavailable on the current private-repository plan
(GitHub API HTTP 403); governance is advisory until GitHub Pro is enabled.
