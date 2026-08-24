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

## Phase B.1 real visual acceptance gate — 2026-08-24 (SUPERSEDED)

This result was rejected after owner evidence showed that its assertions did
not enforce the final 72x72 closed-DOM contract or a body-level preview portal.
Do not use this section as release evidence; the corrective gate below replaces
it.

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

## Phase B.1 attachment renderer corrective gate — 2026-08-24

The same packaged Electron regression test was run before and after the
production renderer change. Before the change it failed with an actual card
bounding box of 64x64 (`left=317, top=537, right=381, bottom=601`). Assertions
were then held at the owner-specified values.

The immutable owner fixture is
`tests/fixtures/user-regression-screenshot.png`: 1912x1199, 433,245 bytes,
SHA-256 `07898756903D65C5DB9DF607CE68E2F9B39C562310C0F78C40AE1E9F1640E30B`.
It is tested with separate 1920x1080 and 3840x2160 screenshots. All three enter
the production composer through the Electron system clipboard and `Ctrl+V`.

| Check | Result | Evidence |
|---|---|---|
| Closed composer DOM | PASS | Exactly three attachment preview images, all inside `.attachment-thumbnail`; no modal preview image remains in DOM. |
| Exact cards | PASS | At 1920x1080/zoom 1: `(317,959)-(389,1031)`, `(397,959)-(469,1031)`, `(477,959)-(549,1031)`; all exactly 72x72 CSS px. |
| Strip bounds | PASS | 1566x74 CSS px; every card and 22x22 remove control remains inside the strip/card. |
| Workspace overflow | PASS | `documentElement.scrollWidth=1920`, `clientWidth=1920`. |
| Portal preview | PASS | Backdrop is a fixed `inset: 0` direct child of `document.body`; one original is bounded by 90vw/90vh. Escape, backdrop and close button remove it. |
| Closed-after-preview | PASS | Three 72x72 cards remain; no modal image in DOM; `scrollWidth=clientWidth=1898` for the captured client area. |
| Transcript attachments | PASS | Three sent screenshots render as compact cards with 38x38 thumbnail images; no document overflow. |
| Native screenshots | PASS | Full 1920x1080 Electron window including system frame before preview, during preview, after preview, and with transcript cards. Effective per-window DPI is recorded in `visual-gate-report.json`. |
| `npm run check` | PASS | 49 files, 213/213 tests. |
| Security / package | PASS | 37/37 security tests, source guard, Electron package and packaged smoke. |

Production changes are limited to renderer layout, compact attachment rendering,
the body portal preview and the regression fixture/test. Phase C and Phase C.1
were not started.

## Phase B.1 anchored remove-control gate — 2026-08-24

The owner-provided failing screenshot is retained as
`tests/fixtures/remove-controls-regression.png` (472x43, 7,509 bytes, SHA-256
`4CB200084E2D14F1F4F10CE15085B5E9CCA07C39CF4B752C6ACB96C599A49B55`).
It records the remove controls escaping their cards before this production CSS
correction.

| Check | Result | Evidence |
|---|---|---|
| Positioning context | PASS | Every composer image/document uses its own relative, clipped `.attachment-card`; `.attachment-remove` is the only shared remove-control class. |
| Exact remove geometry | PASS | Every button is 24x24 CSS px with top/right offsets of exactly 4 px; no transforms, negative margins, percentages or natural-image dimensions participate. |
| Three fullscreen PNG | PASS | 1912x1199 owner fixture, 1920x1080 and 3840x2160 enter the packaged production composer through system clipboard + Ctrl+V and remain three 72x72 cards. |
| Mixed wrapping | PASS | PNG + PDF + two long-Unicode MD cards wrap at 1280x720. Document cards are 320x58; image cards are 72x72; all controls remain inside their own card and outside neighbors. |
| Hover/focus and deletion | PASS | Focus/hover geometry is unchanged. First, middle and last controls remove only their card; remaining cards reflow into stable strip-relative slots. |
| Theme/window/DPI matrix | PASS | Light/dark; 1280x720, 1366x768, 1920x1080; forced Electron scale 100/125/150%; zoom factor exactly 1. Host effective window DPI is recorded by native capture. |
| Closed 1920x1080 geometry | PASS | Cards `(317,889)-(389,961)`, `(397,889)-(469,961)`, `(477,889)-(549,961)`; controls `(361,893)-(385,917)`, `(441,893)-(465,917)`, `(521,893)-(545,917)`. |
| Workspace containment | PASS | Closed 1920 capture reports `scrollWidth=clientWidth=1898`; no attachment image outside composer thumbnail, transcript card, or active body portal. |
| Transcript cards | PASS | Three documents are capped at 320x50; three images use 320x56 cards with 38x38 thumbnails. Long Unicode names do not widen the transcript. |
| Native visual review | PASS | 25 full-window Win32 captures reviewed, including closed/open/closed preview, mixed wrap/focus, compact transcript, right drawer, fullscreen and narrow fullscreen. |
| Build/test/security/package | PASS | `npm run check`: 49 files, 213/213; security: 37/37; source guard: 91 production files; NSIS/unpacked build and packaged smoke pass. |

Machine-readable bounding boxes and native screenshot paths are in
`output/playwright/phase-b1-real-gate/visual-gate-report.json` (generated,
ignored evidence). No live provider UAT was run.

## Crash-safe per-project composer draft — 2026-08-24

| Check | Result | Evidence |
|---|---|---|
| SQLite migration/reopen | PASS | Migration 10 stores one project-keyed row; repository reopen restores every field and preserves de-duplicated id order. |
| Project isolation | PASS | Clearing project A leaves project B's text/order/settings unchanged. |
| Renderer debounce | PASS | Packaged renderer edit reached SQLite through trusted IPC before forced process termination. |
| Forced crash/restart | PASS | Same packaged data root restored text, two ordered Unicode image attachments, mode, continuation policy, starter, participants, view, finalizer, final responder and expanded state. |
| No automatic work | PASS | After recovery, `orchestration_runs=0` and `provider_submissions=0`; no send/retry occurs. |
| Submission lifecycle | PASS | Snapshot is saved before UI clearing, retained/restored on failure, and cleared only after successful orchestration return. |
| `npm run check` | PASS | 50 test files, 216/216 tests. |
| Security | PASS | 37/37 focused tests; source guard passed across 92 production files. |
| Package/crash smoke | PASS | Windows unpacked app and NSIS installer rebuilt; `npm run smoke:composer-draft` passed after a forced main-process kill. |

No live provider UAT was run in this phase.
