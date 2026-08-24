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

## Local protected integration — 2026-08-09

This local test variant is based on `c562ade` with selected non-authentication
subsets from `337abb0` and documentation-only content from `aa0486e`.

| Command / check | Result | Boundary |
|---|---|---|
| `npm run check` | PASS | Build, desktop typecheck, 42 files and 192/192 tests. |
| focused attachment suites | PASS | 30/30 tests; local staging, preview and quarantine paths. |
| `npm run desktop:build` | PASS | Renderer and Electron production build. |
| auth-block comparison to `c562ade` | PASS | Provider login/status and adapter launch/login/session methods unchanged. |
| duplicate IPC scan | PASS | One imported duplicate `cliTasks:executors` handler was removed; no duplicate IPC channels remain. |
| `npm run package` | PASS | Windows NSIS artifact embeds runtime commit `54a03e7f586a8c57ce11e32537624868c1e3d97d`. |
| `npm run smoke:packaged` | PASS | First window, project/state/settings persistence, preflight, trusted origin, popup denial and backup; no provider calls. |
| installer SHA-256 | PASS | `C57C4A0EBE276471AB3DA33822CC161ED91D8A43ABF4786F6649FB771EA0683F`, 245,931,415 bytes. |
| live ChatGPT/Gemini login | `VERIFIED_USER` | Владелец подтвердил текущую авторизацию 2026-08-10. |
| live ChatGPT/Gemini message and attachment delivery | `UNVERIFIED_MANUAL` | Подтверждение входа не доказывает отправку сообщений или файлов. |

Explicitly excluded and frozen: provider login/session/status handling,
project-delete authentication calls, ChatGPT/Gemini adapter upload changes,
Settings/login UI, destructive migration 9, and the expanded destructive
project cascade. These exclusions are intentional, not missing verification.

## Owner-authorized login correction — 2026-08-09

The earlier auth freeze received a narrow explicit exception after premature
ChatGPT OAuth-window closure was reproduced by the owner.

| Command / check | Result | Boundary |
|---|---|---|
| auth-focused Vitest | PASS | 4 files / 20 tests: anonymous composer, pending OAuth page, explicit account control and no-auto-probe wiring. |
| `npm run check` | PASS | Build, desktop typecheck, 44 files and 197/197 tests. |
| ChatGPT/Gemini live login | `VERIFIED_USER` | Владелец подтвердил 2026-08-10: «сейчас авторизация работает». |

Текущий сценарий ручного входа подтверждён владельцем. Это evidence относится
только к авторизации; message delivery, attachments и restart probe им не
подтверждены.

## Phase B attachment lifecycle — 2026-08-24

| Command / check | Result | Boundary |
|---|---|---|
| focused attachment lifecycle/storage | PASS | 4 files, 26 tests. |
| renderer attachment boundary | PASS | No storage path, full SHA, provider URL or save target path in renderer DTO. |
| `npm run check` | PASS | 48 files, 210/210 tests. |
| `npm run test:security` | PASS | 3 files, 37/37 tests. |
| `npm run security:guard` | PASS | 91 production source files. |
| `npm run desktop:build` | PASS | Vite renderer and Electron TypeScript build. |
| `npm run package` | PASS | Windows unpacked app and NSIS installer. |
| packaged smoke | PASS | Temporary local profile; no provider login/live provider calls. |
| Phase B visual smoke | PASS | Draft restart recovery, safe DTO, integrity preview, text input and light/dark screenshots. |
| Markdown/code-fence zero-job guard | PASS | Ordinary fenced code creates zero execution jobs. |

Provider upload behavior was not exercised or modified; it remains the explicit Phase C gate.

## Phase B.1 UI polish — 2026-08-24

| Check | Result |
|---|---|
| Settings/ready-answer/UI contract focused tests | PASS |
| PNG/JPEG/WebP and wide/tall canvas fixtures | PASS |
| Four thumbnails, wrapping/bounds and removal | PASS |
| Preview 90vw/90vh, Escape/backdrop/button close | PASS |
| Right drawer with seven long turns | PASS |
| Fullscreen mode and persisted setting | PASS |
| Narrow 700 px window automatic fullscreen | PASS |
| Light/dark and 100/125/150% visual scaling | PASS |

No provider adapter or orchestration source was changed in Phase B.1.

## Phase B.1 real visual acceptance gate — 2026-08-24

Evidence root: `output/playwright/phase-b1-real-gate/` (ignored generated
artifacts). Machine-readable scenario details are in
`visual-gate-report.json`; each PNG is a native Win32 full-window capture with
the Electron title/menu frame. The capture helper is per-monitor DPI-aware.

| Check | Result | Evidence |
|---|---|---|
| Production clipboard route | PASS | Seven detailed `File` payloads dispatched through the composer paste handler, preload IPC and managed staging store. |
| Original bytes/dimensions | PASS | 1920x1080, 2560x1440, 3840x2160, 1080x1920, 3440x1440 PNG; 2400x1600 JPEG; 1920x1080 WebP. Preview natural dimensions equal sources; 4K source remains 6,533,978 bytes. |
| Composer geometry | PASS | Cards <=88x88, strip/composer containment, no document horizontal overflow, remove controls contained, textarea/send fully visible. |
| Theme/window/DPI matrix | PASS | 18 native screenshots: light/dark x 1280x720, 1366x768, 1920x1080 x Electron DPI factors 100/125/150%; page zoom factor asserted at 1.0. Host Windows display scale was 150%. |
| Middle removal/reflow | PASS | Six-card row compacts into the removed fourth card's former position. |
| Preview modal | PASS | Viewport-contained 90vw/90vh preview; Escape, backdrop and close-button exits verified. |
| Discussion views | PASS | Long Russian seven-turn chronology in right drawer, fullscreen, and 700x760 narrow fullscreen. |
| Manual visual review | PASS | All 23 full-window PNGs reviewed after automated assertions; no clipping, app overflow, other-app contamination or expanded inline original. |
| `npm run check` | PASS | 49 files, 213/213 tests. |
| `npm run test:security` / `npm run security:guard` | PASS | 37/37 focused tests; 91 production files scanned. |
| `npm run package` / `npm run smoke:packaged` | PASS | Windows unpacked app and NSIS installer rebuilt; packaged smoke passed without provider calls. |

The gate exposed and fixed a flex minimum-size defect that could push the
composer below the visible workspace for long transcript content. The output
pane now has an explicit zero flex minimum, and a large attachment set scrolls
inside a bounded 144 px strip. Provider adapters and orchestration were not
changed. Phase C and the deferred Phase C.1 prompt lifecycle were not started.
