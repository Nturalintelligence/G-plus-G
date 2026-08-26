import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = await mkdtemp(join(tmpdir(), "g-plus-g-spec-help-"));
const shots = resolve("docs", "screenshots"); await mkdir(shots, { recursive: true });
const assert = (value, message) => { if (!value) throw new Error(message); };
let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(2200);
  const project = await page.evaluate(() => window.orchestrator.projects.create("Демонстрационный проект справки", ["chatgpt", "gemini"]));
  await page.evaluate((id) => window.orchestrator.state.save(id, { requirements: [{ id: "r1", text: "Исходный черновик", sourceTurnIds: [] }], constraints: [], decisions: [], rejectedOptions: [], openQuestions: [], acceptanceCriteria: [{ id: "a1", text: "Работает", sourceTurnIds: [] }] }), project.id);
  await page.reload(); await page.waitForTimeout(2200); await page.getByTitle(project.name).click(); await page.getByRole("button", { name: /Спецификация/ }).click();
  assert(await page.locator(".spec-onboarding").count() === 1, "first-use onboarding missing");
  await page.getByRole("button", { name: /Требования/ }).click(); const draft = page.getByRole("textbox", { name: "Пункт 1", exact: true }); await draft.fill("Несохранённое изменение остаётся"); await page.getByRole("button", { name: "Готово" }).click();
  const opener = page.getByRole("button", { name: "Как работать со спецификацией?" }); await opener.click();
  const dialog = page.locator(".spec-help-modal"); await dialog.waitFor();
  await dialog.getByLabel("Закрыть справку").focus(); await page.keyboard.press("Shift+Tab"); assert(await dialog.evaluate((node) => node.contains(document.activeElement)), "focus escaped help dialog backwards");
  const navButtons = dialog.locator("nav button"); assert(await navButtons.count() === 11, "help navigation is incomplete");
  for (let index = 0; index < 11; index += 1) { await navButtons.nth(index).click(); assert(await dialog.locator("article h3").textContent(), `help section ${index} did not open`); }
  await dialog.getByLabel("Поиск по справке").fill("JSON"); assert(await navButtons.count() === 1, "help search did not filter sections"); await navButtons.first().click(); assert(await dialog.getByText(/JSON не является CLI-командой/).count() === 1, "JSON safety note missing");
  await dialog.getByLabel("Поиск по справке").fill(""); await navButtons.first().click(); await dialog.locator(".spec-help-image").click(); assert(await page.locator(".spec-help-preview").count() === 1, "screenshot preview did not open"); await page.keyboard.press("Escape"); assert(await page.locator(".spec-help-preview").count() === 0, "screenshot preview did not close");
  const cases = [{ width: 1920, height: 1080, theme: "dark" }, { width: 1366, height: 768, theme: "light" }, { width: 1100, height: 700, theme: "dark" }];
  for (const item of cases) { await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(1); }, item); await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.querySelector(".spec-help-content")?.scrollTo(0, 0); }, item.theme); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert(overflow <= 0, `${item.width}: help horizontal overflow`); await page.screenshot({ path: join(shots, `phase-e-spec-help-${item.width}x${item.height}-${item.theme}.png`), fullPage: false }); }
  const controls = await page.evaluate(() => { const button = document.querySelector(".spec-help-layout nav button"); const style = button ? getComputedStyle(button) : null; return { disabled: button instanceof HTMLButtonElement ? button.disabled : null, opacity: style?.opacity, color: style?.color, background: style?.backgroundColor }; });
  await page.keyboard.press("Escape"); assert(await dialog.count() === 0, "help Escape close failed"); assert(await opener.evaluate((node) => node === document.activeElement), "help focus was not returned"); await page.getByRole("button", { name: /Требования/ }).click(); assert(await page.getByRole("textbox", { name: "Пункт 1", exact: true }).inputValue() === "Несохранённое изменение остаётся", "help changed unsaved specification draft");
  console.log(JSON.stringify({ ok: true, sections: 11, search: true, preview: true, focusTrap: true, draftPreserved: true, zoom: 1, controls }, null, 2));
} finally { await app?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
