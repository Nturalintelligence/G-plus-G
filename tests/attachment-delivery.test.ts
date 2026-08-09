import { describe, expect, it, beforeEach } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { AttachmentDeliveryManager, ProviderSubmissionManager } from "../src/attachments/attachment-delivery.js";

describe("AttachmentDeliveryManager & ProviderSubmission FSM", () => {
  let appDb: AppDatabase;
  let deliveryMgr: AttachmentDeliveryManager;
  let subMgr: ProviderSubmissionManager;

  beforeEach(() => {
    appDb = new AppDatabase(":memory:");
    appDb.migrate();

    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('p1', 'Test', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    appDb.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES ('att-1', 'msg-1', 'p1', 'image', 'photo.png', 'image/png', 1024, 'sha123', 'p1/msg-1/att-1/photo.png', 'user', 'STAGED', '2026-01-01')
    `).run();

    deliveryMgr = new AttachmentDeliveryManager(appDb.raw);
    subMgr = new ProviderSubmissionManager(appDb.raw);
  });

  it("creates and deduplicates per-conversation attachment deliveries", () => {
    const d1 = deliveryMgr.getOrCreateDelivery("att-1", "chatgpt", "conv-chatgpt-1");
    expect(d1.status).toBe("PENDING");

    deliveryMgr.updateDeliveryStatus(d1.id, "UPLOADING");
    deliveryMgr.updateDeliveryStatus(d1.id, "DELIVERED", "file-provider-99");
    const d2 = deliveryMgr.getOrCreateDelivery("att-1", "chatgpt", "conv-chatgpt-1");

    expect(d2.id).toBe(d1.id);
    expect(d2.status).toBe("DELIVERED");
    expect(d2.providerFileId).toBe("file-provider-99");

    const gemini = deliveryMgr.getOrCreateDelivery("att-1", "gemini", "conv-gemini-1");
    expect(gemini.id).not.toBe(d1.id);
    expect(gemini.status).toBe("PENDING");
  });

  it("deduplicates delivered content by SHA-256 within one provider conversation", () => {
    const first = deliveryMgr.getOrCreateDelivery("att-1", "chatgpt", "conv-chatgpt-1");
    deliveryMgr.updateDeliveryStatus(first.id, "UPLOADING");
    deliveryMgr.updateDeliveryStatus(first.id, "DELIVERED");
    appDb.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES ('att-2', 'msg-2', 'p1', 'image', 'renamed.png', 'image/png', 1024, 'sha123', 'p1/msg-2/att-2/renamed.png', 'user', 'STAGED', '2026-01-02')
    `).run();

    expect(deliveryMgr.wasContentDelivered("sha123", "chatgpt", "conv-chatgpt-1")).toBe(true);
    expect(deliveryMgr.wasContentDelivered("sha123", "gemini", "conv-chatgpt-1")).toBe(false);
    expect(deliveryMgr.wasContentDelivered("sha123", "chatgpt", "conv-chatgpt-2")).toBe(false);
    expect(deliveryMgr.wasContentDelivered("changed-sha", "chatgpt", "conv-chatgpt-1")).toBe(false);
  });

  it("manages ProviderSubmission state machine idempotently and blocks blind UNKNOWN retry", () => {
    const sub = subMgr.createSubmission("msg-1", "gemini", ["att-1", "att-1"]);
    expect(sub.state).toBe("PREPARING");
    expect(sub.attachmentIds).toEqual(["att-1"]);
    expect(subMgr.createSubmission("msg-1", "gemini", ["att-1"]).submissionId).toBe(sub.submissionId);

    subMgr.updateState(sub.submissionId, "FILES_UPLOADED");
    subMgr.updateState(sub.submissionId, "SUBMITTED");
    subMgr.markUnknown(sub.submissionId);
    expect(subMgr.canRetry(sub.submissionId)).toBe(false);
    expect(() => subMgr.updateState(sub.submissionId, "FILES_UPLOADED")).toThrow("Invalid provider submission transition");

    subMgr.reconcileUnknown(sub.submissionId, "NOT_SUBMITTED");
    expect(subMgr.canRetry(sub.submissionId)).toBe(true);
    const updated = subMgr.getSubmission("msg-1", "gemini");

    expect(updated?.state).toBe("PREPARING");
    expect(updated?.attachmentIds).toEqual(["att-1"]);
  });

  it("rejects invalid delivery transitions and immutable submission changes", () => {
    const delivery = deliveryMgr.getOrCreateDelivery("att-1", "chatgpt", "conv-1");
    expect(() => deliveryMgr.updateDeliveryStatus(delivery.id, "DELIVERED", "provider-file")).toThrow("PENDING -> DELIVERED");

    subMgr.createSubmission("msg-1", "chatgpt", ["att-1"]);
    expect(() => subMgr.createSubmission("msg-1", "chatgpt", ["att-other"])).toThrow("immutable");
  });
});
