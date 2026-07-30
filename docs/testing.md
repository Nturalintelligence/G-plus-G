# Acceptance test

Run automated checks:

```powershell
npm run check
npm run desktop:build
```

Then perform the browser acceptance test:

1. Log in to ChatGPT and Gemini using separate provider commands.
2. Run 50 unique-marker requests against ChatGPT.
3. Run the same contract scenarios against Gemini.
4. Start both contexts and run an independent parallel request.
5. Run sequential review and bounded debate; verify confirmation points and limits.
6. Close a provider tab during a turn and verify recovery.
7. Stop a run and restart the app; verify `INTERRUPTED` recovery and intact history.
8. Create and approve Project State, export it, and verify manifest hashes.
9. Close the Electron window during a run and reopen the project.
10. Back up the database, create additional data, restore the backup, and verify the
    earlier project state.

CAPTCHA must always stop automation. Ambiguous DOM must always produce an explicit
error rather than choosing an element silently.

Before every release candidate:

```powershell
npm run preflight
npm run release:info
npm run backup -- --file "<safe external backup directory>"
npm run backup:validate -- --file "<created timestamped bundle>"
```

Record the release-info output with the test results. Exercise restore only while
the desktop application is closed; confirm that the `.before-restore` rollback
copy is present and that project history opens normally afterward.
