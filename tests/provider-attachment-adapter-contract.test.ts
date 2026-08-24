import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const chatgpt = readFileSync(new URL("../src/chatgpt-adapter.ts", import.meta.url), "utf8");
const gemini = readFileSync(new URL("../src/gemini-adapter.ts", import.meta.url), "utf8");
const orchestrator = readFileSync(new URL("../src/orchestrator/orchestrator.ts", import.meta.url), "utf8");

describe("ChatGPT/Gemini production attachment adapter contract", () => {
  for (const [provider, source] of [["chatgpt", chatgpt], ["gemini", gemini]] as const) {
    it(`${provider} requires shared upload evidence before publishing attachment completion`, () => {
      expect(source).toContain("uploadAttachmentsToComposer(page, attachments");
      expect(source).toContain('type: "ATTACHMENTS_UPLOADED"');
      expect(source).toContain("attachmentIds: evidence.attachmentIds");
      expect(source).not.toMatch(/setInputFiles\([^)]*\)\.catch/);
      expect(source).not.toContain("await page.waitForTimeout(1000)");
    });
  }

  it("advances persisted submission state from provider events instead of model response inference", () => {
    expect(orchestrator).toContain('event.type === "ATTACHMENTS_UPLOADED"');
    expect(orchestrator).toContain('event.type === "MESSAGE_SUBMITTED"');
    expect(orchestrator.indexOf("confirmAttachmentSubmission();")).toBeLessThan(orchestrator.indexOf('repository.finishAttempt(attempt.id, "COMPLETED")'));
  });
});
