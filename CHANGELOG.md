# Changelog

All notable project checkpoints are recorded here.

## [0.1.0-pre.9] - 2026-07-31

### Added

- Debate continuation is now explicitly selectable: autonomous operation runs
  without approval prompts until independent consensus or the safety limit, while
  user-approved operation pauses at the configured turn interval.
- The continuation policy is available beside the debate mode and persists in
  Behavior and limits settings; the approval interval is disabled when irrelevant.
- A shared G+G multi-AI protocol now tells sequential and debate participants
  that they are collaborating through an orchestration environment, distinguishes
  the user from the peer model, and enforces zero-fluff, independent critique,
  delta-only contributions, evidence, minimal changes, and honest consensus.
- The first discussion turn is now an explicit independent proposal for peer
  review instead of a context-free answer addressed only to the user.
- Live incremental response rendering from provider DOM updates through the
  orchestrator, Electron IPC, and React conversation view.
- Content-free phase tracing for provider launch, session checks, conversation
  reuse, submission, streaming, completion, confirmation, and failures.
- Reproducible `npm run verify:dialogue` live acceptance runner for 20 ChatGPT
  and 20 Gemini responses in one persistent project.
- Experimental provider registry and adapters introduced by the concurrent UI
  expansion; ChatGPT and Gemini remain the endurance-verified providers.

### Fixed

- Later project messages no longer resend the stored local transcript into web
  chats that already own their history.
- Discussion turns now send only the current user task and latest peer response,
  preventing recursively nested prompts and exponential context growth.
- ChatGPT submission prefers the explicit enabled send button and verifies a new
  user-message signature instead of trusting composer clearing or old text matches.
- Gemini submission uses the same stable-id/fingerprint verification strategy.
- Challenge detection uses URL, title, and structural CAPTCHA controls rather
  than conversation text mentioning CAPTCHA or Cloudflare.
- Response binding supports virtualized ChatGPT lists where a new stable DOM id
  reuses an old ordinal and the rendered response count does not increase.

### Live acceptance

- Project `prj_04fd5b93-ca55-4d8e-b79a-0307c99fb055` completed 40 alternating
  turns: ChatGPT 20, Gemini 20, with one persisted conversation URL per provider.
- All responses were observed incrementally and the run finished `COMPLETED`.
- 57 automated tests pass across 17 test files.

## [0.1.0-pre.8] - 2026-07-31

### Fixed

- A provider response is no longer considered complete while its composer remains
  disabled or non-editable.
- The next debate turn waits for the current provider UI to finish generation,
  preventing stale hidden ChatGPT composer locators and 30-second `fill` timeouts.
- ChatGPT and Gemini composer discovery now ignores visible-but-disabled elements
  left behind during reactive page updates.

### Diagnostics

- Confirmed that the active Gemini conversation URL is persisted in SQLite and
  reused across application runs.

## [0.1.0-pre.7] - 2026-07-31

### Added

- User-selectable first participant for ordered multi-model conversations.
- Strict sequential mode: first provider answers, second provider reviews, then stop.
- Run-specific consensus protocol requiring independent completion tokens from both models.
- Persistent per-project ChatGPT and Gemini web conversation URLs.
- Distinct ChatGPT/Gemini message styling for a clearer dialogue view.

### Fixed

- Later project messages reopen the existing provider chats instead of creating new ones.
- ChatGPT conversation text mentioning “log in” no longer causes a false logout state.
- Submission confirmation accepts a newly appended user message and no longer depends
  solely on exact rendering of a long orchestration prompt.
- Consensus is checked before duplicate-response early termination.

### Verification

- 54 automated tests covering persistent refs, strict ordering, consensus, retries,
  cancellation, and session inference.
- Packaged UI coverage for provider starter selection.

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
