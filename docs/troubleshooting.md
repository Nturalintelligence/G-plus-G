# Troubleshooting

## Browser closes during login

Run `npm start -- login --provider chatgpt` or `--provider gemini`. Complete login
inside the Playwright window, not your normal browser.

## Profile is already in use

Close other G plus G/Playwright processes. A live PID lock is never removed
automatically. Stale locks are removed only after verifying that their PID is gone.

## CAPTCHA or challenge

Automation stops intentionally. Resolve the challenge manually and restart the
command. The application does not bypass service protections.

## Google says the browser is unsafe

Gemini login must happen in ordinary installed Google Chrome. The login command
temporarily closes Playwright, opens Chrome with the dedicated Gemini profile, and
waits until you close that Chrome window. If an older experimental profile causes
problems, reset only Gemini and retry:

```powershell
npm start -- session:reset --provider gemini
npm start -- login --provider gemini
```

## Reset a session

```powershell
npm start -- session:reset --provider gemini
```

This deletes only the selected provider profile. Project data remains in SQLite.

## Backup and restore

Close the desktop application before these commands:

```powershell
npm start -- database:backup --file "D:\Backups\g-plus-g.sqlite"
npm start -- database:restore --file "D:\Backups\g-plus-g.sqlite"
```

## Diagnostics

Safe reports are written to:

```text
%APPDATA%\multi-llm-orchestrator-feasibility\logs
```

`application.jsonl` contains structured lifecycle events. Failures create a
`diagnostic-<timestamp>.json` file and the UI displays its full path. Reports omit
cookies, authorization data, token-like values, passwords, and browser-profile data.

Provider login and direct-send failures are logged as well as orchestration failures.
