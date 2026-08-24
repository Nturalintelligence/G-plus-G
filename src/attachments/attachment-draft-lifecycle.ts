import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { LocalArtifactStore } from "./artifact-store.js";

export interface DraftCleanupReport {
  expiredDrafts: number;
  purgedRecords: number;
  deletedBlobs: number;
}

export class AttachmentDraftLifecycle {
  constructor(
    private readonly database: DatabaseSync,
    private readonly store: LocalArtifactStore = new LocalArtifactStore(),
  ) {}

  public expireAndCleanup(now = new Date(), failedRetentionMs = 24 * 60 * 60 * 1000): DraftCleanupReport {
    const nowIso = now.toISOString();
    const expired = this.database.prepare(`
      UPDATE message_attachments
      SET status = 'FAILED', last_error = 'Draft expired before it was sent', updated_at = ?
      WHERE draft_expires_at IS NOT NULL AND draft_expires_at < ?
        AND status NOT IN ('FAILED', 'QUARANTINED')
        AND NOT EXISTS (SELECT 1 FROM conversation_entries ce WHERE ce.id = message_attachments.message_id)
        AND NOT EXISTS (
          SELECT 1 FROM attachment_deliveries ad
          WHERE ad.attachment_id = message_attachments.id
            AND ad.status IN ('PENDING', 'UPLOADING', 'DELIVERED')
        )
    `).run(nowIso, nowIso);

    const cutoffIso = new Date(now.getTime() - failedRetentionMs).toISOString();
    const purgeRows = this.database.prepare(`
      SELECT id, local_relative_path FROM message_attachments
      WHERE status = 'FAILED' AND updated_at IS NOT NULL AND updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM conversation_entries ce WHERE ce.id = message_attachments.message_id)
        AND NOT EXISTS (SELECT 1 FROM attachment_deliveries ad WHERE ad.attachment_id = message_attachments.id)
    `).all(cutoffIso) as Array<{ id: string; local_relative_path: string }>;

    let deletedBlobs = 0;
    const deleteRow = this.database.prepare("DELETE FROM message_attachments WHERE id = ?");
    const referenceCount = this.database.prepare(
      "SELECT COUNT(*) AS count FROM message_attachments WHERE local_relative_path = ?",
    );
    for (const row of purgeRows) {
      deleteRow.run(row.id);
      const remaining = referenceCount.get(row.local_relative_path) as { count: number };
      if (remaining.count === 0) {
        const absolutePath = this.store.resolveAbsolutePath(row.local_relative_path);
        if (fs.existsSync(absolutePath)) {
          fs.unlinkSync(absolutePath);
          deletedBlobs += 1;
        }
      }
    }
    return { expiredDrafts: Number(expired.changes), purgedRecords: purgeRows.length, deletedBlobs };
  }
}
