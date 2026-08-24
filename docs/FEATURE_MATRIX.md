# G+G 0.1 feature matrix

Updated: 2026-08-24. Branch: `fix/clipboard-and-provider-attachments`.

Status vocabulary:

- **TESTED** — implemented and covered by the cited local automated gate.
- **IMPLEMENTED** — wired in production code but still needs the named manual check.
- **PARTIAL** — a usable path exists, but a required part is missing.
- **BLOCKED_BY_AUTH** — local code is ready for a limited check in user-owned provider sessions.
- **PLANNED** — intentionally not part of the 0.1 base branch.

An existing button, class, or type is not treated as proof that a feature works.

| Feature / user scenario | UI entrypoint | Production components | Status | Automated evidence | Manual/account gate, known defect, readiness criterion |
|---|---|---|---|---|---|
| Create a project with name, description and providers | New project modal | renderer, preload `projects:create`, `ProjectRepository`, migration 8 | TESTED | storage, packaged smoke, renderer typecheck | Ready when clean packaged install persists all fields after restart. |
| Select/open a project | Project sidebar | `projects:open`, repository transcript/state/event reads | TESTED | storage, packaged smoke | No account. |
| Persist and restore a project | Automatic SQLite persistence | migrations, repository, recovery | TESTED | storage/recovery tests | No account; crash recovery marks unfinished work explicitly. |
| Edit/version/approve Project State | Advanced state controls | `ProjectStateService`, spec exporter | TESTED | project-state, packaged smoke | UX remains advanced rather than guided. |
| Delete locally | Project menu | truthful structured IPC result, comprehensive relational cleanup, managed artifact cleanup | TESTED | storage deletion test; build/typecheck | Must be rechecked once in packaged UI. Active CLI tasks block deletion. |
| Delete provider conversations | Delete confirmation | provider adapters, authenticated profile, conversation URL | BLOCKED_BY_AUTH | adapter/unit only | Local project is retained if any requested remote delete lacks positive confirmation. |
| ChatGPT authorization | Provider login button | persistent Playwright profile for ChatGPT | BLOCKED_BY_AUTH | isolation/session tests | User must sign in manually; never provide passwords, cookies or tokens. |
| Gemini authorization | Provider login button | separate persistent Playwright profile for Gemini | BLOCKED_BY_AUTH | isolation/session tests | Same gate, independently of ChatGPT. |
| Separate browser profiles | Provider login/send | adapter registry/profile paths | TESTED | browser-isolation, profile-lock tests | Limited live confirmation still required. |
| Provider status | Provider row | `provider:status`, session detection | IMPLEMENTED | session-detection tests; packaged smoke skips live probe | Verify authenticated/login/challenge states in both profiles. |
| Save and reopen conversation URL | Automatic after a completed turn | adapter `getCurrentConversation`, repository external ref | BLOCKED_BY_AUTH | orchestrator mocks | Live ChatGPT and Gemini URL persistence required. |
| Send a single MANUAL request | Composer / mode bar | Orchestrator, adapter turn contract | BLOCKED_BY_AUTH | orchestrator tests | Live text round trip required. |
| SEQUENTIAL board | Mode bar | prompt builder, Orchestrator | BLOCKED_BY_AUTH | orchestrator and prompt golden tests | Verify ordering and no duplicated initial artifact. |
| PARALLEL board | Mode bar | fail-fast peer turns | BLOCKED_BY_AUTH | cancellation/orchestrator tests | Verify one provider failure cancels unrelated pending work promptly. |
| DEBATE board | Mode bar | bounded productive protocol, exact consensus marker | BLOCKED_BY_AUTH | orchestration protocol tests | Verify provider DOM changes and bounded-turn checkpoint. |
| Stop/cancel orchestration | Stop control | active turn registry, adapter cancel | IMPLEMENTED | cancellation tests | Packaged click-through and live stopped-generation checks remain. |
| Turn timeout/retry | Automatic limits | Orchestrator limits, attempt FSM | TESTED | retry, retry-policy, orchestrator tests | A turn reference disables blind retry because submission may have occurred. |
| UNKNOWN/recovery | Project reopen | run/turn recovery, provider submission FSM | TESTED | storage, delivery, recovery tests | Attachment submission `UNKNOWN` requires reconciliation; no UI reconciler yet. |
| Explicit ready answer | View-mode selector | renderer hides progress in READY mode; `providerId=final` transcript row | IMPLEMENTED | orchestration finalization tests; renderer typecheck | A packaged visual test must prove one atomic render after completion. |
| Streaming answer | View-mode selector | correlated sanitized progress events | IMPLEMENTED | orchestration progress tests | Live DOM stability/chunk replacement still requires provider UAT. |
| Shared history | Conversation pane | `conversation_entries` | TESTED | storage/orchestrator tests | Candidate rows remain attributable; final row is explicit. |
| Memory, brief, checkpoint, rollover hooks | Advanced/context services | three-tier memory, rollover manager, RunOptions hooks | PARTIAL | memory/checkpoint tests | Core services are tested; desktop does not yet automate a full provider rollover. |
| Prompt lifecycle | Settings → Models; orchestration | versioned protocol, role/custom prompt, incremental prompts | TESTED | prompt protocol/golden tests | Provider chat should receive the full protocol once, then incremental context. |
| Pick TXT/MD/PDF/PNG/JPEG/WebP | Composer attachment button | native dialog, unified staging service, artifact store | TESTED | lifecycle/artifact-store tests, packaged build | Provider upload remains Phase C. |
| Drag-and-drop a file | Composer drop zone | Electron `webUtils.getPathForFile` in preload, immediate staging IPC | TESTED | renderer-boundary tests, build and packaged smoke | Absolute path exists only inside preload → main staging and is never returned to React. |
| Paste screenshot | Composer paste | bounded `Uint8Array` PNG/JPEG/WebP staging | TESTED | lifecycle/boundary and visual packaged smoke | Text paste remains native. Clipboard documents fall back to picker/drop when Windows supplies no trusted path. |
| Restore attachment draft/history | Project reopen | migration 9, draft lifecycle, transcript DTO wiring | TESTED | lifecycle, migration, full check and visual smoke | Draft expiry is seven days; failed drafts purge after a further one-day retention unless referenced/active. |
| Managed artifact storage | Automatic | SHA-256, magic MIME, safe names, content dedupe, integrity read | TESTED | artifact store/cleanup tests | Unsafe, executable, mismatched and oversized content is rejected/quarantined honestly. |
| Provider-specific attachment delivery | Send with attachments | capability policy, integrity recheck, Delivery and Submission FSM | IMPLEMENTED | attachment delivery/unit + orchestrator build | Live ChatGPT and Gemini must each confirm TXT/MD/PDF/PNG/JPEG. UNKNOWN is not retried blindly. |
| Receive a response file | Response result | authenticated download event + strict HTTPS/domain/IP/MIME policy | PARTIAL | artifact-downloader tests | Secure primitive exists, but adapter-to-persisted UI result-card wiring needs live provider fixtures and is not release-ready. |
| CLI V1 proposal recognition | Model response | exact fenced `G_PLUS_G_CLI_TASK_V1`, schema compiler | TESTED | CLI schema/orchestrator integration tests | Markdown, ordinary code fences and legacy keywords create zero tasks. |
| CLI approval/reject | CLI task cards | project-scoped IPC, explicit host-risk confirmation | TESTED | CLI service/FSM tests; renderer typecheck | Approval is per task. There is no “allow all”. |
| CLI execution/broker | Approved task | executor health/capabilities, `shell:false`, bounded process, before/after audit | TESTED | execution broker/service/security tests | Runs as current Windows user, not a VM-grade sandbox; UI states this explicitly. |
| CLI cancel/retry/recovery | CLI task cards | AbortController, FSM, startup recovery | TESTED | CLI service/FSM tests | Retry returns to approval; it neither creates an attempt nor auto-runs. |
| Backup | Settings/maintenance | backup bundle and validation | TESTED | maintenance, release tools, packaged smoke | No provider credentials are exported. |
| Restore | CLI/maintenance path | backup validation/restore | TESTED | maintenance tests | No dedicated guided desktop restore flow. |
| Diagnostics/logs | Settings → Diagnostics | release info, data-folder action, structured diagnostics | TESTED | observability/release tests | Opening the data folder uses main-process shell only. |
| Settings reset/save/cancel | Settings modal | local draft, persisted validated settings | TESTED | settings tests; renderer typecheck | Cancel no longer mutates parent state; reset is persisted. |
| No project selected | Composer | toast/guard | IMPLEMENTED | renderer typecheck | Packaged click-through remains. |
| Provider unavailable/logout/challenge | Provider rows/run error | session detection, user-facing errors, diagnostics | IMPLEMENTED | session and adapter tests | Confirm copy/actions against live pages. |
| Packaged Windows app | Installer | Vite, Electron, electron-builder, packaged smoke | TESTED | packaged smoke at runtime SHA `337abb01fd0c`; SHA-256 in TEST_EVIDENCE | Live provider probes were explicitly disabled; installer evidence is SHA-bound. |
| Experimental protocol router / Secure Code Runtime | None in base branch | none | PLANNED | zero production implementation | Must start only on a separate experimental branch after base provider smoke and separate approval. |

## Auth-blocked smoke scope

The next manual session is deliberately short: ChatGPT and Gemini login/status;
plain text; READY and STREAMING; each required attachment format; one response
file; conversation URL reopen; sequential/parallel/debate; Stop; one safe CLI V1
proposal with approve/reject/cancel. Full soak is explicitly out of scope until
feature freeze.
