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
| Core fix 2026-08-08 | `npm run check` | PASS | Runtime code SHA `337abb01fd0c`; TypeScript, Electron typecheck, 42 files and 192/192 tests. |
| Core fix 2026-08-08 | focused attachment/orchestration tests | PASS | 8 files, 58/58 tests. |
| Core fix 2026-08-08 | `npm run test:security` | PASS | 3 files, 37/37 tests. No host CLI was executed. |
| Core fix 2026-08-08 | `npm run security:guard` | PASS | 86 production source files scanned. |
| Core fix 2026-08-08 | `git diff --check` and production zero-hit scan | PASS | Only Git line-ending advisories; zero Snake/personal-path/experimental-runtime hits. |
| Core fix 2026-08-08 | `npm run package` | PASS | NSIS x64 installer embeds runtime commit `337abb01fd0cfd559102becfc93e238bd59e1ced`. |
| Core fix 2026-08-08 | packaged smoke | PASS | Explicit `G_PLUS_G_SKIP_PROVIDER_STATUS=1`; temporary profile, no provider/network probe. Project/state/settings, trusted origin, unsafe API absence, popup denial, preflight, quality dashboard and backup passed. |
| Core fix 2026-08-08 | installer SHA-256 | PASS | `FE3E6C74BDB949DBED82054761F81754F52F62F3272094E54E86A1462848B717`, 245,930,241 bytes. |
| Core fix 2026-08-08 | live ChatGPT/Gemini smoke | BLOCKED_BY_AUTH | Requires user installation and manual login in the two isolated profiles. |

The packaged test artifact is bound to runtime code SHA `337abb01fd0c`; later
documentation-only commits do not alter its executable contents. This is not a
frozen release candidate until the short authenticated provider smoke passes.
The full release soak remains deferred until feature freeze.
