# Phase D Live UAT — 2026-08-25

Traffic was intentionally limited to one submitted image scenario per provider.

## ChatGPT

- Project: `prj_1f39d33b-41ba-4a13-878b-2a3a466d0492`.
- One prompt was submitted; the turn reached the absolute 180 s limit.
- Diagnostic: `diagnostic-1787660887512.json` (`AUTHENTICATED`, composer 1, response selector count 0, mutations 289).
- A read-only reopen then encountered Cloudflare challenge, so no retry was attempted.
- Verdict: `TIMED_OUT`, not PASS.

## Gemini

- Project: `prj_7d451a1a-5e16-4488-8d2c-ba3053518c14`.
- One prompt was submitted and an image with an explicit “Скачать изображение в полном размере” control was rendered.
- The control uses an authenticated image `fetch`, not a Playwright download event. The original implementation therefore recorded `FAILED`.
- Read-only inspection proved full-size responses use generated `/gg/` or `/rd-gg/` endpoints ending in `=s0-d-I`.
- A broad first fallback caught a profile avatar; that record was marked `FAILED` and a regression test now rejects `/a/` avatars.
- The corrected fallback requires an explicit bound download control, allowlisted HTTPS generated endpoint, image MIME, bounded size, and content hash.
- Final re-scan was blocked by `ERR_NETWORK_CHANGED`; no additional provider message was submitted.
- Verdict: local regression PASS; final post-fix Live PASS remains pending.

No web chats were deleted. No installer, release, updater, push, or merge was performed.
