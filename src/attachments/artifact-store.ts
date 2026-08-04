import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../paths.js";
import { AttachmentKind, AttachmentRefV1, AttachmentSource, AttachmentStatus, QuarantineReason } from "./attachments.js";
import { isPathSafeRelativeToWorkspace } from "../cli-executors/cli-task-schema.js";

export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".ps1", ".vbs", ".dll", ".com", ".scr", ".msi", ".jar", ".sys", ".drv"
]);

export interface StoreFileOptions {
  projectId: string;
  messageId: string;
  source: AttachmentSource;
  originalFileName: string;
  customMaxSizeBytes?: number;
}

export function sanitizeFileName(name: string): string {
  if (!name) return "unnamed_file";
  const basename = path.basename(name);
  return basename
    .replace(/[^a-zA-Z0-9_\-\.]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\.+/g, ".")
    .slice(0, 100);
}

export function detectKindFromMimeAndExt(mimeType: string, ext: string): AttachmentKind {
  const lowerMime = mimeType.toLowerCase();
  const lowerExt = ext.toLowerCase();

  if (lowerMime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(lowerExt)) {
    return "image";
  }
  if (lowerMime.startsWith("audio/") || [".mp3", ".wav", ".ogg", ".m4a"].includes(lowerExt)) {
    return "audio";
  }
  if (lowerMime.startsWith("video/") || [".mp4", ".webm", ".mkv", ".avi"].includes(lowerExt)) {
    return "video";
  }
  if (
    lowerMime.includes("json") ||
    lowerMime.includes("text") ||
    lowerMime.includes("javascript") ||
    lowerMime.includes("typescript") ||
    [".txt", ".md", ".json", ".csv", ".ts", ".js", ".html", ".css", ".py"].includes(lowerExt)
  ) {
    return "text";
  }
  if (
    lowerMime.includes("zip") ||
    lowerMime.includes("tar") ||
    lowerMime.includes("compressed") ||
    [".zip", ".tar", ".gz", ".7z", ".rar"].includes(lowerExt)
  ) {
    return "archive";
  }
  if (
    lowerMime.includes("pdf") ||
    lowerMime.includes("word") ||
    lowerMime.includes("spreadsheet") ||
    [".pdf", ".doc", ".docx", ".xls", ".xlsx"].includes(lowerExt)
  ) {
    return "document";
  }

  return "binary";
}

export function sniffMimeType(buffer: Buffer, originalFileName: string): string {
  if (buffer.length >= 4) {
    // Magic byte signatures
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return "image/jpeg";
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "image/gif";
    }
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return "application/pdf";
    }
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) {
      return "application/zip";
    }
  }

  const ext = path.extname(originalFileName).toLowerCase();
  switch (ext) {
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

export class LocalArtifactStore {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || dataPath("artifacts");
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  public getBaseDir(): string {
    return this.baseDir;
  }

  public resolveAbsolutePath(relativeStorePath: string): string {
    if (!isPathSafeRelativeToWorkspace(relativeStorePath, this.baseDir)) {
      throw new Error(`Security path violation: artifact relative path '${relativeStorePath}' escapes store directory`);
    }
    return path.resolve(this.baseDir, relativeStorePath);
  }

  /**
   * Stores a file buffer into the managed local artifact store.
   */
  public storeBuffer(fileBuffer: Buffer, options: StoreFileOptions): AttachmentRefV1 {
    const attachmentId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const originalExt = path.extname(options.originalFileName).toLowerCase();
    const sanitizedName = sanitizeFileName(options.originalFileName);

    const relativeDir = path.join(options.projectId, options.messageId, attachmentId);
    const targetDir = path.resolve(this.baseDir, relativeDir);

    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const targetFilePath = path.join(targetDir, sanitizedName);
    const tempFilePath = `${targetFilePath}.tmp_${Date.now()}`;

    // Atomic write
    fs.writeFileSync(tempFilePath, fileBuffer);
    fs.renameSync(tempFilePath, targetFilePath);

    const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const mimeType = sniffMimeType(fileBuffer, options.originalFileName);
    const kind = detectKindFromMimeAndExt(mimeType, originalExt);

    let status: AttachmentStatus = "STAGED";
    let quarantineReason: QuarantineReason | undefined = undefined;

    // Security check for executable files
    if (EXECUTABLE_EXTENSIONS.has(originalExt)) {
      status = "QUARANTINED";
      quarantineReason = "EXECUTABLE_BLOCKED";
    }

    // Size limit check
    const maxSize = options.customMaxSizeBytes || 52_428_800; // 50MB default
    if (fileBuffer.length > maxSize) {
      status = "QUARANTINED";
      quarantineReason = "SIZE_LIMIT";
    }

    const localRelativePath = path.relative(this.baseDir, targetFilePath);

    const ref: AttachmentRefV1 = {
      id: attachmentId,
      messageId: options.messageId,
      projectId: options.projectId,
      kind,
      fileName: options.originalFileName,
      mimeType,
      sizeBytes: fileBuffer.length,
      sha256,
      localRelativePath,
      source: options.source,
      status,
    };

    if (quarantineReason) {
      ref.quarantineReason = quarantineReason;
    }

    return ref;
  }

  /**
   * Reads stored attachment buffer safely.
   */
  public readBuffer(relativeStorePath: string): Buffer {
    const fullPath = this.resolveAbsolutePath(relativeStorePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Artifact file not found: '${relativeStorePath}'`);
    }
    return fs.readFileSync(fullPath);
  }
}
