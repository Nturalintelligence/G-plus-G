import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppDatabase } from "../src/storage/database.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { ResponseArtifactDownloader } from "../src/attachments/artifact-downloader.js";

const body = Buffer.from("G_PLUS_G_INBOUND_FINAL_2026");

describe("completed browser download staging lifecycle", () => {
  let root: string; let db: AppDatabase; let downloader: ResponseArtifactDownloader;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-download-staging-")); db = new AppDatabase(":memory:"); db.migrate();
    db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
    downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(root));
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { projectId: "p", messageId: "turn", providerId: "gemini", expectArtifact: true } as const;
  const persist = (download: any, overrides = {}) => (downloader as any).persistBrowserDownload(download, { ...options, ...overrides }, ["gemini.google.com"]);

  it("waits for delayed saveAs completion, validates 27 bytes and removes staging", async () => {
    let completed = false;
    const download = {
      url: () => "", suggestedFilename: () => "gplusg-inbound-final.txt", failure: vi.fn(async () => null), cancel: vi.fn(),
      saveAs: vi.fn(async (target: string) => { await new Promise((resolve) => setTimeout(resolve, 80)); fs.writeFileSync(target, body); completed = true; }),
    };
    const record = await persist(download);
    expect(completed).toBe(true); expect(download.failure).toHaveBeenCalledOnce();
    expect(record).toMatchObject({ status: "READY", sizeBytes: 27, mimeType: "text/plain", sha256: "8e2f74f110636e05fb49232d1435d280aae71b94b63156b2ea536676e007a21d" });
    expect(fs.readdirSync(path.join(root, "_staging"))).toEqual([]);
  });

  it("classifies zero bytes, cancellation, timeout and oversized staging precisely", async () => {
    const zero = await persist({ url: () => "", suggestedFilename: () => "zero.txt", saveAs: async (target: string) => fs.writeFileSync(target, Buffer.alloc(0)), failure: async () => null, cancel: vi.fn() }).catch((e: any) => e);
    expect(zero.reason).toBe("DOWNLOAD_STAGING_EMPTY");
    const canceled = await persist({ url: () => "", suggestedFilename: () => "x.txt", saveAs: async () => { throw new Error("failed"); }, failure: async () => "canceled", cancel: vi.fn() }).catch((e: any) => e);
    expect(canceled.reason).toBe("DOWNLOAD_BROWSER_CANCELED");
    const cancel = vi.fn(async () => undefined);
    const timeout = await persist({ url: () => "", suggestedFilename: () => "x.txt", saveAs: async () => await new Promise(() => undefined), failure: async () => null, cancel }, { downloadCompletionTimeoutMs: 1_000 }).catch((e: any) => e);
    expect(timeout.reason).toBe("DOWNLOAD_COMPLETION_TIMEOUT"); expect(cancel).toHaveBeenCalledOnce();
    const largeCancel = vi.fn(async () => undefined);
    const large = await persist({ url: () => "", suggestedFilename: () => "large.txt", saveAs: async (target: string) => fs.writeFileSync(target, Buffer.alloc(64)), failure: async () => null, cancel: largeCancel }, { maxBytes: 32 }).catch((e: any) => e);
    expect(large.reason).toBe("ARTIFACT_TOO_LARGE"); expect(largeCancel).toHaveBeenCalled();
    expect(fs.readdirSync(path.join(root, "_staging"))).toEqual([]);
  });

  it("uses completed local path only after saveAs failure and null failure()", async () => {
    const source = path.join(root, "browser-complete.txt"); fs.writeFileSync(source, body);
    const record = await persist({ url: () => "", suggestedFilename: () => "fallback.txt", saveAs: async () => { throw new Error("copy failed"); }, failure: async () => null, path: async () => source, cancel: vi.fn() });
    expect(record).toMatchObject({ status: "READY", sizeBytes: 27 });
    expect(fs.readdirSync(path.join(root, "_staging"))).toEqual([]);
  });
});
