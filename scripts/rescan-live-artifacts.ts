import { resolve } from "node:path";
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { ResponseArtifactDownloader } from "../src/attachments/artifact-downloader.js";
import { bundledChromiumExecutable } from "../src/browser/runtime.js";

const providerId = process.argv[2];
const projectId = process.argv[3];
const dataRoot = process.env.G_PLUS_G_USER_DATA;
if ((providerId !== "chatgpt" && providerId !== "gemini") || !projectId || !dataRoot) {
  throw new Error("Usage: G_PLUS_G_USER_DATA=<profile> tsx scripts/rescan-live-artifacts.ts <chatgpt|gemini> <project-id>");
}

const database = new DatabaseSync(resolve(dataRoot, "orchestrator.sqlite"));
const conversation = database.prepare(
  "SELECT external_ref FROM conversations WHERE project_id = ? AND provider_id = ?",
).get(projectId, providerId) as { external_ref?: string } | undefined;
const assistant = database.prepare(
  "SELECT id FROM conversation_entries WHERE project_id = ? AND provider_id = ? AND role = 'ASSISTANT' ORDER BY created_at DESC LIMIT 1",
).get(projectId, providerId) as { id?: string } | undefined;
if (!conversation?.external_ref || !assistant?.id) throw new Error("Persisted conversation or assistant response is missing");

const executablePath = bundledChromiumExecutable();
const context = await chromium.launchPersistentContext(resolve(dataRoot, "profiles", providerId), {
  headless: true,
  viewport: { width: 1440, height: 1000 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  args: ["--disable-blink-features=AutomationControlled"],
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  const networkDiagnostics: Array<{ kind: string; method?: string; resourceType?: string; status?: number; url: string }> = [];
  const safeNetworkUrl = (value: string): string => {
    try {
      const parsed = new URL(value);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return "invalid";
    }
  };
  page.on("request", (request) => {
    if (networkDiagnostics.length < 80) networkDiagnostics.push({
      kind: "request",
      method: request.method(),
      resourceType: request.resourceType(),
      url: safeNetworkUrl(request.url()),
    });
  });
  page.on("response", (response) => {
    if (networkDiagnostics.length < 80) networkDiagnostics.push({
      kind: "response",
      status: response.status(),
      url: safeNetworkUrl(response.url()),
    });
  });
  await page.goto(conversation.external_ref, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(3_000);
  networkDiagnostics.length = 0;
  const selector = providerId === "chatgpt"
    ? '[data-message-author-role="assistant"]'
    : 'message-content, .model-response-text';
  const downloader = new ResponseArtifactDownloader(database);
  const diagnostics = await page.locator(selector).last().evaluate((root) =>
    [...root.querySelectorAll("a, button, [role=button], file-card, mat-card")].slice(0, 40).map((element) => {
      const href = element.getAttribute("href");
      let safeHref = "";
      if (href) {
        try {
          const parsed = new URL(href, location.href);
          safeHref = `${parsed.origin}${parsed.pathname}`;
        } catch {
          safeHref = "invalid";
        }
      }
      return {
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") || "",
        aria: element.getAttribute("aria-label") || "",
        title: element.getAttribute("title") || "",
        testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "",
        text: (element.textContent || "").trim().slice(0, 160),
        href: safeHref,
      };
    }),
  ).catch(() => []);
  const candidates = await downloader.extractTurnArtifactsFromPage(page, selector);
  const records = await downloader.downloadTurnArtifactsFromPage(page, selector, {
    projectId,
    messageId: assistant.id,
    providerId,
  });
  let directCaptureError = "";
  if (records.every((record) => record.status !== "READY")) {
    const trigger = page.locator(selector).last().locator('button[aria-label*="Скач"]').first();
    if (await trigger.count()) {
      try {
        await downloader.captureDownloadFromLocator(page, trigger, {
          projectId,
          messageId: assistant.id,
          providerId,
        });
      } catch (error) {
        directCaptureError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  let expandedDiagnostics: unknown[] = [];
  if (providerId === "gemini") {
    const open = page.locator(selector).last().locator('[data-test-id="open-button"]').first();
    if (await open.count()) {
      await open.click();
      await page.waitForTimeout(2_000);
      expandedDiagnostics = await page.locator('a, button, [role="button"]').evaluateAll((elements) =>
        elements.filter((element) => {
          const value = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.textContent || ""}`;
          return /download|скач|файл|file/i.test(value);
        }).slice(0, 40).map((element) => ({
          tag: element.tagName.toLowerCase(),
          aria: element.getAttribute("aria-label") || "",
          title: element.getAttribute("title") || "",
          testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || "",
          text: (element.textContent || "").trim().slice(0, 160),
        })),
      );
    }
  }
  console.log(JSON.stringify({ providerId, projectId, submittedMessages: 0, diagnostics, expandedDiagnostics, candidates, records, directCaptureError, networkDiagnostics }, null, 2));
} finally {
  await context.close();
  database.close();
}
