import { chromium } from "playwright";
import { bundledChromiumExecutable } from "../browser/runtime.js";
import {
  assertBrowserObserverSourceSafe,
  installPersistentSurfaceObserver,
  type SurfaceObserverDto,
} from "./browser-surface-observer.js";

export interface ObserverPreflightResult {
  ok: true;
  traffic: 0;
  uiActions: 0;
  dto: SurfaceObserverDto;
}

export async function runSurfaceObserverPreflight(): Promise<ObserverPreflightResult> {
  assertBrowserObserverSourceSafe();
  const executablePath = bundledChromiumExecutable();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.setContent('<model-response><div class="file-card"><button aria-label="скачать файл">Скачать</button></div></model-response>');
    const before = await page.content();
    const collector = await installPersistentSurfaceObserver(page);
    const after = await page.content();
    const dto = collector.current();
    if (!dto) throw new Error("Observer did not emit a diagnostic DTO");
    if (before !== after) throw new Error("Observer changed fixture DOM");
    if (requests.length !== 0) throw new Error("Observer produced network traffic");
    if (dto.downloadClicks !== 0 || dto.expansionClicks !== 0) throw new Error("Observer performed a UI action");
    if (dto.latest?.surface !== "FILE_CARD" || dto.latest.actionable !== 1) throw new Error("Observer returned unexpected fixture evidence");
    await context.close();
    return { ok: true, traffic: 0, uiActions: 0, dto };
  } finally {
    await browser.close();
  }
}

export async function runAfterObserverPreflight<T>(
  preflight: () => Promise<ObserverPreflightResult>,
  providerSection: () => Promise<T>,
): Promise<T> {
  await preflight();
  return providerSection();
}
