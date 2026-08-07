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

## Current migration state

- GitHub default is `main@b876b38`, the initial commit.
- Factual production evidence is `prod@489303b`; `main...prod = 0/45`.
- `uat@b7615cf` is a strict ancestor of `prod`; `prod...uat = 2/0`.
- Cleanup starts at `cli-fix@4dd3fde`; `uat...cli-fix = 1/30`.

After the owner confirms `prod@489303b` is deployed, the recommended one-time
migration is a non-force exact-SHA fast-forward of `main` and then `uat` to
`489303b`. Keep `prod` as a rollback ref. Create a fresh integration branch from
the updated `uat`, merge the cleanup branch without rebase/reset/force, run all
gates, and open a draft PR to `uat`. Promotion remains `uat -> main` by PR.

No such ref mutation has been performed. Protections/rulesets cannot be enabled
on the current private-repository plan (GitHub API HTTP 403); upgrade to GitHub
Pro before treating governance checks as enforced.
