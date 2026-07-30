# Architecture

G plus G is a local-first desktop orchestrator. SQLite is the source of truth;
provider web pages are replaceable external interfaces.

- `src/adapters`: uniform adapter contract and provider implementations.
- `src/browser`: persistent-profile ownership and recovery.
- `src/orchestrator`: bounded manual, sequential, parallel, and debate modes.
- `src/storage`: migrations, repositories, transactions, and append-only events.
- `src/project-state.ts`: versioned requirements, decisions, questions, and criteria.
- `src/artifacts`: traced and hashed specification exports.
- `apps/desktop`: sandboxed Electron renderer connected through a narrow preload API.
- `src/paths.ts`: one OS-specific data root shared by desktop and CLI.
- `src/observability`: redacted JSONL events and human-readable diagnostics.

The renderer has `nodeIntegration: false`, `contextIsolation: true`, a CSP, and no
direct filesystem/database access.

Every provider request is persisted as Conversation → Turn → Attempt → Message.
The shared transcript is used by both later orchestration runs and artifact export.

Each project owns one persisted web conversation reference per provider. A new
project creates new ChatGPT/Gemini chats once; later user messages reopen those same
URLs. Sequential mode follows the user-selected provider order exactly once.
Debate mode alternates providers until limits apply or both independently emit a
run-specific consensus token. A peer token alone never counts as agreement.
