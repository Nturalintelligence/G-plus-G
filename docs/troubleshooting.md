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

Safe reports are written to `user-data/logs`. They omit cookies and profile data.
