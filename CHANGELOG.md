# Changelog

All notable project checkpoints are recorded here.

## [0.1.0-pre.6] - 2026-07-31

### Fixed

- Development Electron and CLI runs now resolve the project-local Playwright
  Chromium instead of incorrectly requiring `%LOCALAPPDATA%\ms-playwright`.
- Browser discovery chooses the newest available Chromium revision and still
  supports packaged Electron resources.

### Added

- Explicit per-provider «Выйти» controls in the desktop sidebar.
- Confirmed logout removes only the selected local browser session and preserves projects.
- Regression tests for local browser discovery and packaged logout controls.

### Verification

- 51 automated tests.
- Development preflight resolves the exact project-local Chromium executable.

## [0.1.0-pre.5] - 2026-07-31

### Added

- Local 30-day Quality Center in profile settings.
- Per-provider success rate, average latency, turn count, and retry indicators.
- Traffic-light provider health scoring and overall metric cards.
- Orchestration-level success and elapsed-time measurements.
- Safe packaged IPC access to aggregate metrics without message content.

### Verification

- 49 automated tests, including provider-tag aggregation and reporting-window validation.
- Packaged smoke coverage for the Quality Center UI and API.

## [0.1.0-pre.4] - 2026-07-31

### Added

- Visual Project State constructor for requirements, constraints, decisions,
  rejected options, open questions, and acceptance criteria.
- Decision rationale fields and response-source traceability chips.
- Draft version/status summary, populated-item counter, and collapsible sections.
- Advanced JSON mode synchronized with the guided editor.
- Packaged smoke coverage that persists and reloads a visually authored specification.

### Changed

- Replaced the raw-JSON-first inspector with a task-specification workflow.
- Updated project documentation to reflect the current desktop product.

### Verification

- TypeScript, Electron renderer, and 48 automated tests.
- Packaged UI persistence and SQLite round-trip test.

## [0.1.0-pre.3] - 2026-07-30

### Added

- Desktop «Диагностика и данные» section in profile settings.
- In-app environment checks with explicit pass, warning, and failure results.
- In-app WAL-consistent backup creation with browser credentials excluded.
- Data-folder access and individually confirmed ChatGPT/Gemini session reset.
- Packaged smoke coverage for release metadata and backup creation.

### Fixed

- Backup creation now creates a missing destination hierarchy safely.
- Release metadata lookup now works both from source and packaged `app.asar`.
- Maintenance operations are blocked while a provider or orchestration run is active.

### Verification

- 47 automated tests plus packaged Electron smoke test.
- Backup manifest existence and packaged browser availability verified.

## [0.1.0-pre.2] - 2026-07-30

### Added

- Persistent profile and settings screen with theme, density, scale, provider, mode, and orchestration defaults.
- Quality metrics stored in SQLite for attempts, latency, failures, and orchestration outcomes.
- WAL-consistent backup, validation, restore, release-info, and preflight commands.
- Packaged-app smoke test and self-contained Playwright Chromium in Windows builds.
- Automatic recovery of interrupted runs after an unclean shutdown.

### Security

- Renderer navigation is pinned to the trusted `app://bundle` origin.
- New windows are denied and only validated HTTP(S) links may open externally.
- Every privileged IPC handler validates its sender and validates input size/type.
- Logs rotate and redact credentials, tokens, JWT-like values, and secret query parameters.

### Fixed

- Parallel runs now persist a successful provider response if the other provider fails.
- Stop remains `STOPPED` instead of being overwritten by `FAILED`.
- Session timeout is enforced in manual and parallel modes too.
- Concurrent provider operations and orchestration runs are rejected.
- Application shutdown closes active provider browsers.
- Project activity only exposes events belonging to the opened project.
- Packaged builds no longer depend on a system-installed browser.

### Verification

- TypeScript, renderer, Electron, migration, settings, metrics, backup, security, and orchestration tests.
- Preflight validates the data path, runtime, Playwright module, and browser availability.
- Windows NSIS installer and unpacked application smoke-tested before tagging.

## [0.1.0-pre.1] - 2026-07-30

### Added

- Shared OS-specific data root for desktop and CLI.
- Redacted JSONL application logging and diagnostic reports.
- Persistent provider Conversation, Turn, Attempt, and Message records.
- Manual relay editing in the desktop UI.
- User confirmation checkpoints for bounded discussions.
- Project State, decisions, open questions, transcript, verification, and manifest exports.
- Implementation status documentation and observability tests.

### Fixed

- Provider login and send failures now create diagnostics.
- Provider response capture waits for the submitted user message to appear.
- Export now reads the real persistent orchestration transcript.
- Desktop polling no longer interrupts active turns.
- Stop no longer creates a transient RUNNING state.
- Packaged Chromium lookup no longer relies on a hard-coded revision.

### Verification

- TypeScript build passed.
- Desktop typecheck passed.
- 34 Vitest tests passed.
- Vite/Electron desktop build passed.
