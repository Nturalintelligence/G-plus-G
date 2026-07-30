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

The renderer has `nodeIntegration: false`, `contextIsolation: true`, a CSP, and no
direct filesystem/database access.
