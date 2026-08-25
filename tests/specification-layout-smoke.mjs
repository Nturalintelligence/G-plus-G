import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryBase = await mkdtemp(join(tmpdir(), "g-plus-g-spec-"));
const dataRoot = join(temporaryBase, "data");
const screenshotRoot = resolve("docs", "screenshots");
await mkdir(dataRoot, { recursive: true });
await mkdir(screenshotRoot, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2_500);
  const project = await page.evaluate(() => window.orchestrator.projects.create("Очень длинное название проекта для проверки адаптивности спецификации", ["chatgpt"]));
  await page.reload();
  await page.waitForTimeout(2_500);
  await page.getByText(project.name, { exact: true }).click();
  for (let index = 0; index < 105; index += 1) {
    await page.evaluate(({ projectId, index }) => window.orchestrator.state.save(projectId, {
      requirements: [{ id: `r-${index}`, text: `Требование ${index} с длинным русским описанием`, sourceTurnIds: [] }],
      constraints: [], decisions: [], rejectedOptions: [], openQuestions: [], acceptanceCriteria: [{ id: `a-${index}`, text: `Критерий ${index}`, sourceTurnIds: [] }],
    }), { projectId: project.id, index });
  }
  await page.reload();
  await page.waitForTimeout(2_500);
  await page.getByText(project.name, { exact: true }).click();
  const evidence = [];
  for (const item of [{ width: 1366, height: 768, theme: "light" }, { width: 1100, height: 700, theme: "dark" }]) {
    await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(1); }, item);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, item.theme);
    await page.getByRole("button", { name: /Спецификация/ }).click();
    await page.waitForTimeout(200);
    const state = await page.evaluate(() => {
      const box = (selector) => { const rect = document.querySelector(selector)?.getBoundingClientRect(); return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height } : null; };
      const content = document.querySelector(".inspector-content");
      const footer = document.querySelector(".inspector-footer");
      return { viewport: { width: innerWidth, height: innerHeight }, inspector: box(".inspector"), content: box(".inspector-content"), footer: box(".inspector-footer"), button: box(".specification-btn"), scroll: content ? { clientHeight: content.clientHeight, scrollHeight: content.scrollHeight, overflowY: getComputedStyle(content).overflowY } : null, documentWidth: [document.documentElement.clientWidth, document.documentElement.scrollWidth], footerShrink: footer ? getComputedStyle(footer).flexShrink : null };
    });
    console.log(JSON.stringify({ case: item, state }));
    assert(state.inspector && state.content && state.footer && state.button, "specification regions missing");
    assert(state.inspector.bottom <= state.viewport.height + 1, "inspector exceeds viewport");
    assert(state.footer.bottom <= state.viewport.height + 1, "actions are outside viewport");
    assert(state.scroll.scrollHeight > state.scroll.clientHeight && state.scroll.overflowY === "auto", "spec content is not independently scrollable");
    assert(state.documentWidth[1] <= state.documentWidth[0], "horizontal overflow");
    const file = join(screenshotRoot, `phase-e-spec-${item.width}x${item.height}-${item.theme}.png`);
    await page.screenshot({ path: file, fullPage: false });
    evidence.push({ ...item, file, state });
    await page.getByRole("button", { name: /Спецификация/ }).click();
  }
  console.log(JSON.stringify({ ok: true, zoom: 1, eventCount: 105, evidence }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(temporaryBase, { recursive: true, force: true }).catch(() => undefined);
}
