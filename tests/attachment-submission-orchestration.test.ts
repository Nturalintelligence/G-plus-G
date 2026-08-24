import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MessageInput, ModelAdapter, TurnEvent, TurnRef } from "../src/adapters/adapter-contract.js";
import type { AttachmentRefV1 } from "../src/attachments/attachments.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";

const limits = { maxTurns: 1, maxTurnMs: 2_000, maxSessionMs: 4_000, maxRetries: 2, confirmationEvery: 2 };

function setup() {
  const database = new AppDatabase(join(mkdtempSync(join(tmpdir(), "attachment-submit-")), "db.sqlite"));
  database.migrate();
  const projectId = new ProjectRepository(database).createProject("Attachment submission").id;
  const attachment: AttachmentRefV1 = {
    id: "att-bound", messageId: "msg-bound", projectId, kind: "image", fileName: "proof.png", mimeType: "image/png",
    sizeBytes: 100, sha256: "a".repeat(64), localRelativePath: "managed/proof.png", source: "user", status: "STAGED",
  };
  database.raw.prepare(`INSERT INTO message_attachments
    (id,message_id,project_id,kind,file_name,mime_type,size_bytes,sha256,local_relative_path,source,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(attachment.id, attachment.messageId, projectId, attachment.kind, attachment.fileName, attachment.mimeType, attachment.sizeBytes, attachment.sha256, attachment.localRelativePath, attachment.source, attachment.status, new Date().toISOString());
  return { database, projectId, attachment };
}

function adapter(events: TurnEvent[], fail = false): ModelAdapter {
  return {
    providerId: "chatgpt",
    async createConversation() { return { id: "provider-conversation", url: "https://example.test/c/1" }; },
    async openConversation() {},
    async getCurrentConversation() { return { id: "provider-conversation", url: "https://example.test/c/1" }; },
    async sendMessage(_input: MessageInput) { return { id: "provider-turn" }; },
    async *observeTurn(_turn: TurnRef) { for (const event of events) yield event; },
    async getFinalResponse() { if (fail) throw new Error("provider failed"); return { response: "processed", responseFingerprint: "processed", elapsedMs: 1 }; },
    async cancel() {},
  } as unknown as ModelAdapter;
}

async function runWith(events: TurnEvent[], fail = false) {
  const context = setup();
  const orchestrator = new Orchestrator(context.database, new Map([["chatgpt", adapter(events, fail)]]));
  const promise = orchestrator.run(context.projectId, "MANUAL", "inspect file", ["chatgpt"], { limits, userMessageId: context.attachment.messageId, attachments: [context.attachment] });
  return { ...context, promise };
}

describe("attachment submission evidence orchestration", () => {
  it("advances upload, submit and confirmation only from ordered provider evidence", async () => {
    const now = new Date().toISOString();
    const context = await runWith([
      { type: "ATTACHMENTS_UPLOADED", at: now, attachmentIds: ["att-bound"] },
      { type: "MESSAGE_SUBMITTED", at: now },
    ]);
    await expect(context.promise).resolves.toMatchObject({ status: "COMPLETED" });
    expect(context.database.raw.prepare("SELECT state FROM provider_submissions").get()).toMatchObject({ state: "CONFIRMED" });
    expect(context.database.raw.prepare("SELECT status FROM attachment_deliveries").get()).toMatchObject({ status: "DELIVERED" });
    context.database.close();
  });

  it("fails closed and marks UNKNOWN when submit evidence is absent", async () => {
    const context = await runWith([{ type: "ATTACHMENTS_UPLOADED", at: new Date().toISOString(), attachmentIds: ["att-bound"] }]);
    await expect(context.promise).rejects.toThrow(/FILES_UPLOADED -> CONFIRMED/);
    expect(context.database.raw.prepare("SELECT state FROM provider_submissions").get()).toMatchObject({ state: "UNKNOWN" });
    expect(context.database.raw.prepare("SELECT status FROM attachment_deliveries").get()).toMatchObject({ status: "DELIVERED" });
    context.database.close();
  });

  it("does not retry an attachment turn after an ambiguous provider failure", async () => {
    const context = await runWith([], true);
    await expect(context.promise).rejects.toThrow(/provider failed/);
    expect(context.database.raw.prepare("SELECT state FROM provider_submissions").get()).toMatchObject({ state: "UNKNOWN" });
    expect(context.database.raw.prepare("SELECT status FROM attachment_deliveries").get()).toMatchObject({ status: "FAILED" });
    expect(context.database.raw.prepare("SELECT COUNT(*) AS count FROM attempts").get()).toMatchObject({ count: 1 });
    context.database.close();
  });
});
