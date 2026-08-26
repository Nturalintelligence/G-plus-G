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
  const assertCaptionGeometry = async (label) => {
    const geometry = await page.evaluate(() => {
      const closeElement = document.querySelector(".spec-help-header button");
      const close = closeElement?.getBoundingClientRect();
      const backdrop = document.querySelector(".spec-help-backdrop")?.getBoundingClientRect();
      const header = document.querySelector("main > header")?.getBoundingClientRect();
      const viewport = document.querySelector("#application-viewport")?.getBoundingClientRect();
      const overlay = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      const titlebarBottom = Math.max(overlay ? overlay.y + overlay.height : 0, header?.bottom ?? 56);
      const captionLeft = overlay ? overlay.x + overlay.width : innerWidth - 138;
      const hit = close ? document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2) : null;
      const style = closeElement ? getComputedStyle(closeElement) : null;
      return { close: close && { left: close.left, top: close.top, right: close.right, bottom: close.bottom }, backdropTop: backdrop?.top, viewportTop: viewport?.top, portalParent: document.querySelector(".spec-help-backdrop")?.parentElement?.id, titlebarBottom, caption: { left: captionLeft, top: 0, right: innerWidth, bottom: titlebarBottom }, hitIsClose: hit === closeElement || !!hit?.closest(".spec-help-header button"), appRegion: style?.getPropertyValue("-webkit-app-region") };
    });
    assert(geometry.close, `${label}: modal close is missing`);
    assert(geometry.portalParent === "application-viewport", `${label}: help is not mounted in application viewport`);
    assert(geometry.backdropTop === geometry.viewportTop, `${label}: backdrop escaped application viewport`);
    assert(geometry.backdropTop >= geometry.titlebarBottom, `${label}: backdrop overlaps title bar`);
    assert(geometry.close.top >= geometry.titlebarBottom, `${label}: modal close overlaps title bar`);
    const overlapsCaption = geometry.close.left < geometry.caption.right && geometry.close.right > geometry.caption.left && geometry.close.top < geometry.caption.bottom && geometry.close.bottom > geometry.caption.top;
    assert(!overlapsCaption, `${label}: modal close intersects caption controls`);
    assert(geometry.hitIsClose, `${label}: modal close is not the top hit target`);
    assert(geometry.appRegion === "no-drag", `${label}: modal close belongs to drag region`);
    return geometry;
  };
  const cases = [{ width: 1920, height: 1080, theme: "dark" }, { width: 1366, height: 768, theme: "light" }, { width: 1100, height: 700, theme: "dark" }];
  const geometryEvidence = [];
  for (const item of cases) { await app.evaluate(({ BrowserWindow }, size) => { const win = BrowserWindow.getAllWindows()[0]; if (win.isMaximized()) win.unmaximize(); win.setContentSize(size.width, size.height); win.webContents.setZoomFactor(1); }, item); await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; document.querySelector(".spec-help-content")?.scrollTo(0, 0); }, item.theme); const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); assert(overflow <= 0, `${item.width}: help horizontal overflow`); geometryEvidence.push({ label: `${item.width}x${item.height}`, geometry: await assertCaptionGeometry(`${item.width}x${item.height}`) }); await page.screenshot({ path: join(shots, `phase-e-spec-help-${item.width}x${item.height}-${item.theme}.png`), fullPage: false }); }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.maximize()); await page.waitForTimeout(350); geometryEvidence.push({ label: "maximized", geometry: await assertCaptionGeometry("maximized") });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.unmaximize()); await page.waitForTimeout(350); geometryEvidence.push({ label: "restored", geometry: await assertCaptionGeometry("restored") });
  const controls = await page.evaluate(() => { const button = document.querySelector(".spec-help-layout nav button"); const style = button ? getComputedStyle(button) : null; return { disabled: button instanceof HTMLButtonElement ? button.disabled : null, opacity: style?.opacity, color: style?.color, background: style?.backgroundColor }; });
  await page.keyboard.press("Escape"); assert(await dialog.count() === 0, "help Escape close failed"); assert(await opener.evaluate((node) => node === document.activeElement), "help focus was not returned"); await page.getByRole("button", { name: /Требования/ }).click(); assert(await page.getByRole("textbox", { name: "Пункт 1", exact: true }).inputValue() === "Несохранённое изменение остаётся", "help changed unsaved specification draft"); await page.getByRole("button", { name: "Готово" }).click();
  await opener.click(); await dialog.waitFor(); await dialog.getByLabel("Закрыть справку").click(); assert(await dialog.count() === 0, "modal close button failed"); assert((await app.windows()).length === 1, "modal close affected application window");
  console.log(JSON.stringify({ ok: true, sections: 11, search: true, preview: true, focusTrap: true, draftPreserved: true, modalClose: true, zoom: 1, controls, geometryEvidence }, null, 2));
} finally { await app?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
