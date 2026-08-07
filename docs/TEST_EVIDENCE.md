# Test evidence

Environment: Windows, Node 22.20.0, npm 11.16.0, lockfile v3.
Cleanup SHA: `849f177`. Integration merge SHA: `e4723bf`.

| Phase | Command | Result | Notes |
|---|---|---|---|
| Baseline | `npm ci` | PASS | 482 packages installed; npm reported two high-severity findings. |
| Baseline | `npm run check` | FAIL | `src/release/release-tools.ts` was omitted by the broad `release/` ignore rule. |
| Cleanup | `npm test -- --runInBand` | INVALID | Vitest does not support this Jest flag; no tests ran. |
| Cleanup | `npm run test:security` | PASS | 3 files, 30 security-focused tests passed. |
| Cleanup | `npm run check` | PASS | Build, renderer/Electron typecheck, 41 files and 160 tests passed. |
| Cleanup | `npm run desktop:build` | PASS | Vite production renderer and Electron TypeScript build completed. |
| Cleanup | `npm run security:guard` | PASS | Production source scan passed. |
| Cleanup | `npm run package` | PASS | Windows unpacked app and NSIS installer built. |
| Cleanup | `npm run smoke:packaged` | PASS | Project creation, state/settings persistence, preload API, preflight, trusted origin, popup denial and backup passed. Unsafe terminal/TwoTier APIs were absent. |
| Cleanup | interactive Electron QA | NOT RUN | Live provider UI remains release-only. |
| Release-only | provider matrix and 8–12 hour soak | BLOCKED | Requires closed authenticated profiles and release artifact. |
| Integration 2026-08-08 | `npm ci` | PASS | 482 packages; dependency tree unchanged by cleanup. |
| Integration 2026-08-08 | `npm run security:guard` | PASS | 82 production source files. |
| Integration 2026-08-08 | `npm run test:security` | PASS | 30/30 tests. |
| Integration 2026-08-08 | `npm run check` | PASS | 41 files, 160/160 tests. |
| Integration 2026-08-08 | `npm run desktop:build` | PASS | Vite renderer and Electron TypeScript build. |
| Integration 2026-08-08 | `npm audit` | FINDING | Three high findings, all dev/build-only. |
| Integration 2026-08-08 | `npm audit --omit=dev` | PASS | Zero production findings. |
| Integration 2026-08-08 | `npm run package` at `36191d2` | PASS | Build-info contains full runtime-tested SHA; installer SHA-256 `59F6E8E5EB2EAF10B80F3572B103C5E5E0E7211A6CA964FA95300AC537F25BAF`. |
| Integration 2026-08-08 | `npm run smoke:packaged` at `36191d2` | PASS | Persistence, unsafe-API absence, trusted origin, popup denial, preflight and backup passed. |
| Integration 2026-08-08 | `git diff --check` and production zero-hit scan | PASS | No forbidden task/personal-path production hits. |
| GitHub PR #2 | `CI / verify` at `36191d2` | PASS | `npm ci`, guard, check and desktop build completed in Actions run `31222824762`. |

This evidence-update commit changes documentation only. A release candidate is
not frozen until PR review/UAT selects an exact `uat` SHA and rebuilds it per
`docs/UAT_RUNBOOK.md`. Do not treat historical claims as evidence for that SHA.
