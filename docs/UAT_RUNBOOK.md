# Closed UAT and release runbook

Run only on a dedicated Windows VM against one frozen `uat` commit and its
installer SHA-256. Live traffic, installation, rollback and soak require the
release owner's explicit approval and authorized test accounts.

## Freeze and offline gates

```powershell
$ReleaseSha = (git rev-parse HEAD).Trim()
git status --porcelain
npm ci
npm run security:guard
npm run test:security
npm run check
npm run desktop:build
npm run package
npm run smoke:packaged
npm run preflight
npm run release:info
Get-FileHash '.\release\G plus G Setup 0.1.0-beta.1.exe' -Algorithm SHA256
```

PASS requires a clean tree and the same full SHA in the PR head, checkout,
`build-info.json`, release-info, evidence manifest and artifact record.

## Credential and session preflight

Record only `SET` or `MISSING`; never record values, cookies or browser storage.
The product uses persistent web profiles rather than these API keys.

```powershell
'OPENAI_API_KEY','GEMINI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY' |
  ForEach-Object {
    $value = [Environment]::GetEnvironmentVariable($_)
    [pscustomobject]@{Name=$_;State=$(if([string]::IsNullOrWhiteSpace($value)){'MISSING'}else{'SET'})}
  }
npm run login -- --provider chatgpt
npm run login -- --provider gemini
```

CAPTCHA, challenge pages, ambiguous DOM or wrong account are immediate STOP;
never bypass them. ChatGPT and Gemini are required. Claude is exploratory only
because it uses the generic web adapter; OpenRouter is NOT IMPLEMENTED.

## Provider and attachment matrix

Execute each supported case with a unique marker and record PASS/FAIL, elapsed
time, response fingerprint and artifact hash, but not prompt/response content.

| Case | ChatGPT | Gemini | Sequential | Parallel |
|---|---|---|---|---|
| Plain text, Markdown and Unicode | required | required | required | required |
| TXT and MD attachment | required | required | required | required |
| PNG and JPEG attachment | required | required | required | required |
| PDF attachment | required | required | required | required |
| Unsupported format rejection | required | required | n/a | n/a |
| Per-provider delivery, no cross-send | required | required | required | required |
| Retry without duplicate submit | required | required | required | required |
| Timeout before submit | required | required | required | required |
| Timeout after confirmed submit | required | required | required | required |
| UNKNOWN outcome: no blind retry | required | required | required | required |
| Restart while awaiting response | required | required | required | required |
| Response-file download and hash | required | required | required | required |

Artifact security negatives must reject unknown CDN/redirect chains, private IP,
loopback/localhost, bad MIME/extension, over-limit size and SHA mismatch.

CLI-task cases: ordinary prose, legacy tags and fenced Markdown produce zero
tasks. A valid V1 envelope must independently cover approve, reject, cancel,
approval timeout, duplicate task ID and forbidden/out-of-scope path behavior.

For basic binding endurance:

```powershell
npm run verify -- --provider chatgpt --count 20 --timeout 180000
npm run verify -- --provider gemini --count 20 --timeout 180000
```

## Install, upgrade and rollback

1. Record SHA-256 and provenance of the known deployed N-1 installer.
2. On a clean VM install N-1; create fixture project/history/settings/sessions.
3. Create and validate a pre-upgrade backup and VM snapshot.
4. Close all G+G/Electron/Chromium processes; install the frozen candidate.
5. Verify version/SHA, fixture, history, settings, persistent sessions, backup
   validation and SQLite `PRAGMA quick_check`.
6. Separately verify clean install on another clean VM.
7. Roll back by closing processes, installing N-1 and restoring only the
   validated pre-upgrade bundle. Verify `.before-restore`, database integrity,
   fixture state and absence of orphan processes.

Never reuse a database migrated by the candidate with N-1 unless compatibility
is proven; the pre-upgrade backup is the rollback source.

## Soak gates

Two-hour preliminary soak: 12 ten-minute cycles after warm-up; one unique turn
per supported provider each cycle, sequential/parallel every third cycle,
restart/recovery at cycle 6, backup validation at cycle 9, graceful shutdown at
the end.

Full release soak: 8–12 hours on the exact frozen artifact, periodic idle,
restart every 2 hours, backup validation every 4 hours. Sample every 5 minutes:
PID/children, working/private memory, handles, browser contexts, SQLite/WAL,
profile/temp sizes, successes, latency and retries.

PASS: zero wrong/duplicate/stale binding; zero crash, security or integrity
event; no orphans; failure <=1%; retry <=5%; memory/handles do not exceed 25%
over post-warm-up baseline for six consecutive samples; WAL/profile/temp show no
unbounded growth.

Abort and rollback on SHA mismatch, secret leakage, challenge page, ambiguous
DOM, wrong binding, SQLite failure, lost history, restore failure, crash/hang,
orphan process, leak threshold breach, or unexpected write outside approved
managed paths.

## Evidence bundle

Store frozen SHA, installer SHA-256, clean status, PR review/checks, release-info,
build-info, command logs with exit codes, redacted case table, fingerprints and
latency, upgrade/rollback screenshots and manifests, SQLite results, five-minute
telemetry CSV, orphan checks and signed PASS/FAIL. Exclude all prompt/response
content, cookies, credentials, tokens, profile data and signed URLs.
