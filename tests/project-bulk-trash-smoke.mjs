import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureDataRoot } from "../dist/src/paths.js";
import { AppDatabase } from "../dist/src/storage/database.js";
import { ProjectRepository } from "../dist/src/storage/repository.js";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-project-trash-"));
const screenshots = resolve("docs", "screenshots");
await mkdir(screenshots, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
configureDataRoot(dataRoot);
const database = new AppDatabase();
database.migrate();
const repository = new ProjectRepository(database);
for (let index = 0; index < 32; index += 1) {
  const project = repository.createProject(`Проект ${String(index + 1).padStart(2, "0")} — длинное имя для безопасного массового выбора`);
  repository.appendConversationEntry({ projectId: project.id, role: "USER", content: `История ${index + 1}` });
}
database.close();

let app;
async function launch() {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".project-row").first().waitFor();
  return page;
}

async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(size.width, size.height);
    win.webContents.setZoomFactor(1);
  }, { width, height });
}

try {
  let page = await launch();
  await resize(1920, 1080);
  await page.getByRole("button", { name: "Выбрать" }).click();
  const checkboxes = page.locator(".project-select-checkbox");
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await checkboxes.nth(2).check();
  assert(await page.getByText("Выбрано: 3").count() === 1, "explicit selection counter is wrong");
  await page.screenshot({ path: join(screenshots, "phase-e-project-batch-1920x1080-dark.png"), fullPage: false });
  await page.getByRole("button", { name: "В корзину" }).click();

  await app.close();
  app = undefined;
  page = await launch();
  await resize(1366, 768);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.getByRole("button", { name: /Корзина/ }).click();
  assert(await page.locator(".project-row").count() === 3, "trash did not persist after restart");
  await page.getByRole("button", { name: "Выбрать" }).click();
  await page.locator(".project-select-checkbox").nth(0).check();
  await page.locator(".project-select-checkbox").nth(1).check();
  await page.getByRole("button", { name: "Восстановить" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length === 1);
  assert(await page.locator(".project-row").count() === 1, "selected projects were not restored");
  await page.screenshot({ path: join(screenshots, "phase-e-project-trash-1366x768-light.png"), fullPage: false });

  assert(await page.getByRole("button", { name: "Отмена" }).count() === 1, "selection mode unexpectedly closed after restore");
  await page.locator(".project-select-checkbox").check();
  await page.evaluate(() => { window.confirm = () => false; });
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  assert(await page.locator(".project-row").count() === 1, "cancelled permanent deletion removed a project");
  await page.evaluate(() => { window.confirm = () => true; });
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length === 0);

  await page.getByRole("button", { name: "К проектам" }).click();
  await page.getByRole("button", { name: "Отмена" }).click();
  await resize(1100, 700);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await page.locator(".project-row").first().locator(".project-btn").click();
  await page.locator(".message.user").waitFor();
  assert(/^История \d+$/.test((await page.locator(".message.user p").textContent())?.trim() ?? ""), "restored transcript was lost");
  const geometry = await page.evaluate(() => ({ zoom: 1, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert(geometry.scrollWidth <= geometry.clientWidth, "bulk project UI has horizontal overflow");
  await page.screenshot({ path: join(screenshots, "phase-e-project-restored-1100x700-dark.png"), fullPage: false });
  console.log(JSON.stringify({ ok: true, projects: 32, trashed: 3, restored: 2, cancelledPermanentDelete: true, permanentDelete: true, transcriptPersisted: true, geometry }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
