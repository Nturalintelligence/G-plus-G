import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

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

const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  PENDING: ["UPLOADING", "UNSUPPORTED", "FAILED"],
  UPLOADING: ["DELIVERED", "FAILED"],
  DELIVERED: [],
  UNSUPPORTED: [],
  FAILED: ["UPLOADING"],
};

const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionState, readonly SubmissionState[]>> = {
  PREPARING: ["FILES_UPLOADED", "UNKNOWN"],
  FILES_UPLOADED: ["SUBMITTED", "UNKNOWN"],
  SUBMITTED: ["CONFIRMED", "UNKNOWN"],
  CONFIRMED: [],
  UNKNOWN: ["CONFIRMED"],
};

function stableId(prefix: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `${prefix}_${digest}`;
}

function requireIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 500) {
    throw new Error(`${label} must be a non-empty identifier`);
  }
}

function mapDelivery(row: Record<string, unknown>): AttachmentDelivery {
  return {
    id: String(row.id),
    attachmentId: String(row.attachment_id),
    providerId: String(row.provider_id),
    conversationId: String(row.conversation_id),
    status: String(row.status) as DeliveryStatus,
    ...(row.provider_file_id ? { providerFileId: String(row.provider_file_id) } : {}),
    ...(row.delivered_at ? { deliveredAt: String(row.delivered_at) } : {}),
  };
}

function normalizeAttachmentIds(attachmentIds: readonly string[]): string[] {
  if (!Array.isArray(attachmentIds) || attachmentIds.length === 0) {
    throw new Error("A provider submission requires at least one attachment");
  }
  for (const attachmentId of attachmentIds) requireIdentifier(attachmentId, "attachmentId");
  return [...new Set(attachmentIds)].sort();
}

function parseAttachmentIds(value: unknown): string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Stored provider submission has invalid attachment IDs");
  }
  return normalizeAttachmentIds(parsed);
}

function mapSubmission(row: Record<string, unknown>): ProviderSubmission {
  return {
    submissionId: String(row.submission_id),
    messageId: String(row.message_id),
    providerId: String(row.provider_id),
    attachmentIds: parseAttachmentIds(row.attachment_ids_json),
    state: String(row.state) as SubmissionState,
    createdAt: String(row.created_at),
  };
}

export class AttachmentDeliveryManager {
  constructor(private readonly db: DatabaseSync) {}

  public getOrCreateDelivery(attachmentId: string, providerId: string, conversationId: string): AttachmentDelivery {
    requireIdentifier(attachmentId, "attachmentId");
    requireIdentifier(providerId, "providerId");
    requireIdentifier(conversationId, "conversationId");

    const existing = this.db.prepare(`
      SELECT id, attachment_id, provider_id, conversation_id, status, provider_file_id, delivered_at
      FROM attachment_deliveries
      WHERE attachment_id = ? AND provider_id = ? AND conversation_id = ?
      ORDER BY id
      LIMIT 1
    `).get(attachmentId, providerId, conversationId) as Record<string, unknown> | undefined;
    if (existing) return mapDelivery(existing);

    // Deterministic IDs make identical concurrent creates collide safely on the
    // primary key even before the recommended composite UNIQUE migration lands.
    const id = stableId("del", [attachmentId, providerId, conversationId]);
    this.db.prepare(`
      INSERT OR IGNORE INTO attachment_deliveries (id, attachment_id, provider_id, conversation_id, status)
      VALUES (?, ?, ?, ?, 'PENDING')
    `).run(id, attachmentId, providerId, conversationId);

    const created = this.getDeliveryById(id);
    if (!created) throw new Error("Failed to create attachment delivery");
    return created;
  }

  public updateDeliveryStatus(deliveryId: string, status: DeliveryStatus, providerFileId?: string): void {
    requireIdentifier(deliveryId, "deliveryId");
    const current = this.getDeliveryById(deliveryId);
    if (!current) throw new Error(`Attachment delivery not found: ${deliveryId}`);

    if (providerFileId && status !== "DELIVERED") {
      throw new Error("providerFileId may only be recorded for a DELIVERED attachment");
    }
    if (current.status === status) {
      if (providerFileId && current.providerFileId && providerFileId !== current.providerFileId) {
        throw new Error("Conflicting providerFileId for an idempotent delivery update");
      }
      if (providerFileId && !current.providerFileId) {
        this.db.prepare("UPDATE attachment_deliveries SET provider_file_id = ? WHERE id = ?").run(providerFileId, deliveryId);
      }
      return;
    }
    if (!DELIVERY_TRANSITIONS[current.status].includes(status)) {
      throw new Error(`Invalid attachment delivery transition: ${current.status} -> ${status}`);
    }

    const deliveredAt = status === "DELIVERED" ? new Date().toISOString() : null;
    const result = this.db.prepare(`
      UPDATE attachment_deliveries
      SET status = ?, provider_file_id = ?, delivered_at = ?
      WHERE id = ? AND status = ?
    `).run(status, providerFileId || null, deliveredAt, deliveryId, current.status);
    if (result.changes !== 1) throw new Error("Concurrent attachment delivery transition detected");
  }

  public getDeliveriesForMessage(messageId: string, providerId: string): AttachmentDelivery[] {
    requireIdentifier(messageId, "messageId");
    requireIdentifier(providerId, "providerId");
    const rows = this.db.prepare(`
      SELECT d.id, d.attachment_id, d.provider_id, d.conversation_id, d.status, d.provider_file_id, d.delivered_at
      FROM attachment_deliveries d
      JOIN message_attachments a ON a.id = d.attachment_id
      WHERE a.message_id = ? AND d.provider_id = ?
      ORDER BY d.id
    `).all(messageId, providerId) as Array<Record<string, unknown>>;
    return rows.map(mapDelivery);
  }

  private getDeliveryById(deliveryId: string): AttachmentDelivery | null {
    const row = this.db.prepare(`
      SELECT id, attachment_id, provider_id, conversation_id, status, provider_file_id, delivered_at
      FROM attachment_deliveries WHERE id = ?
    `).get(deliveryId) as Record<string, unknown> | undefined;
    return row ? mapDelivery(row) : null;
  }
}

export class ProviderSubmissionManager {
  constructor(private readonly db: DatabaseSync) {}

  public createSubmission(messageId: string, providerId: string, attachmentIds: string[]): ProviderSubmission {
    requireIdentifier(messageId, "messageId");
    requireIdentifier(providerId, "providerId");
    const normalizedIds = normalizeAttachmentIds(attachmentIds);

    const existing = this.getSubmission(messageId, providerId);
    if (existing) {
      if (JSON.stringify(existing.attachmentIds) !== JSON.stringify(normalizedIds)) {
        throw new Error("Provider submission attachments are immutable for a message/provider pair");
      }
      return existing;
    }

    const submissionId = stableId("sub", [messageId, providerId, ...normalizedIds]);
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO provider_submissions
      (submission_id, message_id, provider_id, attachment_ids_json, state, created_at)
      VALUES (?, ?, ?, ?, 'PREPARING', ?)
    `).run(submissionId, messageId, providerId, JSON.stringify(normalizedIds), createdAt);

    const created = this.getSubmissionById(submissionId);
    if (!created) throw new Error("Failed to create provider submission");
    return created;
  }

  public updateState(submissionId: string, state: SubmissionState): void {
    requireIdentifier(submissionId, "submissionId");
    const current = this.getSubmissionById(submissionId);
    if (!current) throw new Error(`Provider submission not found: ${submissionId}`);
    if (current.state === state) return;
    if (!SUBMISSION_TRANSITIONS[current.state].includes(state)) {
      throw new Error(`Invalid provider submission transition: ${current.state} -> ${state}`);
    }
    const result = this.db.prepare(`
      UPDATE provider_submissions SET state = ?
      WHERE submission_id = ? AND state = ?
    `).run(state, submissionId, current.state);
    if (result.changes !== 1) throw new Error("Concurrent provider submission transition detected");
  }

  public markUnknown(submissionId: string): void {
    this.updateState(submissionId, "UNKNOWN");
  }

  /** UNKNOWN never retries implicitly. A caller must reconcile provider evidence first. */
  public canRetry(submissionId: string): boolean {
    return this.getSubmissionById(submissionId)?.state === "PREPARING";
  }

  public reconcileUnknown(submissionId: string, outcome: "CONFIRMED" | "NOT_SUBMITTED"): void {
    requireIdentifier(submissionId, "submissionId");
    const current = this.getSubmissionById(submissionId);
    if (!current) throw new Error(`Provider submission not found: ${submissionId}`);
    if (current.state !== "UNKNOWN") throw new Error("Only UNKNOWN submissions may be reconciled");
    const next: SubmissionState = outcome === "CONFIRMED" ? "CONFIRMED" : "PREPARING";
    const result = this.db.prepare(`
      UPDATE provider_submissions SET state = ?
      WHERE submission_id = ? AND state = 'UNKNOWN'
    `).run(next, submissionId);
    if (result.changes !== 1) throw new Error("Concurrent provider submission reconciliation detected");
  }

  public getSubmission(messageId: string, providerId: string): ProviderSubmission | null {
    const row = this.db.prepare(`
      SELECT submission_id, message_id, provider_id, attachment_ids_json, state, created_at
      FROM provider_submissions
      WHERE message_id = ? AND provider_id = ?
      ORDER BY created_at DESC, submission_id DESC
      LIMIT 1
    `).get(messageId, providerId) as Record<string, unknown> | undefined;
    return row ? mapSubmission(row) : null;
  }

  public getSubmissionById(submissionId: string): ProviderSubmission | null {
    const row = this.db.prepare(`
      SELECT submission_id, message_id, provider_id, attachment_ids_json, state, created_at
      FROM provider_submissions WHERE submission_id = ?
    `).get(submissionId) as Record<string, unknown> | undefined;
    return row ? mapSubmission(row) : null;
  }
}
