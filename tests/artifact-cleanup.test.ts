import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AppDatabase } from "../src/storage/database.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { ArtifactCleanupManager } from "../src/attachments/artifact-cleanup.js";

describe("ArtifactCleanupManager Reference-Safe Cleanup", () => {
  let tmpDir: string;
  let store: LocalArtifactStore;
  let appDb: AppDatabase;
  let cleanupMgr: ArtifactCleanupManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-cleanup-test-"));
    store = new LocalArtifactStore(tmpDir);
    appDb = new AppDatabase(":memory:");
    appDb.migrate();

    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('p1', 'Test', 'ACTIVE', '2026-01-01', '2026-01-01')"
    ).run();

    cleanupMgr = new ArtifactCleanupManager(appDb.raw, store);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("preserves referenced files and deletes unreferenced orphan files past grace period", () => {
    const buf1 = Buffer.from("Referenced attachment content");
    const ref1 = store.storeBuffer(buf1, {
      projectId: "p1",
      messageId: "msg-1",
      source: "user",
      originalFileName: "active.txt",
    });

    appDb.raw.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref1.id,
      ref1.messageId,
      ref1.projectId,
      ref1.kind,
      ref1.fileName,
      ref1.mimeType,
      ref1.sizeBytes,
      ref1.sha256,
      ref1.localRelativePath,
      ref1.source,
      ref1.status,
      new Date().toISOString()
    );

    const buf2 = Buffer.from("Orphan attachment content");
    const ref2 = store.storeBuffer(buf2, {
      projectId: "p1",
      messageId: "msg-2",
      source: "user",
      originalFileName: "orphan.txt",
    });

    const orphanPath = store.resolveAbsolutePath(ref2.localRelativePath);
    const oldTime = new Date(Date.now() - 48 * 3600 * 1000);
    fs.utimesSync(orphanPath, oldTime, oldTime);

    const report = cleanupMgr.performOrphanCleanup(24 * 3600 * 1000);

    expect(report.referencedFilesCount).toBe(1);
    expect(report.deletedOrphanFilesCount).toBe(1);

    expect(fs.existsSync(store.resolveAbsolutePath(ref1.localRelativePath))).toBe(true);
    expect(fs.existsSync(orphanPath)).toBe(false);
  });
});
