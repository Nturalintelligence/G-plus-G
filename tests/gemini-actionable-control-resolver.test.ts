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
const fileResponse = () => ({ ok: () => true, url: () => "https://gemini.google.com/download/gplusg-inbound-final.txt", headers: () => ({ "content-type": "text/plain", "content-disposition": 'attachment; filename="gplusg-inbound-final.txt"' }), body: async () => bytes });
const collection = (items: any[]) => ({ count: async () => items.length, nth: (index: number) => items[index], last: () => items.at(-1) });

describe("Gemini actionable artifact control resolver", () => {
  let db: AppDatabase; let root: string; let downloader: ResponseArtifactDownloader;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-actionable-")); db = new AppDatabase(":memory:"); db.migrate();
    db.raw.prepare("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ('p','p','ACTIVE','x','x')").run();
    downloader = new ResponseArtifactDownloader(db.raw, new LocalArtifactStore(root), { resolveHostname: async () => ["93.184.216.34"] });
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const options = { projectId: "p", messageId: "new-gemini-turn", providerId: "gemini", expectArtifact: true, downloadEventTimeoutMs: 250 } as const;

  function makeControl(page: EventEmitter, label: string, visible: () => boolean, bounds = { width: 24, height: 24 }) {
    const node = { tagName: "BUTTON", parentElement: null, getAttribute: (name: string) => name === "aria-label" ? label : null };
    return { isVisible: async () => visible(), isEnabled: async () => true, boundingBox: async () => bounds, evaluate: async (fn: any) => fn(node), getAttribute: async (name: string) => node.getAttribute(name), textContent: async () => label, click: vi.fn(async () => page.emit("response", fileResponse())) };
  }

  function pageFixture(controlItems: any[], artifact: any, menuItems: any[] = []) {
    const page = new EventEmitter() as any; page.url = () => "https://gemini.google.com/app/fixture"; page.mainFrame = () => page; page.goto = vi.fn(); page.context = () => new EventEmitter();
    const turn = { locator: (selector: string) => selector.startsWith("pre,") ? artifact : selector.includes("aria-haspopup") ? collection(menuItems) : selector === "pre, code, .code-block" ? artifact : collection(controlItems), evaluate: async () => [] };
    page.locator = vi.fn(() => ({ last: () => turn })); return page;
  }

  it("hovers the bound code block and then clicks its single Russian control", async () => {
    let hovered = false; const artifact = { count: async () => 1, hover: vi.fn(async () => { hovered = true; }) };
    const page = pageFixture([], artifact); const control = makeControl(page, "Скачать код", () => hovered);
    page.locator = vi.fn(() => ({ last: () => ({ locator: (selector: string) => selector.startsWith("pre,") ? artifact : selector.includes("aria-haspopup") ? collection([]) : selector === "pre, code, .code-block" ? artifact : collection([control]), evaluate: async () => [] }) }));
    const result = await downloader.downloadTurnArtifactsFromPage(page as Page, ".turn", options);
    expect(artifact.hover).toHaveBeenCalledOnce(); expect(control.click).toHaveBeenCalledOnce(); expect(result[0]?.status).toBe("READY");
  });

  it("classifies hidden and zero-bounds duplicates without clicking", async () => {
    for (const [messageId, visible, bounds, reason] of [
      ["hidden", false, { width: 24, height: 24 }, "DOWNLOAD_CONTROL_HIDDEN"],
      ["zero", true, { width: 0, height: 0 }, "DOWNLOAD_CONTROL_ZERO_BOUNDS"],
    ] as const) {
      const artifact = { count: async () => 0, hover: vi.fn() }; const page = pageFixture([], artifact);
      const control = makeControl(page, "Download code", () => visible, bounds);
      const turn = { locator: (selector: string) => selector.startsWith("pre,") || selector === "pre, code, .code-block" ? artifact : selector.includes("aria-haspopup") ? collection([]) : collection([control]), evaluate: async () => [] };
      page.locator = vi.fn(() => ({ last: () => turn }));
      const result = await downloader.downloadTurnArtifactsFromPage(page as Page, ".turn", { ...options, messageId });
      expect(result[0]?.failureReason).toBe(reason); expect(control.click).not.toHaveBeenCalled();
    }
  });

  it("allows one explicit artifact-menu expansion and one download click", async () => {
    let expanded = false; const artifact = { count: async () => 0, hover: vi.fn() }; const page = pageFixture([], artifact);
    const control = makeControl(page, "Download code", () => true); const controls = { count: async () => expanded ? 1 : 0, nth: () => control };
    const menu = { isVisible: async () => true, isEnabled: async () => true, click: vi.fn(async () => { expanded = true; }) };
    const turn = { locator: (selector: string) => selector.startsWith("pre,") || selector === "pre, code, .code-block" ? artifact : selector.includes("aria-haspopup") ? collection([menu]) : controls, evaluate: async () => [] };
    page.locator = vi.fn(() => ({ last: () => turn }));
    const result = await downloader.downloadTurnArtifactsFromPage(page as Page, ".turn", options);
    expect(menu.click).toHaveBeenCalledOnce(); expect(control.click).toHaveBeenCalledOnce(); expect(result[0]?.status).toBe("READY");
  });
});
