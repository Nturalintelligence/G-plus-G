import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Locator, Page } from "playwright";
import { ResponseArtifactDownloader, type ArtifactDownloadState } from "../src/attachments/artifact-downloader.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { AppDatabase } from "../src/storage/database.js";

const publicIp = async () => ["93.184.216.34"];
const txt = Buffer.from("G_PLUS_G_INBOUND_FINAL_2026\n");
const response = (url: string, mime = "text/plain", body = txt, disposition = 'attachment; filename="gplusg-inbound-final.txt"') => ({
  ok: () => true, url: () => url, headers: () => ({ "content-type": mime, "content-length": String(body.length), "content-disposition": disposition }), body: async () => body,
});

class FakeContext extends EventEmitter {
  request = { get: vi.fn() };
}
class FakePage extends EventEmitter {
  readonly fakeContext = new FakeContext();
  currentUrl = "https://chatgpt.com/c/fixture";
  context = () => this.fakeContext;
  url = () => this.currentUrl;
  mainFrame = () => this;
  goto = vi.fn(async (url: string) => { this.currentUrl = url; });
}

describe("ChatGPT browser-owned multi-channel artifact capture", () => {
  let root: string;
  let db: AppDatabase;
  let store: LocalArtifactStore;
  let downloader: ResponseArtifactDownloader;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-multichannel-"));
    db = new AppDatabase(":memory:"); db.migrate();
    db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
    store = new LocalArtifactStore(root);
    downloader = new ResponseArtifactDownloader(db.raw, store, { resolveHostname: publicIp });
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { projectId: "p", messageId: "assistant", providerId: "chatgpt", downloadEventTimeoutMs: 400 } as const;
  const trigger = (page: FakePage, action: () => void, attributes = { href: null as string | null, src: null as string | null, download: null as string | null }) => ({
    isVisible: async () => true, isEnabled: async () => true,
    evaluate: async () => ({ ...attributes }),
    click: vi.fn(async () => action()),
  }) as unknown as Locator;

  it("captures a standard download with one physical click and cleans every listener", async () => {
    const page = new FakePage();
    const download = { url: () => "", suggestedFilename: () => "gplusg-inbound-final.txt", createReadStream: async () => Readable.from([txt]) };
    const control = trigger(page, () => page.emit("download", download));
    const states: ArtifactDownloadState[] = [];
    const result = await downloader.captureDownloadFromLocator(page as unknown as Page, control, { ...options, onStateChange: (state) => states.push(state) });
    expect(result).toMatchObject({ status: "READY", mimeType: "text/plain", sizeBytes: txt.length });
    expect((control.click as any)).toHaveBeenCalledOnce();
    expect(states).toEqual(["DOWNLOAD_CONTROL_READY", "DOWNLOAD_TRIGGERED", "CAPTURE_WAITING", "ARTIFACT_VALIDATING", "ARTIFACT_STORED"]);
    expect(page.eventNames()).toEqual([]); expect(page.fakeContext.eventNames()).toEqual([]);
  });

  it("captures fetch/XHR and service-worker-like responses with Content-Disposition", async () => {
    for (const url of ["https://files.oaiusercontent.com/download/result", "https://chatgpt.com/backend-api/files/result/download"]) {
      const page = new FakePage();
      const result = await downloader.captureDownloadFromLocator(page as unknown as Page, trigger(page, () => page.emit("response", response(url))), options);
      expect(result).toMatchObject({ status: "READY", fileName: "gplusg-inbound-final.txt" });
    }
  });

  it("ignores unrelated simultaneous responses before accepting the correlated file", async () => {
    const page = new FakePage();
    const control = trigger(page, () => {
      page.emit("response", response("https://chatgpt.com/analytics", "application/json", Buffer.from("{}"), ""));
      page.emit("response", response("https://chatgpt.com/avatar.png", "image/png", Buffer.from([1]), ""));
      page.emit("response", response("https://files.oaiusercontent.com/file/result", "text/plain", txt));
    });
    await expect(downloader.captureDownloadFromLocator(page as unknown as Page, control, options)).resolves.toMatchObject({ status: "READY" });
  });

  it("captures popup and main-frame navigation, closes popup, and restores conversation URL", async () => {
    for (const kind of ["popup", "navigation"] as const) {
      const page = new FakePage();
      page.fakeContext.request.get.mockResolvedValue({ status: () => 200, headers: () => ({ "content-type": "text/plain", "content-length": String(txt.length) }), ok: () => true, body: async () => txt, dispose: async () => undefined });
      const popup = Object.assign(new FakePage(), { close: vi.fn(async () => undefined), waitForLoadState: vi.fn(async () => undefined) });
      popup.currentUrl = "https://files.oaiusercontent.com/download/result.txt";
      const control = trigger(page, () => {
        if (kind === "popup") page.emit("popup", popup);
        else { page.currentUrl = "https://files.oaiusercontent.com/download/result.txt"; page.emit("framenavigated", page); }
      });
      const result = await downloader.captureDownloadFromLocator(page as unknown as Page, control, options);
      expect(result.status).toBe("READY");
      expect(page.currentUrl).toBe("https://chatgpt.com/c/fixture");
      if (kind === "popup") expect(popup.close).toHaveBeenCalledOnce();
    }
  });

  it("captures dynamic href/src/download attributes and provider-owned blob bytes", async () => {
    for (const attribute of ["href", "src", "download"] as const) {
      const hrefPage = new FakePage();
      hrefPage.fakeContext.request.get.mockResolvedValue({ status: () => 200, headers: () => ({ "content-type": "text/plain" }), ok: () => true, body: async () => txt, dispose: async () => undefined });
      const attrs = { href: attribute === "download" ? "https://files.oaiusercontent.com/download/result.txt" : null as string | null, src: null as string | null, download: null as string | null };
      const hrefControl = trigger(hrefPage, () => {
        if (attribute === "href") attrs.href = "https://files.oaiusercontent.com/download/result.txt";
        else if (attribute === "src") attrs.src = "https://files.oaiusercontent.com/download/result.txt";
        else attrs.download = "result.txt";
      }, attrs) as any;
      hrefControl.evaluate = async () => ({ ...attrs });
      await expect(downloader.captureDownloadFromLocator(hrefPage as unknown as Page, hrefControl, options)).resolves.toMatchObject({ status: "READY" });
    }

    const blobPage = new FakePage() as any;
    blobPage.evaluate = vi.fn(async () => ({ base64: txt.toString("base64"), mimeType: "text/plain" }));
    const blobAttrs = { href: null as string | null, src: null as string | null, download: null as string | null };
    const blobControl = trigger(blobPage, () => { blobAttrs.href = "blob:https://chatgpt.com/fixture"; }, blobAttrs) as any;
    blobControl.evaluate = async () => ({ ...blobAttrs });
    await expect(downloader.captureDownloadFromLocator(blobPage as Page, blobControl, options)).resolves.toMatchObject({ status: "READY" });
  });

  it("rejects login/challenge HTML and cleans listeners after timeout", async () => {
    const page = new FakePage();
    const states: ArtifactDownloadState[] = [];
    const control = trigger(page, () => page.emit("response", response("https://chatgpt.com/auth/login", "text/html", Buffer.from("<html>challenge</html>"), "")));
    await expect(downloader.captureDownloadFromLocator(page as unknown as Page, control, { ...options, downloadEventTimeoutMs: 250, onStateChange: (state) => states.push(state) })).rejects.toThrow("no validated bytes");
    expect(states.at(-1)).toBe("DOWNLOAD_TRIGGER_NO_BYTES");
    expect(page.eventNames()).toEqual([]); expect(page.fakeContext.eventNames()).toEqual([]);
  });
});
