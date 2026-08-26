import crypto from "node:crypto";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { bundledChromiumExecutable } from "../src/browser/runtime.js";

const providerId = process.argv[2];
const projectId = process.argv[3];
const dataRoot = process.env.G_PLUS_G_USER_DATA;
if ((providerId !== "chatgpt" && providerId !== "gemini") || !projectId || !dataRoot) {
  throw new Error("Usage: G_PLUS_G_USER_DATA=<profile> tsx scripts/diagnose-live-artifacts-readonly.ts <chatgpt|gemini> <project-id>");
}

const database = new DatabaseSync(resolve(dataRoot, "orchestrator.sqlite"), { readOnly: true });
const conversation = database.prepare(
  "SELECT external_ref FROM conversations WHERE project_id = ? AND provider_id = ?",
).get(projectId, providerId) as { external_ref?: string } | undefined;
if (!conversation?.external_ref) throw new Error("Persisted conversation is missing");

const safeReference = (value: string | null, base: string) => {
  if (!value) return { kind: "NONE", origin: "", pathPattern: "", sha256: "", hasQuery: false };
  const trimmed = value.trim();
  const kind = trimmed.startsWith("blob:") ? "BLOB_URL" : /^https:\/\//i.test(trimmed) ? "ABSOLUTE_HTTPS" : "RELATIVE_URL";
  try {
    const parsed = new URL(trimmed, base);
    return {
      kind,
      origin: parsed.origin,
      pathPattern: parsed.pathname.replace(/[a-f0-9]{16,}/gi, ":id").slice(0, 180),
      sha256: crypto.createHash("sha256").update(trimmed).digest("hex"),
      hasQuery: Boolean(parsed.search),
    };
  } catch {
    return { kind, origin: "", pathPattern: "invalid", sha256: crypto.createHash("sha256").update(trimmed).digest("hex"), hasQuery: trimmed.includes("?") };
  }
};

const executablePath = bundledChromiumExecutable();
const context = await chromium.launchPersistentContext(resolve(dataRoot, "profiles", providerId), {
  headless: true,
  viewport: { width: 1440, height: 1000 },
  args: ["--disable-blink-features=AutomationControlled"],
  ...(executablePath ? { executablePath } : {}),
});
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(conversation.external_ref, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(6_000);
  const selector = providerId === "chatgpt" ? '[data-message-author-role="assistant"]' : 'message-content, .model-response-text';
  const base = page.url();
  const turnCount = await page.locator(selector).count();
  const scope = turnCount > 0 ? page.locator(selector).last() : page.locator("body");
  const elements = await scope.locator("a, button, [role=button], img, file-card, mat-card").evaluateAll((nodes) => nodes.filter((element) => {
    const technicalName = `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""} ${element.getAttribute("data-testid") || ""} ${element.getAttribute("data-test-id") || ""}`;
    return element.hasAttribute("download") || element.hasAttribute("href") || /download|file|attachment|скач|файл|open-button/i.test(technicalName);
  }).slice(0, 80).map((element) => ({
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || undefined,
    ariaLabel: element.getAttribute("aria-label") || undefined,
    title: element.getAttribute("title") || undefined,
    testId: element.getAttribute("data-testid") || element.getAttribute("data-test-id") || undefined,
    downloadName: element.getAttribute("download") || undefined,
    href: element.getAttribute("href"),
    src: element.getAttribute("src"),
  })));
  console.log(JSON.stringify({
    providerId,
    projectId,
    submittedMessages: 0,
    providerOrigin: new URL(base).origin,
    pageReference: safeReference(base, base),
    turnCount,
    elements: elements.map(({ href, src, ...element }) => ({
      ...element,
      href: safeReference(href, base),
      src: safeReference(src, base),
    })),
  }, null, 2));
} finally {
  await context.close();
  database.close();
}
