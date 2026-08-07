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

Packaging, packaged smoke, zero-hit scan and diff check must be rerun after the
evidence update to freeze the final PR-head SHA. Do not treat historical claims
in other documents as evidence for that SHA.
