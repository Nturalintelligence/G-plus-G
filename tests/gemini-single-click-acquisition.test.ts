import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import { ResponseArtifactDownloader } from "../src/attachments/artifact-downloader.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { AppDatabase } from "../src/storage/database.js";

const bytes = Buffer.from("G_PLUS_G_INBOUND_FINAL_2026");
const response = () => ({
  ok: () => true,
  url: () => "https://gemini.google.com/download/gplusg-inbound-final.txt",
  headers: () => ({ "content-type": "text/plain", "content-length": String(bytes.length), "content-disposition": 'attachment; filename="gplusg-inbound-final.txt"' }),
  body: async () => bytes,
});

class FakeContext extends EventEmitter { request = { get: vi.fn() }; }
class FakePage extends EventEmitter {
  contextValue = new FakeContext();
  context = () => this.contextValue;
  url = () => "https://gemini.google.com/app/fixture";
  mainFrame = () => this;
  goto = vi.fn();
  locator = vi.fn();
}

function element(ariaLabel: string, siblingIndex = 0) {
  const parent = { children: [] as any[] };
  const siblings = Array.from({ length: siblingIndex }, () => ({ tagName: "SPAN" }));
  const el = {
    tagName: "BUTTON", parentElement: parent,
    getAttribute: (name: string) => name === "aria-label" ? ariaLabel : null,
  };
  parent.children = [...siblings, el];
  return el;
}

function control(page: FakePage, el: ReturnType<typeof element>, action: () => void) {
  return {
    isVisible: async () => true, isEnabled: async () => true,
    evaluate: async (callback: (node: any) => unknown) => callback(el),
    getAttribute: async (name: string) => el.getAttribute(name),
    textContent: async () => el.getAttribute("aria-label"),
    click: vi.fn(async () => action()),
  };
}

describe("Gemini single-click artifact acquisition", () => {
  let root: string; let db: AppDatabase; let downloader: ResponseArtifactDownloader;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-gemini-acquisition-"));
    db = new AppDatabase(":memory:"); db.migrate();
    db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
    downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(root), { resolveHostname: async () => ["93.184.216.34"] });
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { projectId: "p", messageId: "gemini-turn", providerId: "gemini", expectArtifact: true, downloadEventTimeoutMs: 250 } as const;

  function bind(page: FakePage, controls: any[]) {
    const collection = { count: async () => controls.length, nth: (index: number) => controls[index] };
    const turn = { count: async () => 1, locator: () => collection, evaluate: async () => [] };
    page.locator.mockReturnValue({ last: () => turn });
  }

  it("deduplicates three selector matches for the same DOM control and clicks once", async () => {
    const page = new FakePage(); const el = element("Скачать");
    const selected = control(page, el, () => page.emit("response", response()));
    bind(page, [selected, selected, selected]);
    const result = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(result).toHaveLength(1); expect(result[0]?.status).toBe("READY");
    expect(selected.click).toHaveBeenCalledOnce();
  });

  it("chooses one deterministic control for desktop/mobile semantic duplicates", async () => {
    const page = new FakePage();
    const desktop = control(page, element("Скачать", 0), () => page.emit("response", response()));
    const mobile = control(page, element("Скачать", 2), () => page.emit("response", response()));
    bind(page, [desktop, mobile]);
    const result = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(result[0]?.status).toBe("READY");
    expect(desktop.click).toHaveBeenCalledOnce(); expect(mobile.click).not.toHaveBeenCalled();
  });

  it("fails closed without clicks when distinct controls remain ambiguous", async () => {
    const page = new FakePage();
    const first = control(page, element("Скачать файл", 0), () => undefined);
    const second = control(page, element("Download attachment", 1), () => undefined);
    bind(page, [first, second]);
    const result = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(first.click).not.toHaveBeenCalled(); expect(second.click).not.toHaveBeenCalled();
    expect(result).toHaveLength(1); expect(result[0]).toMatchObject({ status: "FAILED", failureReason: "AMBIGUOUS_DOWNLOAD_CONTROLS" });
  });

  it("aggregates simultaneous channel failures into one failed record and never clicks again", async () => {
    const page = new FakePage(); const selected = control(page, element("Скачать"), () => {
      page.emit("download", { url: () => "", createReadStream: async () => null });
      page.emit("response", { ...response(), body: async () => Buffer.alloc(0) });
      page.emit("popup", { url: () => "about:blank", waitForLoadState: async () => undefined, close: async () => undefined });
    });
    bind(page, [selected]);
    const first = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    const second = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(selected.click).toHaveBeenCalledOnce();
    expect(first).toHaveLength(1); expect(second).toHaveLength(1);
    expect(db.raw.prepare("SELECT COUNT(*) count FROM downloaded_artifacts WHERE message_id=?").get(options.messageId)).toMatchObject({ count: 1 });
  });

  it("continues listening after an empty download event and accepts network bytes from the same click", async () => {
    const page = new FakePage(); const selected = control(page, element("Скачать"), () => {
      page.emit("download", { url: () => "", createReadStream: async () => null });
      page.emit("response", response());
    });
    bind(page, [selected]);
    const result = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(result[0]?.status).toBe("READY"); expect(selected.click).toHaveBeenCalledOnce();
    expect(db.raw.prepare("SELECT COUNT(*) count FROM downloaded_artifacts WHERE message_id=?").get(options.messageId)).toMatchObject({ count: 1 });
  });

  it("single-flights concurrent acquisition callbacks", async () => {
    const page = new FakePage(); const selected = control(page, element("Скачать"), () => page.emit("response", response()));
    bind(page, [selected]);
    const [first, second] = await Promise.all([
      downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options),
      downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options),
    ]);
    expect(selected.click).toHaveBeenCalledOnce(); expect(first[0]?.id).toBe(second[0]?.id);
  });

  it("requires an owned FAILED id for one explicit reacquisition while ordinary calls remain click-free", async () => {
    db.raw.prepare(`INSERT INTO downloaded_artifacts
      (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,file_name,mime_type,size_bytes,status,downloaded_at,failure_reason,failure_detail)
      VALUES ('failed-prior',?,?,?,'','','','','application/octet-stream',0,'FAILED',?,'DOWNLOAD_TRIGGER_NO_BYTES','fixture')`)
      .run(options.messageId, options.projectId, options.providerId, new Date().toISOString());
    const page = new FakePage(); const selected = control(page, element("Скачать"), () => page.emit("response", response())); bind(page, [selected]);
    const ordinary = await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(ordinary[0]?.id).toBe("failed-prior"); expect(selected.click).not.toHaveBeenCalled();
    const retry = await downloader.reacquireTurnArtifactFromPage(page as unknown as Page, ".turn", options, "failed-prior");
    expect(retry.retryOfAcquisitionId).toBe("failed-prior"); expect(retry.acquisition.acquisitionId).toMatch(/^acq_/);
    expect(retry.acquisition.physicalClickCount).toBe(1); expect(retry.records[0]?.status).toBe("READY");
    await downloader.downloadTurnArtifactsFromPage(page as unknown as Page, ".turn", options);
    expect(selected.click).toHaveBeenCalledOnce();
  });
});
