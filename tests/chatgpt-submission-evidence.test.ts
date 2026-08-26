import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyChatGptSubmissionEvidence } from "../src/adapters/chatgpt-submission-evidence.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProviderSubmissionManager } from "../src/attachments/attachment-delivery.js";

const base = {
  expectedMessage: "Проверь вложения",
  expectedFileNames: ["screen.png", "notes.md"],
  baselineTurnKeys: new Set(["id:old"]),
  currentTurns: [{ key: "id:old", text: "Старое сообщение" }],
  composerCleared: false,
  generationStarted: false,
  assistantCountIncreased: false,
  conversationChanged: false,
  uploadCompleted: true,
};

describe("ChatGPT submission evidence", () => {
  it("confirms a new matching user turn with both attachment names", () => {
    expect(classifyChatGptSubmissionEvidence({ ...base, currentTurns: [...base.currentTurns, { key: "id:new", text: "Проверь вложения screen.png notes.md" }] })).toMatchObject({ level: "STRONG_CONFIRMED", matchingTurnKey: "id:new" });
  });

  it("recovers when the bubble selector changed but composer, generation and conversation agree", () => {
    expect(classifyChatGptSubmissionEvidence({ ...base, composerCleared: true, generationStarted: true, conversationChanged: true })).toMatchObject({ level: "STRONG_CONFIRMED" });
  });

  it("accepts assistant start as independent strong evidence", () => {
    expect(classifyChatGptSubmissionEvidence({ ...base, composerCleared: true, assistantCountIncreased: true, conversationChanged: true })).toMatchObject({ level: "STRONG_CONFIRMED" });
  });

  it("keeps ambiguous evidence UNKNOWN", () => {
    expect(classifyChatGptSubmissionEvidence({ ...base, composerCleared: true })).toMatchObject({ level: "UNKNOWN" });
  });

  it("preserves the redacted live timeout as a regression fixture", () => {
    const fixture = JSON.parse(readFileSync("tests/fixtures/chatgpt-submission-timeout-redacted.json", "utf8"));
    expect(fixture).toMatchObject({ sessionState: "AUTHENTICATED", mutationCount: 173, redacted: true });
    expect(JSON.stringify(fixture)).not.toMatch(/cookie|token|signed/i);
  });

  it("recovers UNKNOWN as CONFIRMED after restart without making it retryable", () => {
    const root = mkdtempSync(join(tmpdir(), "gplusg-chatgpt-reconcile-"));
    const path = join(root, "state.sqlite");
    try {
      const first = new AppDatabase(path); first.migrate();
      const manager = new ProviderSubmissionManager(first.raw);
      const submission = manager.createSubmission("message-1", "chatgpt", ["attachment-png", "attachment-md"]);
      manager.markUnknown(submission.submissionId); first.close();
      const restarted = new AppDatabase(path); restarted.migrate();
      const recovered = new ProviderSubmissionManager(restarted.raw);
      recovered.reconcileUnknown(submission.submissionId, "CONFIRMED");
      expect(recovered.getSubmission("message-1", "chatgpt")?.state).toBe("CONFIRMED");
      expect(recovered.canRetry(submission.submissionId)).toBe(false);
      expect(recovered.createSubmission("message-1", "chatgpt", ["attachment-png", "attachment-md"]).state).toBe("CONFIRMED");
      restarted.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
