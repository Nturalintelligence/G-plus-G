import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { LocalArtifactStore, detectKindFromMimeAndExt, sanitizeFileName, sniffMimeType } from "../src/attachments/artifact-store.js";

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
  });

  it("sniffs MIME type by magic byte signatures", () => {
    const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    expect(sniffMimeType(pngMagic, "unknown.bin")).toBe("image/png");

    const pdfMagic = Buffer.from("%PDF-1.4 header text");
    expect(sniffMimeType(pdfMagic, "doc.bin")).toBe("application/pdf");
  });

  it("detects attachment kinds accurately", () => {
    expect(detectKindFromMimeAndExt("image/png", ".png")).toBe("image");
    expect(detectKindFromMimeAndExt("application/pdf", ".pdf")).toBe("document");
    expect(detectKindFromMimeAndExt("text/plain", ".txt")).toBe("text");
    expect(detectKindFromMimeAndExt("application/zip", ".zip")).toBe("archive");
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
  });

  it("rejects path traversal attempts on resolveAbsolutePath", () => {
    expect(() => {
      store.resolveAbsolutePath("../../secret_credentials.txt");
    }).toThrow("Security path violation");
  });
});
