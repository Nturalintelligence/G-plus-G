import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Locator, Page } from "playwright";
import { AppDatabase } from "../src/storage/database.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import {
  ResponseArtifactDownloader,
  isPrivateOrReservedIp,
  isUrlSsrfSafe,
  validateDownloadUrl,
} from "../src/attachments/artifact-downloader.js";

describe("ResponseArtifactDownloader SSRF Security Validation", () => {
  it("allows only HTTPS at the syntactic boundary", () => {
    expect(isUrlSsrfSafe("https://chatgpt.com/assets/img.png").safe).toBe(true);
    expect(isUrlSsrfSafe("https://gemini.google.com/download/file123.pdf").safe).toBe(true);
    expect(isUrlSsrfSafe("http://example.com/file.pdf").safe).toBe(false);
  });

  it("blocks loopback, private, metadata, reserved IPv4, and private IPv6", () => {
    for (const target of [
      "https://localhost/secret",
      "https://127.0.0.1/admin",
      "https://[::1]/internal",
      "https://10.0.0.1/config",
      "https://192.168.1.1/router",
      "https://172.20.0.1/internal",
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/computeMetadata/v1/",
      "https://198.51.100.4/test",
      "https://[fd00::1]/test",
    ]) expect(isUrlSsrfSafe(target).safe).toBe(false);

    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("blocks non-HTTP protocols and credential-bearing URLs", () => {
    expect(isUrlSsrfSafe("file:///C:/Windows/system32/cmd.exe").safe).toBe(false);
    expect(isUrlSsrfSafe("data:text/plain;base64,QQ==").safe).toBe(false);
    expect(isUrlSsrfSafe("javascript:alert('xss')").safe).toBe(false);
    expect(isUrlSsrfSafe("https://user:password@chatgpt.com/file").safe).toBe(false);
  });

  it("enforces domain policy and rejects DNS rebinding to a private address", async () => {
    await expect(validateDownloadUrl("https://files.oaiusercontent.com/report.pdf", {
      allowedDomainSuffixes: ["oaiusercontent.com"],
      resolveHostname: async () => ["93.184.216.34"],
    })).resolves.toBeInstanceOf(URL);

    await expect(validateDownloadUrl("https://evil.example/report.pdf", {
      allowedDomainSuffixes: ["oaiusercontent.com"],
      resolveHostname: async () => ["93.184.216.34"],
    })).rejects.toThrow("not allowlisted");

    await expect(validateDownloadUrl("https://files.oaiusercontent.com/report.pdf", {
      allowedDomainSuffixes: ["oaiusercontent.com"],
      resolveHostname: async () => ["127.0.0.1"],
    })).rejects.toThrow("after DNS resolution");
  });
});

describe("ResponseArtifactDownloader deterministic download pipeline", () => {
  let tmpDir: string;
  let appDb: AppDatabase;
  let store: LocalArtifactStore;
  let downloader: ResponseArtifactDownloader;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gplusg-download-test-"));
    appDb = new AppDatabase(":memory:");
    appDb.migrate();
    appDb.raw.prepare(
      "INSERT INTO projects (id, name, status, created_at, updated_at) VALUES ('project-1', 'Download Test', 'ACTIVE', '2026-01-01', '2026-01-01')",
    ).run();
    store = new LocalArtifactStore(tmpDir);
    downloader = new ResponseArtifactDownloader(appDb.raw, store, {
      resolveHostname: async () => ["93.184.216.34"],
    });
  });

  afterEach(() => {
    appDb.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function response(status: number, headers: Record<string, string>, body: Buffer) {
    return {
      status: () => status,
      headers: () => headers,
      ok: () => status >= 200 && status < 300,
      body: async () => body,
      dispose: async () => undefined,
    };
  }

  it("validates every redirect hop and persists an allowed PDF", async () => {
    const pdf = Buffer.from("%PDF-1.7\nfixture");
    const get = vi.fn()
      .mockResolvedValueOnce(response(302, { location: "https://cdn.oaiusercontent.com/report.pdf" }, Buffer.alloc(0)))
      .mockResolvedValueOnce(response(200, {
        "content-type": "application/pdf",
        "content-length": String(pdf.length),
        "content-disposition": 'attachment; filename="report.pdf"',
      }, pdf));
    const page = { context: () => ({ request: { get } }) } as unknown as Page;

    const result = await downloader.downloadArtifactSsrfSafe(page, {
      projectId: "project-1",
      messageId: "message-1",
      providerId: "chatgpt",
      url: "https://chatgpt.com/download/start",
    });

    expect(result.status).toBe("READY");
    expect(result).toMatchObject({ fileName: "report.pdf", mimeType: "application/pdf", sizeBytes: pdf.length });
    expect(get).toHaveBeenCalledTimes(2);
    expect(store.readBuffer(result.localRelativePath)).toEqual(pdf);
    expect(appDb.raw.prepare("SELECT status FROM downloaded_artifacts WHERE id = ?").get(result.id)).toMatchObject({ status: "READY" });
  });

  it("discovers and downloads bound-turn links through the authenticated request context", async () => {
    const pdf = Buffer.from("%PDF-1.7\nbound-turn");
    const evaluate = vi.fn().mockResolvedValue([
      { label: "результат.pdf", url: "https://files.oaiusercontent.com/result.pdf", isImage: false },
    ]);
    const get = vi.fn().mockResolvedValue(response(200, {
      "content-type": "application/pdf",
      "content-length": String(pdf.length),
    }, pdf));
    const page = {
      locator: () => ({ last: () => ({ count: async () => 1, evaluate, locator: () => ({ count: async () => 0 }) }) }),
      context: () => ({ request: { get } }),
    } as unknown as Page;
    const results = await downloader.downloadTurnArtifactsFromPage(page, ".bound-assistant", {
      projectId: "project-1",
      messageId: "assistant-entry-1",
      providerId: "chatgpt",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "READY", messageId: "assistant-entry-1", fileName: "результат.pdf" });
    expect(appDb.raw.prepare("SELECT file_name, mime_type, size_bytes FROM downloaded_artifacts WHERE id = ?").get(results[0]!.id))
      .toMatchObject({ file_name: "результат.pdf", mime_type: "application/pdf", size_bytes: pdf.length });
  });

  it("does not treat a decorative provider file-card image as a response artifact", async () => {
    const evaluate = vi.fn().mockImplementation((callback: (element: Element) => unknown) => {
      const decorativeIcon = {
        src: "https://www.gstatic.com/images/icons/material/system/2x/description.png",
        alt: "Значок TXT-файла",
        getAttribute: vi.fn().mockReturnValue(null),
      };
      const element = {
        querySelectorAll: (selector: string) => selector === "img" ? [decorativeIcon] : [],
      } as unknown as Element;
      return callback(element);
    });
    const page = {
      locator: () => ({ last: () => ({ count: async () => 1, evaluate }) }),
    } as unknown as Page;

    await expect(downloader.extractTurnArtifactsFromPage(page, ".bound-assistant")).resolves.toEqual([]);
  });

  it("captures provider download controls from the bound response without replaying a URL", async () => {
    const pdf = Buffer.from("%PDF-1.7\nbutton-event");
    const control = {
      getAttribute: vi.fn().mockResolvedValue(null),
      textContent: vi.fn().mockResolvedValue("Download report"),
      click: vi.fn().mockResolvedValue(undefined),
    };
    const download = {
      url: () => "https://files.oaiusercontent.com/button.pdf?token=secret",
      suggestedFilename: () => "button.pdf",
      createReadStream: async () => Readable.from([pdf]),
    };
    const page = {
      locator: () => ({ last: () => ({
        count: async () => 1,
        evaluate: async () => [],
        locator: () => ({ count: async () => 1, nth: () => control }),
      }) }),
      waitForEvent: vi.fn().mockResolvedValue(download),
    } as unknown as Page;
    const results = await downloader.downloadTurnArtifactsFromPage(page, ".bound-assistant", {
      projectId: "project-1",
      messageId: "assistant-entry-2",
      providerId: "chatgpt",
    });
    expect(results[0]).toMatchObject({ status: "READY", fileName: "button.pdf", originalUrl: "https://files.oaiusercontent.com/button.pdf" });
    expect(control.click).toHaveBeenCalledOnce();
  });

  it("includes an explicit uppercase Cyrillic download selector for localized providers", async () => {
    const requestedSelectors: string[] = [];
    const turn = {
      count: async () => 1,
      evaluate: async () => [],
      locator: (selector: string) => {
        requestedSelectors.push(selector);
        return selector.includes("open-button")
          ? { first: () => ({ count: async () => 0 }) }
          : { count: async () => 0 };
      },
    };
    const page = { locator: () => ({ last: () => turn }) } as unknown as Page;

    await downloader.downloadTurnArtifactsFromPage(page, ".bound-assistant", {
      projectId: "project-1",
      messageId: "assistant-entry-ru",
      providerId: "gemini",
    });

    expect(requestedSelectors.join(" ")).toContain('button[aria-label*="Скач"]');
  });

  it("opens a Gemini bound file card before capturing its app-level download control", async () => {
    const txt = Buffer.from("G_PLUS_G_PROVIDER_FILE_RESULT_2026\n");
    const open = { count: async () => 1, click: vi.fn().mockResolvedValue(undefined) };
    const downloadControl = { click: vi.fn().mockResolvedValue(undefined) };
    const controls = { count: async () => 0 };
    const turn = {
      count: async () => 1,
      evaluate: async () => [],
      locator: (selector: string) => selector.includes("open-button")
        ? { first: () => open }
        : controls,
    };
    const download = {
      url: () => "https://gemini.google.com/download/result.txt",
      suggestedFilename: () => "result.txt",
      createReadStream: async () => Readable.from([txt]),
    };
    const page = {
      locator: (selector: string) => selector === ".bound-assistant"
        ? { last: () => turn }
        : {
            first: () => ({ waitFor: vi.fn().mockResolvedValue(undefined) }),
            count: async () => 1,
            nth: () => downloadControl,
          },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForEvent: vi.fn().mockResolvedValue(download),
    } as unknown as Page;

    const results = await downloader.downloadTurnArtifactsFromPage(page, ".bound-assistant", {
      projectId: "project-1",
      messageId: "assistant-entry-gemini-card",
      providerId: "gemini",
    });

    expect(open.click).toHaveBeenCalledOnce();
    expect(downloadControl.click).toHaveBeenCalledOnce();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "READY", fileName: "result.txt", mimeType: "text/plain" });
  });

  it("fails closed when a redirect resolves to private infrastructure", async () => {
    const get = vi.fn().mockResolvedValue(
      response(302, { location: "https://127.0.0.1/internal.pdf" }, Buffer.alloc(0)),
    );
    const page = { context: () => ({ request: { get } }) } as unknown as Page;

    const result = await downloader.downloadArtifactSsrfSafe(page, {
      projectId: "project-1",
      messageId: "message-2",
      providerId: "chatgpt",
      url: "https://chatgpt.com/download/start",
    });
    expect(result.status).toBe("FAILED");
    expect(result.localRelativePath).toBe("");
  });

  it("rejects HTML and advertised oversized content", async () => {
    const htmlGet = vi.fn().mockResolvedValue(
      response(200, { "content-type": "text/html" }, Buffer.from("<html>not a file</html>")),
    );
    const htmlPage = { context: () => ({ request: { get: htmlGet } }) } as unknown as Page;
    const html = await downloader.downloadArtifactSsrfSafe(htmlPage, {
      projectId: "project-1",
      messageId: "message-html",
      providerId: "chatgpt",
      url: "https://chatgpt.com/download/page",
      label: "page.html",
    });
    expect(html.status).toBe("FAILED");

    const largeGet = vi.fn().mockResolvedValue(
      response(200, { "content-type": "application/pdf", "content-length": "1000" }, Buffer.from("%PDF")),
    );
    const largePage = { context: () => ({ request: { get: largeGet } }) } as unknown as Page;
    const large = await downloader.downloadArtifactSsrfSafe(largePage, {
      projectId: "project-1",
      messageId: "message-large",
      providerId: "chatgpt",
      url: "https://chatgpt.com/download/large.pdf",
      maxBytes: 10,
    });
    expect(large.status).toBe("FAILED");
  });

  it("uses Playwright download event and an authenticated-context stream first", async () => {
    const pdf = Buffer.from("%PDF-1.7\ndownload-event");
    const download = {
      url: () => "https://files.oaiusercontent.com/event.pdf",
      suggestedFilename: () => "event.pdf",
      createReadStream: async () => Readable.from([pdf]),
    };
    const page = { waitForEvent: vi.fn().mockResolvedValue(download) } as unknown as Page;
    const trigger = { click: vi.fn().mockResolvedValue(undefined) } as unknown as Locator;

    const result = await downloader.captureDownloadFromLocator(page, trigger, {
      projectId: "project-1",
      messageId: "message-event",
      providerId: "chatgpt",
    });
    expect(result.status).toBe("READY");
    expect(trigger.click).toHaveBeenCalledOnce();
    expect(store.readBuffer(result.localRelativePath)).toEqual(pdf);
  });
});
