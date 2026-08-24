# Phase C — truthful ChatGPT/Gemini attachment delivery

Date: 2026-08-24. Branch: `fix/clipboard-and-provider-attachments`.

## Production behavior

1. Provider capability policy rejects unsupported count, size, MIME/extension
   or multiple-file combinations before interacting with provider DOM.
2. Every managed file is re-read and checked against its stored byte length,
   SHA-256 and sniffed MIME immediately before upload.
3. A provider file input must be present and unambiguous. `setInputFiles`
   errors are propagated; neither ChatGPT nor Gemini suppresses them.
4. Browser `FileList` must contain the exact resolved files and byte lengths.
5. The adapter waits for provider-specific composer attachment chips, rejects
   visible upload errors and waits until upload progress is absent.
6. Text submission cannot begin until all attachment evidence is stable.
7. Adapter events advance persisted state in order:
   `PREPARING` → `FILES_UPLOADED` → `SUBMITTED` → `CONFIRMED`.
8. Delivery rows become `DELIVERED` on stable upload evidence, independently
   of whether a later text submit/response fails.
9. Missing/ambiguous evidence fails closed. The submission becomes `UNKNOWN`
   and an attachment-bearing turn is never retried blindly.

## Local provider fixtures

The tests run a real local Chromium page, not a test-only adapter renderer.
Anonymized ChatGPT/Gemini composer fixtures exercise their production selector
sets with PNG, JPEG, WebP, PDF and Markdown together. The suite also covers:

- exact multi-file `FileList` and byte sizes;
- asynchronous progress → stable chip transition;
- missing evidence timeout;
- provider upload error;
- ambiguous file inputs;
- provider count/size/type policy;
- content tampering before DOM interaction;
- upload evidence without submit evidence;
- provider failure and the single-attempt/no-blind-retry rule.

## Evidence boundary

This phase did **not** open ChatGPT or Gemini, use an authenticated profile, or
send an external message. Local fixtures prove fail-closed production wiring,
not compatibility with the providers' current live DOM. Live UAT remains
`BLOCKED_BY_OWNER_APPROVAL` and must use the SHA-bound packaged build.

Required live matrix when the owner explicitly approves it: each provider with
PNG, JPEG, WebP, PDF, MD, multiple files, upload error/limit handling, exact
conversation binding and restart/reopen. UNKNOWN reconciliation must be manual;
the UAT runner must never auto-retry an ambiguous submission.
