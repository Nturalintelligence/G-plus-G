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

    deliveryMgr.updateDeliveryStatus(d1.id, "DELIVERED", "file-provider-99");
    const d2 = deliveryMgr.getOrCreateDelivery("att-1", "chatgpt", "conv-chatgpt-1");

    expect(d2.id).toBe(d1.id);
    expect(d2.status).toBe("DELIVERED");
    expect(d2.providerFileId).toBe("file-provider-99");
  });

  it("manages ProviderSubmission state machine idempotently", () => {
    const sub = subMgr.createSubmission("msg-1", "gemini", ["att-1"]);
    expect(sub.state).toBe("PREPARING");

    subMgr.updateState(sub.submissionId, "FILES_UPLOADED");
    const updated = subMgr.getSubmission("msg-1", "gemini");

    expect(updated?.state).toBe("FILES_UPLOADED");
    expect(updated?.attachmentIds).toEqual(["att-1"]);
  });
});
