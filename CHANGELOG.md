# Changelog

All notable project checkpoints are recorded here.

## [Unreleased]

### Base functionality stabilization

- Hardened TXT/MD/PDF/PNG/JPEG staging with magic MIME checks, SHA-256 integrity,
  safe filenames, content dedupe, quarantine, provider capability validation,
  independent delivery/submission FSMs, and strict authenticated download policy.
- Made READY mode render only the explicit final answer while STREAMING receives
  correlated, sanitized progress; final transcript rows now use `providerId=final`.
- Added bounded prompt lifecycle, provider role/custom prompt support, untrusted
  peer-data framing, exact consensus markers, fail-fast cancellation and typed outcomes.
- Completed project-scoped CLI V1 approval/reject/cancel/retry UI and strengthened
  broker health, timeout, process, filesystem, output and verification boundaries.
- Corrected settings draft/reset behavior, project description persistence,
  truthful remote deletion, comprehensive local cleanup and keyboard accessibility.
- Added factual feature, prompt and known-issue documentation with explicit
  `BLOCKED_BY_AUTH`, `PARTIAL`, and experimental boundaries.

### Security and cleanup

- Removed the task-specific Snake slice, duplicate repair assets, empty design
  placeholders, renderer terminal bridge, and TwoTier command-string executor.
- Restricted CLI task recognition to strict `G_PLUS_G_CLI_TASK_V1` envelopes,
  explicit approval, durable FSM transitions, managed workspaces, filesystem
  scope enforcement, and an exact read-only verification-command registry.
- Added production TaskCompiler ingestion, security regression gates, CI,
  CODEOWNERS, artifact audit, release checklist, and factual handoff journals.

## [0.1.0-pre.13] - 2026-08-02

### Added & Fixed

- **G+G UI Master Corrective Pass**: Complete implementation of all 11 sections of the UI corrective pass specification.
- **RunSummaryBar**: Modularized summary bar with SVG icons, `flex-wrap` strategy, and clean human-readable labels (`Готовый ответ`, `Обсуждение: до согласия`, `Итог: Gemini`).
- **ModelStatusRow**: Modularized model status row for sidebar with 20×20 SVG logo, flex:1 name, status-dot, and right-aligned status text.
- **SettingsModal**: Refactored to 3-row CSS Grid layout (`auto minmax(0, 1fr) auto`) with fixed header and footer grid rows, scrollable right pane, and compact model accordion with search and filter toolbar (`Все`, `Подключены`, `Требуют входа`, `Экспериментальные`).
- **User-Facing Error System**: Added `toUserFacingError` utility and `<ErrorModal>` replacing raw Electron IPC exceptions with clean Russian titles, recommendations, and collapsible details drawer.
- **Project Toast**: Added `<ProjectRequiredToast>` prompting user to select a project before sending messages.
- **Browser Login Fixes**: Fixed premature browser closure in `ChatGptAdapter.waitForManualLogin` and unified `GeminiAdapter.openLoginMode` to use single visible Playwright window without spawning duplicate system Chrome processes.

## [0.1.0-beta.1] - 2026-08-01

### Added

- **Context Manager**: Integrated `ContextBudgeter`, `DecisionLedger`, `CanonicalSummary`, and thread rollover protection.
- **Dynamic Roles & Judge**: Added `assignRoles` and `evaluateDiscrepancy` for arbiter evaluation of peer reviews.
- **File Sandbox Security**: Implemented extension allowlist, file size limits, and path traversal protection in `FileSandbox`.
- Reached full pre-release feature readiness for 0.1.0-beta.1.

## [0.1.0-pre.12] - 2026-08-01

### Added

- Added Exponential Backoff Retry Policy module (`src/orchestrator/retry-policy.ts`) with `calculateRetryDelay` and `isRetryableError`.
- Integrated strict FSM transition validator `isValidFsmTransition` into `Orchestrator`.
- Enhanced turn and run crash recovery for hibernation and restart.

## [0.1.0-pre.11] - 2026-08-01

### Added

- Added project deletion with option to purge both local SQLite records and remote web chats.
- Implemented `deleteConversation` DOM automation in `ChatGPTAdapter`, `GeminiAdapter`, and `DeepSeekAdapter`.
- Added transactional `deleteProject` in `ProjectRepository` clearing all associated project entities.
- Added trash icon and confirmation modal UI with option choices: "Удалить везде" and "Удалить только в G+G".

## [0.1.0-pre.10] - 2026-08-01

### Added

- Introduced `TypedEventBus` in `src/events/` for validated domain event routing
  with strict schema validation (`event_version: 1`), correlation IDs, and runtime type checks.
- Protected Electron IPC bridge using strict allowlist for event broadcasting to the renderer.
- Integrated UI phase diagnostics rendering `phase:changed` events dynamically in the chat console.
- Added fast `fillComposerSafely` DOM utility across all web adapters to prevent Playwright `fill`
  timeouts when sending large prompts.
- Added optimistic rendering for user messages and animated status cards in transcript.

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
# Unreleased

- Removed the task-specific Snake output and live generator.
- Removed renderer host-terminal and TwoTier command-string execution bridges.
- Restricted CLI recognition to validated V1 envelopes outside Markdown fences,
  with explicit legacy/unsupported rejection and approval-by-default.
- Hardened verification process launch, task idempotency, workspace selection,
  CI source guards, and project security/release documentation.
