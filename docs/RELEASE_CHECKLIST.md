# Release checklist

- [ ] Release SHA is frozen and matches the reviewed `uat` composition.
- [ ] `npm ci` succeeds from the lockfile.
- [ ] `npm run security:guard`, `npm run check`, and `npm run desktop:build` pass.
- [ ] Production package and packaged Electron smoke pass.
- [ ] CLI security-negative suite passes.
- [ ] `git diff --check` and task-artifact zero-hit scan pass.
- [ ] Clean install, upgrade, rollback, backup/restore and SQLite integrity pass.
- [ ] Closed ChatGPT/Gemini provider matrix passes with redacted traces.
- [ ] Release soak completes without unbounded RAM, handle, profile, temp, WAL,
  browser-context, or orphan-process growth.
- [ ] Rollback artifact and instructions are verified.
- [ ] Version, changelog, tag, checksums and release notes agree.
