import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureDataRoot } from "../dist/src/paths.js";
import { AppDatabase } from "../dist/src/storage/database.js";
import { ProjectRepository } from "../dist/src/storage/repository.js";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-phase-e-"));
const screenshots = resolve("docs", "screenshots");
await mkdir(screenshots, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
configureDataRoot(dataRoot);
const database = new AppDatabase();
database.migrate();
const repository = new ProjectRepository(database);
const target = repository.createProject("Проект с короткими и Markdown сообщениями", ["chatgpt", "gemini"]);
repository.appendConversationEntry({ projectId: target.id, role: "USER", content: "тест" });
repository.appendConversationEntry({ projectId: target.id, role: "ASSISTANT", providerId: "chatgpt", round: 1, content: "# Итог\n\n**Markdown** сохраняется как исходный текст.\n\n" + "Длинный ответ для проверки переноса. ".repeat(24) });
for (let index = 0; index < 32; index += 1) repository.createProject(`Длинный проект ${String(index + 1).padStart(2, "0")} — проверка batch selection и корзины ${"секция ".repeat(5)}`);
database.close();

let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.waitForLoadState("domcontentloaded");
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(1366, 768); win.webContents.setZoomFactor(1); });
  await page.locator(".project-row").first().waitFor();
  await page.getByTitle(target.name).click();
  await page.locator(".message.user").waitFor();
  const userBox = await page.locator(".message.user").boundingBox();
  const workspaceBox = await page.locator(".workspace").boundingBox();
  assert(userBox && workspaceBox && userBox.width < workspaceBox.width * 0.85, "Short user message is not compact");
  await page.locator(".message.user").hover();
  await page.locator(".message.user .message-copy").click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert(copied === "тест", `Copy action did not preserve raw message text: ${JSON.stringify(copied)}`);
  await page.screenshot({ path: join(screenshots, "phase-e-messages-1366x768-dark.png"), fullPage: false });

  await page.getByRole("button", { name: "Выбрать" }).click();
  const checkboxes = page.locator(".project-select-checkbox");
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await page.screenshot({ path: join(screenshots, "phase-e-batch-selection-1366x768-dark.png"), fullPage: false });
  await page.getByRole("button", { name: "В корзину" }).click();
  await page.getByRole("button", { name: /Корзина/ }).click();
  assert(await page.locator(".project-row").count() === 2, "Trash does not contain selected projects");
  await page.getByRole("button", { name: "Выбрать" }).click();
  await page.getByRole("button", { name: "Все видимые" }).click();
  await page.getByRole("button", { name: "Восстановить" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".project-row").length === 0);
  assert(await page.locator(".project-row").count() === 0, "Projects were not restored from trash");

  await page.getByRole("button", { name: "К проектам" }).click();
  await page.locator(".model-status-row").filter({ hasText: "ChatGPT" }).click();
  await page.getByText("Модели ИИ и управление сессиями").waitFor();
  await page.getByText("Стабильный адаптер").first().waitFor();
  await page.screenshot({ path: join(screenshots, "phase-e-provider-panel-1366x768-dark.png"), fullPage: false });

  const geometry = await page.evaluate(() => ({
    zoom: 1,
    viewport: [innerWidth, innerHeight],
    document: [document.documentElement.clientWidth, document.documentElement.scrollWidth],
  }));
  assert(geometry.document[1] <= geometry.document[0], "Phase E workspace has horizontal overflow");
  console.log(JSON.stringify({ ok: true, windowsScaleFactor: await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor), geometry }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
