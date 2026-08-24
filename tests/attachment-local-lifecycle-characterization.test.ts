import { describe, expect, it } from "vitest";
import { extractCliTasksV1 } from "../src/cli-executors/cli-task-schema.js";
import {
  MAX_CLIPBOARD_ATTACHMENT_BYTES,
  normalizeClipboardBytes,
  AttachmentStagingService,
  toRendererAttachment,
} from "../src/attachments/attachment-staging.js";
import type { AttachmentRefV1 } from "../src/attachments/attachments.js";
import { sniffMimeType } from "../src/attachments/artifact-store.js";
import { AppDatabase } from "../src/storage/database.js";
import { AttachmentDraftLifecycle } from "../src/attachments/attachment-draft-lifecycle.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const internalRef: AttachmentRefV1 = {
  id: "att-1",
  messageId: "msg-1",
  projectId: "project-1",
  kind: "image",
  fileName: "screen.png",
  mimeType: "image/png",
  sizeBytes: 123,
  sha256: "a".repeat(64),
  localRelativePath: "project-1/blobs/private.png",
  source: "user",
  status: "STAGED",
};

describe("Phase B local attachment lifecycle", () => {
  it("maps internal refs to a renderer DTO without storage or hash details", () => {
    const dto = toRendererAttachment(internalRef);

    expect(dto).toEqual({
      id: "att-1",
      messageId: "msg-1",
      projectId: "project-1",
      kind: "image",
      fileName: "screen.png",
      mimeType: "image/png",
      sizeBytes: 123,
      source: "user",
      status: "STAGED",
      previewUrl: "attachment-preview://local/att-1",
    });
    expect(dto).not.toHaveProperty("sha256");
    expect(dto).not.toHaveProperty("localRelativePath");
    expect(dto).not.toHaveProperty("providerMetadata");
  });

  it("accepts bounded binary clipboard data and rejects oversized payloads", () => {
    expect(normalizeClipboardBytes(new Uint8Array([1, 2, 3]))).toEqual(Buffer.from([1, 2, 3]));
    expect(() => normalizeClipboardBytes(new Uint8Array(0))).toThrow(/empty/i);
    expect(() => normalizeClipboardBytes(new Uint8Array(MAX_CLIPBOARD_ATTACHMENT_BYTES + 1))).toThrow(/size limit/i);
  });

  it("does not create execution jobs from ordinary Markdown fences", () => {
    const markdown = "```ts\nconsole.log('attachment preview')\n```";
    expect(extractCliTasksV1(markdown).filter((result) => result.success)).toHaveLength(0);
  });

  it("recognizes WebP by its RIFF container signature", () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    expect(sniffMimeType(webp, "clipboard.webp")).toBe("image/webp");
  });

  it("expires orphan drafts without touching active uploads", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-draft-"));
    const database = new AppDatabase(":memory:");
    database.migrate();
    database.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('project-1','P','ACTIVE','x','x')").run();
    const insert = database.raw.prepare(`INSERT INTO message_attachments
      (id,message_id,project_id,kind,file_name,mime_type,size_bytes,sha256,local_relative_path,source,status,created_at,draft_expires_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run("expired", "draft-old", "project-1", "text", "old.txt", "text/plain", 1, "a", "old", "user", "STAGED", "2026-01-01", "2026-01-02", "2026-01-01");
    insert.run("active", "draft-active", "project-1", "text", "active.txt", "text/plain", 1, "b", "active", "user", "UPLOADING", "2026-01-01", "2026-01-02", "2026-01-01");
    database.raw.prepare("INSERT INTO attachment_deliveries (id,attachment_id,provider_id,conversation_id,status) VALUES ('delivery','active','chatgpt','c','UPLOADING')").run();

    const lifecycle = new AttachmentDraftLifecycle(database.raw, new LocalArtifactStore(root));
    const report = lifecycle.expireAndCleanup(new Date("2026-01-10"), 24 * 60 * 60 * 1000);
    expect(report.expiredDrafts).toBe(1);
    expect(database.raw.prepare("SELECT status FROM message_attachments WHERE id='active'").get()).toMatchObject({ status: "UPLOADING" });
    expect(database.raw.prepare("SELECT status FROM message_attachments WHERE id='expired'").get()).toMatchObject({ status: "FAILED" });
    lifecycle.expireAndCleanup(new Date("2026-01-12"), 24 * 60 * 60 * 1000);
    expect(database.raw.prepare("SELECT status FROM message_attachments WHERE id='expired'").get()).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("deduplicates repeated clipboard bytes within one draft", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-stage-"));
    const database = new AppDatabase(":memory:");
    database.migrate();
    database.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('project-1','P','ACTIVE','x','x')").run();
    const staging = new AttachmentStagingService(database.raw, new LocalArtifactStore(root));
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    const first = staging.stageBytes(png, { projectId: "project-1", messageId: "draft-1" }, "screen.png");
    const repeated = staging.stageBytes(png, { projectId: "project-1", messageId: "draft-1" }, "copy.png");
    expect(repeated.id).toBe(first.id);
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM message_attachments").get()).toMatchObject({ count: 1 });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
