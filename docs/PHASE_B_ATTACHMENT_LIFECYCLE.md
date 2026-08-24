# Phase B — local attachment lifecycle

Date: 2026-08-24. Branch: `fix/clipboard-and-provider-attachments`.
Base: `origin/uat@9c76509`. Provider adapters were intentionally unchanged.

## Implemented

- One main-process `AttachmentStagingService` for picker, trusted drop paths and bounded clipboard bytes.
- Renderer DTO excludes filesystem paths, full SHA-256 and provider metadata/URLs.
- `saveAs` returns only success/cancel and a display filename.
- Clipboard uses `Uint8Array`, with a 16 MiB hard limit; ordinary text paste is untouched.
- PNG, JPEG and magic-validated WebP images are supported.
- Windows clipboard documents use the trusted `File` path only when Electron exposes one; otherwise UI directs the user to picker/drop.
- Cards show preview/icon, filename, MIME, size, status, error, remove and retry where safe.
- Attachment-only messages are accepted with a neutral generated instruction.
- Transcript entries restore attachment cards after restart.
- Unsent attachment drafts restore after restart. Seven-day expiry marks them `FAILED`; failed drafts are retained for one day before reference-safe purge.
- Expiry and purge exclude transcript-linked files and active/pending/delivered provider deliveries.
- Repeated bytes in one draft reuse the existing attachment record and content-addressed blob.
- Images are served through the integrity-checked `attachment-preview:` protocol; managed paths never reach React.

## Renderer DTO

Before: `AttachmentRefV1`-shaped data including `sha256` and `localRelativePath`; preview was a base64 data URL; `saveAs` returned `targetPath`.

After: `id`, `messageId`, `projectId`, `kind`, `fileName`, `mimeType`, `sizeBytes`, `source`, `status`, optional safe `previewUrl`, `quarantineReason` and user-facing `error`.

## Verification

- Focused lifecycle/storage: 4 files, 26 tests passed.
- Renderer boundary: 3 tests passed.
- `npm run check`: 48 files, 210 tests passed.
- `npm run test:security`: 3 files, 37 tests passed.
- `npm run security:guard`: 91 production files passed.
- `npm run desktop:build`: passed.
- `npm run package`: Windows unpacked app and NSIS installer built.
- `npm run smoke:packaged`: passed without provider login or live provider calls.
- `npm run smoke:phase-b-visual`: passed; safe DTO and preview protocol verified; light/dark screenshots captured under `output/playwright/`.
- Ordinary Markdown/code fence creates zero execution jobs.

## Remaining boundary

- A Windows clipboard does not consistently expose copied documents as trusted `File` objects. Picker/drop is the explicit fallback.
- Provider delivery evidence is not part of Phase B and remains untrusted until Phase C.
- Response artifact receiving remains Phase D.
