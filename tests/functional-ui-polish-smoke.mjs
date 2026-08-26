import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = await mkdtemp(join(tmpdir(), "g-plus-g-ui-polish-"));
const shots = resolve("docs", "screenshots");
await mkdir(shots, { recursive: true });
const assert = (value, message) => { if (!value) throw new Error(message); };
let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2200);
  const project = await page.evaluate(() => window.orchestrator.projects.create("Демонстрация интерактивной спецификации", ["chatgpt", "gemini"]));
  await page.evaluate((id) => window.orchestrator.state.save(id, {
    requirements: [1, 2, 3].map((n) => ({ id: `req-${n}`, text: `Требование ${n}`, sourceTurnIds: [] })),
    constraints: [], decisions: [], rejectedOptions: [], openQuestions: [], acceptanceCriteria: [{ id: "accept-1", text: "Проверка завершена", sourceTurnIds: [] }],
  }), project.id);
  await page.reload(); await page.waitForTimeout(2200); await page.getByTitle(project.name).click();
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1366, 768); win.webContents.setZoomFactor(1); });

  const windowState = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
  assert(!(await windowState()), "test window unexpectedly maximized");
  await page.locator(".workspace").dblclick({ position: { x: 300, y: 200 } });
  assert(!(await windowState()), "workspace acts as title bar");
  await page.locator(".sidebar-pane").dblclick({ position: { x: 200, y: 450 } });
  assert(!(await windowState()), "sidebar acts as title bar");
  await page.mouse.dblclick(700, 28); await page.waitForTimeout(250);
  assert(await windowState(), "title bar does not maximize");
  await page.mouse.dblclick(700, 28); await page.waitForTimeout(250);
  assert(!(await windowState()), "title bar does not restore");

  await page.getByRole("button", { name: /Спецификация/ }).click();
  const requirements = page.getByRole("button", { name: /Требования/ });
  await requirements.click();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  assert(await page.locator(".spec-modal").count() === 0, "top close button did not close requirements");
  assert(await requirements.evaluate((node) => node === document.activeElement), "focus did not return to section trigger");
  await requirements.click(); await page.keyboard.press("Escape");
  assert(await page.locator(".spec-modal").count() === 0, "Escape did not close requirements");
  await requirements.click();
  await page.getByRole("button", { name: "Удалить пункт 2" }).click();
  assert(await page.locator(".state-card").count() === 2, "middle requirement was not deleted");
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  assert(await page.locator(".state-card").count() === 3, "requirement undo failed");
  await page.getByRole("button", { name: "Удалить пункт 1" }).click();
  await page.locator(".spec-modal").dblclick({ position: { x: 350, y: 300 } });
  assert(!(await windowState()), "spec modal acts as title bar");
  await page.getByRole("button", { name: "Готово" }).click();
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await page.waitForTimeout(400);

  await page.getByRole("button", { name: /Добавить модель/ }).click();
  const cards = page.locator(".model-card-header");
  const cardCount = await cards.count(); assert(cardCount >= 5, "provider catalog is unexpectedly short");
  for (const index of [0, Math.floor(cardCount / 2), cardCount - 1]) {
    const card = cards.nth(index); await card.scrollIntoViewIfNeeded(); await card.click();
    assert((await card.getAttribute("aria-expanded")) === "true", `model card ${index} did not open by click`);
    await card.press("Enter"); assert((await card.getAttribute("aria-expanded")) === "false", `model card ${index} did not close by keyboard`);
    await card.press(" "); assert((await card.getAttribute("aria-expanded")) === "true", `model card ${index} did not open by Space`);
  }
  await page.screenshot({ path: join(shots, "phase-e-functional-polish-1366x768-dark.png"), fullPage: false });
  const geometry = await page.evaluate(() => ({ zoom: 1, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(geometry.scroll <= geometry.client, "horizontal overflow after functional polishing");
  await app.close(); app = undefined;
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(2200); await page.getByTitle(project.name).click();
  await page.getByRole("button", { name: /Спецификация/ }).click(); await page.getByRole("button", { name: /Требования/ }).click();
  assert(await page.locator(".state-card").count() === 2, "deleted requirement did not persist after restart");
  console.log(JSON.stringify({ ok: true, modelCards: cardCount, modalClose: true, escape: true, deleteUndo: true, restartPersistence: true, dragHitTesting: true, geometry }, null, 2));
} finally { await app?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
