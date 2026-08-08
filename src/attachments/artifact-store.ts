import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataPath } from "../paths.js";
import { isPathSafeRelativeToWorkspace } from "../cli-executors/cli-task-schema.js";
import type {
  AttachmentKind,
  AttachmentRefV1,
  AttachmentSource,
  AttachmentStatus,
  QuarantineReason,
} from "./attachments.js";

export const DEFAULT_MAX_ARTIFACT_BYTES = 52_428_800;

export const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".ps1", ".vbs", ".dll", ".com", ".scr", ".msi", ".jar", ".sys", ".drv",
]);

const MANUAL_REVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  ".html", ".htm", ".svg", ".zip", ".tar", ".gz", ".7z", ".rar",
]);

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const EXPECTED_MIME_BY_EXTENSION: Readonly<Record<string, readonly string[]>> = {
  ".png": ["image/png"],
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".gif": ["image/gif"],
  ".pdf": ["application/pdf"],
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/plain"],
  ".csv": ["text/csv", "text/plain"],
  ".json": ["application/json", "text/plain"],
  ".svg": ["image/svg+xml", "text/plain"],
  ".html": ["text/html", "text/plain"],
  ".htm": ["text/html", "text/plain"],
  ".zip": ["application/zip"],
  ".docx": ["application/zip"],
  ".xlsx": ["application/zip"],
};

export interface StoreFileOptions {
  projectId: string;
  messageId: string;
  source: AttachmentSource;
  originalFileName: string;
  customMaxSizeBytes?: number;
}

export interface ArtifactIntegrityResult {
  valid: boolean;
  reason?: "MISSING" | "SIZE_MISMATCH" | "SHA256_MISMATCH" | "MIME_MISMATCH";
  actualSha256?: string;
  actualSizeBytes?: number;
  actualMimeType?: string;
}

/**
 * Artifact path components are identifiers, never filesystem paths. Keeping
 * this check next to storage prevents an IPC validation omission from becoming
 * a write outside the managed artifact root.
 */
export function assertSafeArtifactIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error(`${label} must be a non-empty identifier of at most 200 characters`);
  }
  if (
    value === "." ||
    value === ".." ||
    value.trim() !== value ||
    value.includes("..") ||
    /[\\/:\0]/.test(value) ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} contains an unsafe path component`);
  }
}

function portableBasename(name: string): string {
  return path.win32.basename(path.posix.basename(name));
}

export function isUnsafeFileName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.includes("\0")) return true;
  const normalized = name.normalize("NFC");
  const basename = portableBasename(normalized);
  return (
    basename !== normalized ||
    basename === "." ||
    basename === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/u.test(basename) ||
    /[ .]$/u.test(basename) ||
    WINDOWS_RESERVED_NAMES.test(basename)
  );
}

export function sanitizeFileName(name: string): string {
  const normalized = typeof name === "string" ? name.normalize("NFC") : "";
  const basename = portableBasename(normalized);
  let safe = basename
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
    .replace(/\s+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/\.{2,}/gu, ".")
    .replace(/[ .]+$/gu, "")
    .replace(/^\.+$/gu, "");

  if (!safe || WINDOWS_RESERVED_NAMES.test(safe)) safe = `file_${safe || "unnamed"}`;
  if (safe.length > 100) {
    const ext = path.extname(safe).slice(0, 20);
    safe = `${safe.slice(0, Math.max(1, 100 - ext.length))}${ext}`;
  }
  return safe;
}

export function detectKindFromMimeAndExt(mimeType: string, ext: string): AttachmentKind {
  const lowerMime = mimeType.toLowerCase();
  const lowerExt = ext.toLowerCase();

  if (lowerMime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(lowerExt)) return "image";
  if (lowerMime.startsWith("audio/") || [".mp3", ".wav", ".ogg", ".m4a"].includes(lowerExt)) return "audio";
  if (lowerMime.startsWith("video/") || [".mp4", ".webm", ".mkv", ".avi"].includes(lowerExt)) return "video";
  if (
    lowerMime.includes("json") || lowerMime.includes("text") || lowerMime.includes("javascript") ||
    lowerMime.includes("typescript") || [".txt", ".md", ".json", ".csv", ".ts", ".js", ".html", ".css", ".py"].includes(lowerExt)
  ) return "text";
  if (
    lowerMime.includes("zip") || lowerMime.includes("tar") || lowerMime.includes("compressed") ||
    [".zip", ".tar", ".gz", ".7z", ".rar"].includes(lowerExt)
  ) return "archive";
  if (
    lowerMime.includes("pdf") || lowerMime.includes("word") || lowerMime.includes("spreadsheet") ||
    [".pdf", ".doc", ".docx", ".xls", ".xlsx"].includes(lowerExt)
  ) return "document";
  return "binary";
}

export function hasExecutableSignature(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const firstFour = buffer.subarray(0, 4);
  return (
    (buffer[0] === 0x4d && buffer[1] === 0x5a) || // PE/DOS MZ
    firstFour.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) || // ELF
    firstFour.equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) || // Mach-O 64 LE
    firstFour.equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])) || // Mach-O 64 BE
    firstFour.equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) // Mach-O universal / Java class
  );
}

function isLikelyUtf8Text(buffer: Buffer): boolean {
  if (buffer.length === 0) return true;
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

export function sniffMimeType(buffer: Buffer, originalFileName: string): string {
  if (hasExecutableSignature(buffer)) return "application/x-executable";
  if (buffer.length >= 4) {
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "image/gif";
    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "application/pdf";
    if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return "application/zip";
  }

  const ext = path.extname(originalFileName).toLowerCase();
  if (isLikelyUtf8Text(buffer)) {
    if (ext === ".json") return "application/json";
    if (ext === ".md") return "text/markdown";
    if (ext === ".csv") return "text/csv";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".html" || ext === ".htm") return "text/html";
    return "text/plain";
  }
  return "application/octet-stream";
}

export function hasMimeExtensionMismatch(mimeType: string, originalFileName: string): boolean {
  const ext = path.extname(originalFileName).toLowerCase();
  const expected = EXPECTED_MIME_BY_EXTENSION[ext];
  return Boolean(expected && !expected.includes(mimeType.toLowerCase()));
}

function classifyQuarantine(
  buffer: Buffer,
  originalFileName: string,
  mimeType: string,
  maxSizeBytes: number,
): QuarantineReason | undefined {
  const ext = path.extname(originalFileName).toLowerCase();
  if (EXECUTABLE_EXTENSIONS.has(ext) || hasExecutableSignature(buffer)) return "EXECUTABLE_BLOCKED";
  if (buffer.length > maxSizeBytes) return "SIZE_LIMIT";
  if (isUnsafeFileName(originalFileName)) return "UNSAFE_FILENAME";
  if (hasMimeExtensionMismatch(mimeType, originalFileName)) return "MIME_MISMATCH";
  if (MANUAL_REVIEW_EXTENSIONS.has(ext)) return "MANUAL_REVIEW_REQUIRED";
  return undefined;
}

export class LocalArtifactStore {
  private readonly baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = path.resolve(customBaseDir || dataPath("artifacts"));
    fs.mkdirSync(this.baseDir, { recursive: true });
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
   * Main-process staging entrypoint for picker/drop paths. It rejects symlinks,
   * non-files, and oversized input before reading the source into memory.
   */
  public storeFileFromPath(sourceFilePath: string, options: StoreFileOptions): AttachmentRefV1 {
    if (typeof sourceFilePath !== "string" || sourceFilePath.length === 0 || !path.isAbsolute(sourceFilePath)) {
      throw new Error("Attachment source must be an absolute path selected through a trusted native API");
    }
    const stat = fs.lstatSync(sourceFilePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("Attachment source must be a regular non-symlink file");
    }
    const maxBytes = options.customMaxSizeBytes ?? DEFAULT_MAX_ARTIFACT_BYTES;
    if (stat.size > maxBytes) throw new Error(`Attachment exceeds ${maxBytes} bytes`);
    return this.storeBuffer(fs.readFileSync(sourceFilePath), options);
  }

  public storeBuffer(fileBuffer: Buffer, options: StoreFileOptions): AttachmentRefV1 {
    assertSafeArtifactIdentifier(options.projectId, "projectId");
    assertSafeArtifactIdentifier(options.messageId, "messageId");
    if (!Buffer.isBuffer(fileBuffer)) throw new Error("Artifact content must be a Buffer");
    if (typeof options.originalFileName !== "string" || options.originalFileName.length === 0) {
      throw new Error("originalFileName must be a non-empty string");
    }

    const attachmentId = `att_${crypto.randomUUID()}`;
    const sha256 = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    const mimeType = sniffMimeType(fileBuffer, options.originalFileName);
    const originalExt = path.extname(options.originalFileName).toLowerCase();
    const kind = detectKindFromMimeAndExt(mimeType, originalExt);
    const quarantineReason = classifyQuarantine(
      fileBuffer,
      options.originalFileName,
      mimeType,
      options.customMaxSizeBytes ?? DEFAULT_MAX_ARTIFACT_BYTES,
    );
    const status: AttachmentStatus = quarantineReason ? "QUARANTINED" : "STAGED";
    const sanitizedName = sanitizeFileName(options.originalFileName);
    const bucket = quarantineReason ? "_quarantine" : "_blobs";
    const relativeStorePath = path.join(options.projectId, bucket, sha256, sanitizedName);

    if (!isPathSafeRelativeToWorkspace(relativeStorePath, this.baseDir)) {
      throw new Error("Security path violation while constructing artifact target");
    }
    const targetFilePath = path.resolve(this.baseDir, relativeStorePath);
    const targetDir = path.dirname(targetFilePath);
    fs.mkdirSync(targetDir, { recursive: true });

    let deduplicated = false;
    if (fs.existsSync(targetFilePath)) {
      const existing = fs.readFileSync(targetFilePath);
      const existingSha = crypto.createHash("sha256").update(existing).digest("hex");
      if (existingSha !== sha256) throw new Error("Artifact content-address collision detected");
      deduplicated = true;
    } else {
      const tempFilePath = `${targetFilePath}.tmp_${crypto.randomUUID()}`;
      try {
        fs.writeFileSync(tempFilePath, fileBuffer, { flag: "wx", mode: 0o600 });
        fs.renameSync(tempFilePath, targetFilePath);
      } finally {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      }
    }

    const ref: AttachmentRefV1 = {
      id: attachmentId,
      messageId: options.messageId,
      projectId: options.projectId,
      kind,
      fileName: options.originalFileName,
      mimeType,
      sizeBytes: fileBuffer.length,
      sha256,
      localRelativePath: path.relative(this.baseDir, targetFilePath),
      source: options.source,
      status,
      deduplicated,
    };
    if (quarantineReason) ref.quarantineReason = quarantineReason;
    return ref;
  }

  public verifyIntegrity(ref: AttachmentRefV1): ArtifactIntegrityResult {
    let buffer: Buffer;
    try {
      buffer = this.readBuffer(ref.localRelativePath);
    } catch {
      return { valid: false, reason: "MISSING" };
    }
    const actualSizeBytes = buffer.length;
    const actualSha256 = crypto.createHash("sha256").update(buffer).digest("hex");
    const actualMimeType = sniffMimeType(buffer, ref.fileName);
    const evidence = { actualSha256, actualSizeBytes, actualMimeType };
    if (actualSizeBytes !== ref.sizeBytes) return { valid: false, reason: "SIZE_MISMATCH", ...evidence };
    if (actualSha256 !== ref.sha256) return { valid: false, reason: "SHA256_MISMATCH", ...evidence };
    if (actualMimeType !== ref.mimeType) return { valid: false, reason: "MIME_MISMATCH", ...evidence };
    return { valid: true, ...evidence };
  }

  public readVerifiedBuffer(ref: AttachmentRefV1): Buffer {
    const integrity = this.verifyIntegrity(ref);
    if (!integrity.valid) throw new Error(`Artifact integrity check failed: ${integrity.reason}`);
    return this.readBuffer(ref.localRelativePath);
  }

  public readBuffer(relativeStorePath: string): Buffer {
    const fullPath = this.resolveAbsolutePath(relativeStorePath);
    if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
      throw new Error(`Artifact file not found: '${relativeStorePath}'`);
    }
    return fs.readFileSync(fullPath);
  }
}
