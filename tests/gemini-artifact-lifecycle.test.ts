import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Gemini failed artifact renderer boundary", () => {
  it("does not expose a FAILED result as an open or save action", () => {
    const renderer = readFileSync("apps/desktop/renderer/main.tsx", "utf8");
    expect(renderer).toContain('file.status === "FAILED" ? <div className="message-attachment-open" role="status">');
    expect(renderer).toContain('file.source !== "user" && file.status === "READY"');
  });

  it("persists typed failure diagnostics without a fake downloaded_artifact name", () => {
    const source = readFileSync("src/attachments/artifact-downloader.ts", "utf8");
    for (const reason of [
      "EMPTY_RESPONSE_BODY", "DOWNLOAD_URL_EXPIRED", "DOWNLOAD_CONTROL_MISSING",
      "PREVIEW_NOT_ORIGINAL", "AUTHENTICATED_FETCH_FAILED",
      "MIME_VALIDATION_FAILED", "INTEGRITY_VALIDATION_FAILED",
    ]) expect(source).toContain(reason);
    expect(source).toContain('fileName: options.label?.trim() || ""');
  });
});
