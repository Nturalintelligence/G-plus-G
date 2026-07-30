# Changelog

All notable project checkpoints are recorded here.

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
