# AW-2 command runtime evidence

Status: `AW_2_COMMAND_RUNTIME_PASS / AW_2_GIT_RUNTIME_INCOMPLETE`

Date: 2026-11-05
Branch: `feat/agent-workspace-foundation`

## Connected production flow

The Electron application now exercises one bounded command action through the production path:

`propose -> validate -> main-process approval/policy -> queue -> execute -> stream -> verify -> persist`

- The renderer can select only a predefined command preset. It cannot provide an executable, raw shell text, environment, approval token, or approval decision.
- The main process owns the native approval dialog and single-use approval capability.
- Execution uses `shell: false`, an executable allowlist, canonical workspace validation, an environment allowlist, bounded/redacted output, timeout, and Windows process-tree termination.
- Action state, scoped events, exit code, duration, failure code, output summary, and successful evidence are stored in SQLite.
- Startup converts unfinished `RUNNING`/`VERIFYING` actions to `INTERRUPTED` and records an immutable interruption event.
- Renderer event consumption is scoped by `projectId + taskId + agentInstanceId + workspaceId`; events from a previously selected project are discarded.

This is a constrained host process with the permissions of the application. It is not a sandbox.

## Capability truthfulness

`builtin.command` is `READY` only because its production handler is connected.

`builtin.git` is `DEGRADED`: only read-only repository inspection is connected to the production UI. Structured stage, commit, fetch, push, branch creation, diff, and log actions remain `DECLARED` until their Tool Broker execution handlers exist. No full Git runtime pass is claimed.

## Concurrency and lifecycle evidence

- Writer exclusion is keyed by the canonical repository path, not a project-local workspace ID. Two projects pointing to the same repository cannot execute concurrent write actions.
- Production Stop captures the spawned child PID, terminates the complete process tree, and proves that the child PID is gone before the fixture's five-second self-exit guard could fire.
- The self-exit guard remains only a bounded crash-fixture safeguard; it is not used as proof for Stop cleanup.
- The crash smoke terminates the complete Electron tree, relaunches against the same database, and observes the unfinished action as `INTERRUPTED` with its earlier history intact.
- Duplicate idempotency keys return the original action and do not launch a second process.
- Approval denial creates no process and is persisted in the action event history.

## Verification

| Check | Result |
| --- | --- |
| `npm run check` | PASS — 79 test files, 382 tests |
| Focused command/broker/storage tests | PASS — 18 tests |
| `npm run security:guard` | PASS — 124 production source files |
| `npm run security:uat-observer` | PASS |
| Electron production command smoke | PASS, natural exit code 0 |
| Tools UI smoke | PASS, Git `DEGRADED`, raw terminal absent |
| Derived artifact regression smoke | PASS |
| Provider traffic | 0 |
| `git diff --check` | PASS |

Production smoke scenarios: streamed success, nonzero exit, timeout, Stop/process-tree cleanup, denial without launch, idempotent duplicate, restart interruption, history after restart, stale-event rejection, and truthful Git aggregate health.

Screenshots at browser zoom 100%:

- `docs/screenshots/aw2-command-runtime-1920x1080.png`
- `docs/screenshots/aw2-tools-1920x1080.png`

## Development-environment Git diagnostic

The earlier non-escalated `git status`/`git diff` error was not repository corruption. Git trace resolved the linked worktree and common Git directory correctly, but the managed filesystem profile exposed the common `.git/worktrees/...` metadata as read-only. Status refresh needs metadata/index write access and failed with Git's misleading `this operation must be run in a work tree` message. The same commands succeeded unchanged when run with the approved worktree permission.

During the interrupted edit, the new untracked `tests/command-runtime.test.ts` was left deleted. It was restored and now covers streaming/evidence, nonzero exit, timeout, Stop with child-PID termination, canonical cross-project writer locking, denial, deduplication, and restart interruption.

## Remaining work

- Connect Git actions to Tool Broker execution and verification before claiming `AW_2_RUNTIME_PASS`.
- Add branch/dirty-tree policy, explicit staging ownership, commit evidence, divergence checks, network approval, and push protections to that runtime.
- Do not start AW-3 from this checkpoint.
