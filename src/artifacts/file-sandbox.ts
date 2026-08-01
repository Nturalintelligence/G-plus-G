import { resolve, relative, extname } from "node:path";

export const ALLOWED_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".docx",
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
]);

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB limit

export class FileSandbox {
  constructor(private readonly sandboxRoot: string) {}

  isAllowedExtension(filename: string): boolean {
    const ext = extname(filename).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
  }

  isSafePath(targetPath: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(this.sandboxRoot);
    const rel = relative(resolvedRoot, resolvedTarget);
    return !rel.startsWith("..") && !rel.includes(":\\");
  }

  validateUpload(filename: string, sizeBytes: number): { valid: boolean; reason?: string } {
    if (!this.isAllowedExtension(filename)) {
      return { valid: false, reason: `Extension '${extname(filename)}' is not allowed by File Sandbox policy` };
    }
    if (sizeBytes > MAX_FILE_SIZE_BYTES) {
      return { valid: false, reason: `File size ${sizeBytes} exceeds maximum allowed limit of ${MAX_FILE_SIZE_BYTES} bytes` };
    }
    return { valid: true };
  }
}
