import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  LocalArtifactStore,
  assertSafeArtifactIdentifier,
  detectKindFromMimeAndExt,
  hasMimeExtensionMismatch,
  isUnsafeFileName,
  sanitizeFileName,
  sniffMimeType,
} from "../src/attachments/artifact-store.js";

describe("LocalArtifactStore & Attachment Security Controls", () => {
  let tmpDir: string;
  let store: LocalArtifactStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-artifact-test-"));
    store = new LocalArtifactStore(tmpDir);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("sanitizes unsafe file names while retaining extension", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("file<name>:bad?.png")).toBe("file_name_bad_.png");
    expect(sanitizeFileName("normal_document.pdf")).toBe("normal_document.pdf");
    expect(sanitizeFileName("готово к отправке.md")).toBe("готово_к_отправке.md");
    expect(sanitizeFileName("CON.txt")).toBe("file_CON.txt");
    expect(isUnsafeFileName("../secret.txt")).toBe(true);
    expect(isUnsafeFileName("normal document.txt")).toBe(false);
  });

  it("sniffs MIME type by magic byte signatures", () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMimeType(pngMagic, "unknown.bin")).toBe("image/png");

    const pdfMagic = Buffer.from("%PDF-1.4 header text");
    expect(sniffMimeType(pdfMagic, "doc.bin")).toBe("application/pdf");

    const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    expect(sniffMimeType(jpegMagic, "photo.jpg")).toBe("image/jpeg");
    expect(sniffMimeType(Buffer.from("# Markdown\nПривет"), "notes.md")).toBe("text/markdown");
  });

  it("detects attachment kinds accurately", () => {
    expect(detectKindFromMimeAndExt("image/png", ".png")).toBe("image");
    expect(detectKindFromMimeAndExt("application/pdf", ".pdf")).toBe("document");
    expect(detectKindFromMimeAndExt("text/plain", ".txt")).toBe("text");
    expect(detectKindFromMimeAndExt("application/zip", ".zip")).toBe("archive");
  });

  it("stages the required TXT, MD, PDF, PNG, and JPEG matrix with sniffed MIME", () => {
    const fixtures: Array<[string, Buffer, string]> = [
      ["notes.txt", Buffer.from("plain UTF-8 text"), "text/plain"],
      ["notes.md", Buffer.from("# Markdown\nтекст"), "text/markdown"],
      ["document.pdf", Buffer.from("%PDF-1.7\nfixture"), "application/pdf"],
      ["image.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), "image/png"],
      ["photo.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), "image/jpeg"],
    ];
    for (const [fileName, buffer, mimeType] of fixtures) {
      const ref = store.storeBuffer(buffer, {
        projectId: "proj-matrix",
        messageId: "msg-matrix",
        source: "user",
        originalFileName: fileName,
      });
      expect(ref.status, fileName).toBe("STAGED");
      expect(ref.mimeType, fileName).toBe(mimeType);
      expect(store.readVerifiedBuffer(ref), fileName).toEqual(buffer);
    }
  });

  it("stores file buffer atomically and computes sha256 checksum", () => {
    const buf = Buffer.from("Hello Attachment World!");
    const ref = store.storeBuffer(buf, {
      projectId: "proj-1",
      messageId: "msg-101",
      source: "user",
      originalFileName: "notes.txt",
    });

    expect(ref.projectId).toBe("proj-1");
    expect(ref.messageId).toBe("msg-101");
    expect(ref.fileName).toBe("notes.txt");
    expect(ref.sizeBytes).toBe(buf.length);
    expect(ref.status).toBe("STAGED");
    expect(ref.sha256).toBeDefined();

    const readBuf = store.readBuffer(ref.localRelativePath);
    expect(readBuf.toString()).toBe("Hello Attachment World!");
  });

  it("quarantines executable files with EXECUTABLE_BLOCKED reason", () => {
    const exeBuffer = Buffer.from("MZ_fake_exe_header");
    const ref = store.storeBuffer(exeBuffer, {
      projectId: "proj-1",
      messageId: "msg-102",
      source: "user",
      originalFileName: "malicious_script.bat",
    });

    expect(ref.status).toBe("QUARANTINED");
    expect(ref.quarantineReason).toBe("EXECUTABLE_BLOCKED");
  });

  it("quarantines oversized files with SIZE_LIMIT reason", () => {
    const bigBuf = Buffer.alloc(2000);
    const ref = store.storeBuffer(bigBuf, {
      projectId: "proj-1",
      messageId: "msg-103",
      source: "user",
      originalFileName: "large_file.dat",
      customMaxSizeBytes: 1000,
    });

    expect(ref.status).toBe("QUARANTINED");
    expect(ref.quarantineReason).toBe("SIZE_LIMIT");
    expect(ref.localRelativePath).toContain("_quarantine");
  });

  it("rejects an oversized source path before reading it into managed storage", () => {
    const sourcePath = path.join(os.tmpdir(), `gplusg-oversized-${Date.now()}.txt`);
    fs.writeFileSync(sourcePath, Buffer.alloc(32));
    try {
      expect(() => store.storeFileFromPath(sourcePath, {
        projectId: "proj-1",
        messageId: "msg-source",
        source: "user",
        originalFileName: "large.txt",
        customMaxSizeBytes: 10,
      })).toThrow("exceeds 10 bytes");
      expect(fs.readdirSync(tmpDir)).toEqual([]);
    } finally {
      fs.unlinkSync(sourcePath);
    }
  });

  it("rejects unsafe project/message identifiers before creating any artifact path", () => {
    expect(() => assertSafeArtifactIdentifier("../outside", "projectId")).toThrow("unsafe path component");
    expect(() => store.storeBuffer(Buffer.from("secret"), {
      projectId: "../outside",
      messageId: "msg-1",
      source: "user",
      originalFileName: "notes.txt",
    })).toThrow("unsafe path component");
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });

  it("content-deduplicates equal artifacts while preserving independent references", () => {
    const buffer = Buffer.from("same immutable content");
    const first = store.storeBuffer(buffer, {
      projectId: "proj-1",
      messageId: "msg-1",
      source: "user",
      originalFileName: "same.txt",
    });
    const second = store.storeBuffer(buffer, {
      projectId: "proj-1",
      messageId: "msg-2",
      source: "user",
      originalFileName: "same.txt",
    });

    expect(second.id).not.toBe(first.id);
    expect(second.localRelativePath).toBe(first.localRelativePath);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
  });

  it("quarantines MIME mismatches and executable content disguised as text", () => {
    const pdfNamedPng = store.storeBuffer(Buffer.from("%PDF-1.7\nbody"), {
      projectId: "proj-1",
      messageId: "msg-mismatch",
      source: "user",
      originalFileName: "fake.png",
    });
    expect(hasMimeExtensionMismatch(pdfNamedPng.mimeType, pdfNamedPng.fileName)).toBe(true);
    expect(pdfNamedPng.status).toBe("QUARANTINED");
    expect(pdfNamedPng.quarantineReason).toBe("MIME_MISMATCH");

    const disguisedExe = store.storeBuffer(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), {
      projectId: "proj-1",
      messageId: "msg-exe",
      source: "user",
      originalFileName: "harmless.txt",
    });
    expect(disguisedExe.mimeType).toBe("application/x-executable");
    expect(disguisedExe.quarantineReason).toBe("EXECUTABLE_BLOCKED");
  });

  it("quarantines unsafe original names but stores them under a safe managed name", () => {
    const ref = store.storeBuffer(Buffer.from("content"), {
      projectId: "proj-1",
      messageId: "msg-name",
      source: "user",
      originalFileName: "../unsafe.txt",
    });
    expect(ref.quarantineReason).toBe("UNSAFE_FILENAME");
    expect(path.basename(ref.localRelativePath)).toBe("unsafe.txt");
    expect(store.readBuffer(ref.localRelativePath).toString()).toBe("content");
  });

  it("detects post-staging mutation before delivery", () => {
    const ref = store.storeBuffer(Buffer.from("approved bytes"), {
      projectId: "proj-1",
      messageId: "msg-integrity",
      source: "user",
      originalFileName: "approved.txt",
    });
    fs.writeFileSync(store.resolveAbsolutePath(ref.localRelativePath), "modified bytes");

    expect(store.verifyIntegrity(ref)).toMatchObject({ valid: false, reason: "SHA256_MISMATCH" });
    expect(() => store.readVerifiedBuffer(ref)).toThrow("integrity check failed");
  });

  it("rejects path traversal attempts on resolveAbsolutePath", () => {
    expect(() => {
      store.resolveAbsolutePath("../../secret_credentials.txt");
    }).toThrow("Security path violation");
  });
});
