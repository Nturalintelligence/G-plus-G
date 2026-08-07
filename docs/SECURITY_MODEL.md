# Security model

Model text, Markdown, code fences, attachments, URLs, stdout/stderr, and created
files are untrusted. A valid `G_PLUS_G_CLI_TASK_V1` block is only a proposal.

The trusted path is: recognition and strict validation → durable task record →
explicit approval → centralized FSM/scheduler → structured executable and argv
with `shell: false` → before/after filesystem scope enforcement → trusted
read-only verifier → verified result and audit event.

Forbidden operations include renderer host-shell access, command strings,
keyword/fallback execution, model-selected host workspaces, absolute/UNC/device
paths, traversal, unapproved process launch, and completion inferred only from
model prose or an unrelated pre-existing file.

Desktop tasks execute only in the managed `cli-workspace` under the application
data root. Verification is not model-extensible: only exact registered argv for
`git diff --check` and `git status --porcelain` are accepted. Every observed
added, modified, or deleted path must be allowed and not forbidden.

The renderer has context isolation, no Node integration, and a fixed preload
API. New IPC channels require schema, size, sender, and authorization review.

**Residual risk:** the existing CLI executors run as the host user and are not a
VM-grade sandbox. `G_PLUS_G_EXECUTION_V1` is **PLANNED**, not implemented; it must
remain disabled until a separate threat model and sandbox review are complete.

## Dependency audit (2026-08-08)

`npm audit` reports three high advisories only in developer/build tooling:
`fast-uri@3.1.4` and `js-yaml@4.3.0` through `electron-builder`, plus
`nanoid@3.3.16` through Vite/PostCSS. The vulnerable paths process trusted build
configuration/assets; the nanoid zero-size custom-generator path is not used by
the application. `npm audit --omit=dev` reports zero vulnerabilities, so these
packages are not in the packaged runtime dependency set. Upgrade them in a
separate reviewed lockfile PR; they do not justify mixing dependency changes
into the cleanup integration.
