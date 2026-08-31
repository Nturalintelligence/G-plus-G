import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledChromiumExecutable } from "../src/browser/runtime.js";
import {
  assertBrowserObserverSourceSafe,
  installSurfaceObserver,
  parseSurfaceObserverDto,
  readSurfaceObserver,
  SURFACE_OBSERVER_SOURCE,
} from "../src/uat/browser-surface-observer.js";
import { runAfterObserverPreflight } from "../src/uat/observer-preflight.js";

describe("self-contained UAT browser surface observer", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const executablePath = bundledChromiumExecutable();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    page = await browser.newPage({ serviceWorkers: "block" });
  });

  afterAll(async () => browser?.close());

  it("contains no transformed or Node-only helpers", () => {
    expect(() => assertBrowserObserverSourceSafe()).not.toThrow();
    for (const needle of ["__name", "__async", "process.", "require(", "Buffer", "node:"]) {
      expect(SURFACE_OBSERVER_SOURCE).not.toContain(needle);
    }
  });

  it("retains a helper-free static source after compilation", async () => {
    const compiledPath = "dist/src/uat/browser-surface-observer.js";
    expect(readFileSync(compiledPath, "utf8")).toContain("SURFACE_OBSERVER_SOURCE");
    const compiledModule = await import(`${pathToFileURL(compiledPath).href}?test=${Date.now()}`) as {
      SURFACE_OBSERVER_SOURCE: string;
    };
    expect(compiledModule.SURFACE_OBSERVER_SOURCE).not.toContain("__name");
    expect(compiledModule.SURFACE_OBSERVER_SOURCE).not.toContain("__async");
  });

  it("returns a strict DTO without clicks, mutations, or network traffic", async () => {
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<model-response><div class="file-card"><button aria-label="скачать файл">Скачать</button></div></model-response>');
    const before = await page.content();
    const installed = await installSurfaceObserver(page);
    const after = await page.content();
    expect(after).toBe(before);
    expect(requests).toEqual([]);
    expect(installed.downloadClicks).toBe(0);
    expect(installed.expansionClicks).toBe(0);
    expect(installed.latest).toMatchObject({ surface: "FILE_CARD", rawControls: 1, actionable: 1 });
    await expect(readSurfaceObserver(page)).resolves.toMatchObject({ version: 1 });
  });

  it("rejects malformed DTOs", () => {
    expect(() => parseSurfaceObserverDto({ version: 1, latest: { surface: "FILE_CARD" } })).toThrow("Invalid browser surface observer DTO");
  });

  it("propagates observer exceptions so submission stays blocked", async () => {
    let submissions = 0;
    await expect(runAfterObserverPreflight(
      async () => { throw new Error("observer preflight failure"); },
      async () => { submissions += 1; },
    )).rejects.toThrow("observer preflight failure");
    expect(submissions).toBe(0);
  });

  it("allows the provider section only after a valid preflight", async () => {
    const order: string[] = [];
    const result = await runAfterObserverPreflight(
      async () => {
        order.push("preflight");
        return { ok: true, traffic: 0, uiActions: 0, dto: await readSurfaceObserver(page) };
      },
      async () => { order.push("provider"); return "UAT_READY"; },
    );
    expect(result).toBe("UAT_READY");
    expect(order).toEqual(["preflight", "provider"]);
  });
});
