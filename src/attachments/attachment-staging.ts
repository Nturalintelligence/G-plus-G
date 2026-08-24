import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { LocalArtifactStore } from "./artifact-store.js";
import type { AttachmentRefV1, QuarantineReason } from "./attachments.js";

export const MAX_CLIPBOARD_ATTACHMENT_BYTES = 16 * 1024 * 1024;
export const DRAFT_ATTACHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RendererAttachmentDto {
  id: string;
  messageId: string;
  projectId: string;
  kind: AttachmentRefV1["kind"];
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  source: AttachmentRefV1["source"];
  status: AttachmentRefV1["status"] | "UNSUPPORTED";
  previewUrl?: string;
  quarantineReason?: QuarantineReason;
  error?: string;
}

export interface StageOwner {
  projectId: string;
  messageId: string;
}

export function normalizeClipboardBytes(value: unknown): Buffer {
  let bytes: Buffer;
  if (value instanceof Uint8Array) {
    bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  } else if (value instanceof ArrayBuffer) {
    bytes = Buffer.from(value);
  } else {
    throw new Error("Clipboard attachment must be binary data");
  }
  if (bytes.length === 0) throw new Error("Clipboard attachment is empty");
  if (bytes.length > MAX_CLIPBOARD_ATTACHMENT_BYTES) {
    throw new Error("Clipboard attachment exceeds the size limit");
  }
  return bytes;
}

export function toRendererAttachment(ref: AttachmentRefV1): RendererAttachmentDto {
  return {
    id: ref.id,
    messageId: ref.messageId,
    projectId: ref.projectId,
    kind: ref.kind,
    fileName: ref.fileName,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    source: ref.source,
    status: ref.status,
    ...(ref.kind === "image" && ref.status !== "FAILED" && ref.status !== "QUARANTINED"
      ? { previewUrl: `attachment-preview://local/${encodeURIComponent(ref.id)}` }
      : {}),
    ...(ref.quarantineReason ? { quarantineReason: ref.quarantineReason } : {}),
    ...(ref.status === "FAILED" || ref.status === "QUARANTINED"
      ? { error: ref.quarantineReason ?? ref.status }
      : {}),
  };
}

export class AttachmentStagingService {
  constructor(
    private readonly database: DatabaseSync,
    private readonly store: LocalArtifactStore = new LocalArtifactStore(),
  ) {}

  public stagePath(filePath: string, owner: StageOwner): RendererAttachmentDto {
    const ref = this.store.storeFileFromPath(filePath, {
      ...owner,
      source: "user",
      originalFileName: path.basename(filePath),
    });
    const existing = this.findExisting(owner, ref.sha256);
    if (existing) return existing;
    this.persist(ref);
    return toRendererAttachment(ref);
  }

  public stageBytes(
    value: unknown,
    owner: StageOwner,
    originalFileName: string,
  ): RendererAttachmentDto {
    const ref = this.store.storeBuffer(normalizeClipboardBytes(value), {
      ...owner,
      source: "user",
      originalFileName,
      customMaxSizeBytes: MAX_CLIPBOARD_ATTACHMENT_BYTES,
    });
    const existing = this.findExisting(owner, ref.sha256);
    if (existing) return existing;
    this.persist(ref);
    return toRendererAttachment(ref);
  }

  private findExisting(owner: StageOwner, sha256: string): RendererAttachmentDto | null {
    const row = this.database.prepare(`
      SELECT id, message_id, project_id, kind, file_name, mime_type, size_bytes, source, status, quarantine_reason
      FROM message_attachments WHERE project_id = ? AND message_id = ? AND sha256 = ?
      ORDER BY created_at LIMIT 1
    `).get(owner.projectId, owner.messageId, sha256) as Record<string, unknown> | undefined;
    if (!row) return null;
    const status = String(row.status) as AttachmentRefV1["status"];
    const dto: RendererAttachmentDto = {
      id: String(row.id), messageId: String(row.message_id), projectId: String(row.project_id),
      kind: row.kind as AttachmentRefV1["kind"], fileName: String(row.file_name),
      mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes),
      source: row.source as AttachmentRefV1["source"], status,
      ...(row.quarantine_reason ? { quarantineReason: String(row.quarantine_reason) as QuarantineReason } : {}),
    };
    return dto.kind === "image" && status !== "FAILED" && status !== "QUARANTINED"
      ? { ...dto, previewUrl: `attachment-preview://local/${encodeURIComponent(dto.id)}` }
      : dto;
  }

  private persist(ref: AttachmentRefV1): void {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DRAFT_ATTACHMENT_TTL_MS).toISOString();
    this.database.prepare(`
      INSERT INTO message_attachments
      (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256,
       local_relative_path, source, status, quarantine_reason, created_at, draft_expires_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ref.id, ref.messageId, ref.projectId, ref.kind, ref.fileName, ref.mimeType,
      ref.sizeBytes, ref.sha256, ref.localRelativePath, ref.source, ref.status,
      ref.quarantineReason ?? null, now.toISOString(), expiresAt, now.toISOString(),
    );
  }
}
