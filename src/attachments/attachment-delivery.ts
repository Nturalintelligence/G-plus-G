import type { DatabaseSync } from "node:sqlite";
import { AttachmentRefV1 } from "./attachments.js";

export type DeliveryStatus = "PENDING" | "UPLOADING" | "DELIVERED" | "UNSUPPORTED" | "FAILED";
export type SubmissionState = "PREPARING" | "FILES_UPLOADED" | "SUBMITTED" | "CONFIRMED" | "UNKNOWN";

export interface AttachmentDelivery {
  id: string;
  attachmentId: string;
  providerId: string;
  conversationId: string;
  status: DeliveryStatus;
  providerFileId?: string;
  deliveredAt?: string;
}

export interface ProviderSubmission {
  submissionId: string;
  messageId: string;
  providerId: string;
  attachmentIds: string[];
  state: SubmissionState;
  createdAt: string;
}

export class AttachmentDeliveryManager {
  constructor(private db: DatabaseSync) {}

  public getOrCreateDelivery(attachmentId: string, providerId: string, conversationId: string): AttachmentDelivery {
    const row = this.db.prepare(`
      SELECT id, attachment_id, provider_id, conversation_id, status, provider_file_id, delivered_at
      FROM attachment_deliveries
      WHERE attachment_id = ? AND provider_id = ? AND conversation_id = ?
    `).get(attachmentId, providerId, conversationId) as any;

    if (row) {
      return {
        id: row.id,
        attachmentId: row.attachment_id,
        providerId: row.provider_id,
        conversationId: row.conversation_id,
        status: row.status as DeliveryStatus,
        providerFileId: row.provider_file_id || undefined,
        deliveredAt: row.delivered_at || undefined,
      };
    }

    const newId = `del_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO attachment_deliveries (id, attachment_id, provider_id, conversation_id, status)
      VALUES (?, ?, ?, ?, 'PENDING')
    `).run(newId, attachmentId, providerId, conversationId);

    return {
      id: newId,
      attachmentId,
      providerId,
      conversationId,
      status: "PENDING",
    };
  }

  public updateDeliveryStatus(
    deliveryId: string,
    status: DeliveryStatus,
    providerFileId?: string
  ): void {
    const deliveredAt = status === "DELIVERED" ? new Date().toISOString() : null;
    this.db.prepare(`
      UPDATE attachment_deliveries
      SET status = ?, provider_file_id = COALESCE(?, provider_file_id), delivered_at = COALESCE(?, delivered_at)
      WHERE id = ?
    `).run(status, providerFileId || null, deliveredAt, deliveryId);
  }

  public getDeliveriesForMessage(messageId: string, providerId: string): AttachmentDelivery[] {
    const rows = this.db.prepare(`
      SELECT d.id, d.attachment_id, d.provider_id, d.conversation_id, d.status, d.provider_file_id, d.delivered_at
      FROM attachment_deliveries d
      JOIN message_attachments a ON a.id = d.attachment_id
      WHERE a.message_id = ? AND d.provider_id = ?
    `).all(messageId, providerId) as any[];

    return rows.map((r) => ({
      id: r.id,
      attachmentId: r.attachment_id,
      providerId: r.provider_id,
      conversationId: r.conversation_id,
      status: r.status as DeliveryStatus,
      providerFileId: r.provider_file_id || undefined,
      deliveredAt: r.delivered_at || undefined,
    }));
  }
}

export class ProviderSubmissionManager {
  constructor(private db: DatabaseSync) {}

  public createSubmission(messageId: string, providerId: string, attachmentIds: string[]): ProviderSubmission {
    const submissionId = `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();
    const jsonIds = JSON.stringify(attachmentIds);

    this.db.prepare(`
      INSERT INTO provider_submissions (submission_id, message_id, provider_id, attachment_ids_json, state, created_at)
      VALUES (?, ?, ?, ?, 'PREPARING', ?)
    `).run(submissionId, messageId, providerId, jsonIds, createdAt);

    return {
      submissionId,
      messageId,
      providerId,
      attachmentIds,
      state: "PREPARING",
      createdAt,
    };
  }

  public updateState(submissionId: string, state: SubmissionState): void {
    this.db.prepare(`
      UPDATE provider_submissions
      SET state = ?
      WHERE submission_id = ?
    `).run(state, submissionId);
  }

  public getSubmission(messageId: string, providerId: string): ProviderSubmission | null {
    const row = this.db.prepare(`
      SELECT submission_id, message_id, provider_id, attachment_ids_json, state, created_at
      FROM provider_submissions
      WHERE message_id = ? AND provider_id = ?
    `).get(messageId, providerId) as any;

    if (!row) return null;
    return {
      submissionId: row.submission_id,
      messageId: row.message_id,
      providerId: row.provider_id,
      attachmentIds: JSON.parse(row.attachment_ids_json),
      state: row.state as SubmissionState,
      createdAt: row.created_at,
    };
  }
}
