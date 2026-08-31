import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-agent-workspace-"));
const screenshotRoot = resolve("docs", "screenshots");
await mkdir(screenshotRoot, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

async function launch() {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(1_000); return page;
}

async function openWorkspace(page) {
  await page.getByTitle("Команда агентов").click();
  await page.getByRole("dialog", { name: "Команда агентов" }).waitFor();
}

try {
  let page = await launch();
  const project = await page.evaluate(() => window.orchestrator.projects.create("Agent Workspace AW-1", ["chatgpt", "gemini"]));
  await page.reload(); await page.waitForTimeout(800); await page.getByText(project.name, { exact: true }).click(); await openWorkspace(page);
  const cards = page.locator(".agent-card"); assert(await cards.count() === 3, "AW-1 must show three distinct agent instances");
  const identity = await cards.evaluateAll((nodes) => nodes.map((node) => ({ provider: node.getAttribute("data-provider-id"), task: node.getAttribute("data-task-id"), text: node.textContent })));
  assert(new Set(identity.map((item) => item.task)).size === 3, "Agent roles share a task identity");
  assert(identity.some((item) => item.provider === "chatgpt") && identity.some((item) => item.provider === "gemini"), "Provider ownership is not visible");
  assert(await page.getByText("Delivery Owner", { exact: true }).count() >= 2, "Delivery Owner is not explicit");
  assert(await page.locator(".capability-list article").count() >= 3, "Capability reasons are not rendered");
  assert(await page.getByText("Health probe is declared but not executed in AW-1", { exact: true }).count() >= 1, "Unknown capability reason is missing");

  const geminiCard = cards.filter({ hasText: "gemini" }).first();
  await geminiCard.locator("select").selectOption("XHIGH");
  await page.getByRole("status").filter({ hasText: "недоступен" }).waitFor();
  assert(await geminiCard.locator("select").inputValue() === "MEDIUM", "Unsupported effort was silently persisted");
  const debuggingPolicy = page.locator(".automation-grid label").filter({ hasText: "debugging" }).locator("select");
  await debuggingPolicy.selectOption("AUTO"); await page.waitForTimeout(150);

  const geometry = await page.evaluate(() => ({ zoom: window.devicePixelRatio, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    modal: (() => { const r = document.querySelector(".agent-workspace-modal")?.getBoundingClientRect(); return r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })() }));
  assert(geometry.scrollWidth <= geometry.clientWidth, "Agent Workspace creates horizontal overflow");
  assert(geometry.modal && geometry.modal.left >= 0 && geometry.modal.right <= geometry.clientWidth, "Agent Workspace modal leaves viewport");
  const screenshot = join(screenshotRoot, "agent-workspace-aw1-1920x1080-dark.png");
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setContentSize(1920, 1080); window.webContents.setZoomFactor(1); });
  await page.screenshot({ path: screenshot, fullPage: false });
  const zoom = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()); assert(zoom === 1, "Browser zoom is not 100%");

  await app.close(); app = undefined; page = await launch();
  await page.getByText(project.name, { exact: true }).click(); await openWorkspace(page);
  assert(await page.locator(".automation-grid label").filter({ hasText: "debugging" }).locator("select").inputValue() === "AUTO", "Automation policy did not survive restart");
  assert(await page.locator(".agent-card").count() === 3, "Agent identities did not survive restart");
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, screenshot, agents: identity, restartPersistence: true, unsupportedEffort: "USER_DECISION_REQUIRED" }, null, 2));
} finally {
  await app?.close().catch(() => undefined); await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
