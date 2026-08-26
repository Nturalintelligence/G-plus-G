import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-settings-caption-"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;
try {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /Добавить модель/ }).click();
  const dialog = page.locator(".settings-modal-dialog"); await dialog.waitFor();
  const evidence = [];
  const geometry = async (label) => {
    const value = await page.evaluate(() => {
      const closeElement = document.querySelector(".settings-dialog-header .close-btn");
      const close = closeElement?.getBoundingClientRect();
      const backdrop = document.querySelector(".settings-modal-backdrop")?.getBoundingClientRect();
      const viewport = document.querySelector("#application-viewport")?.getBoundingClientRect();
      const header = document.querySelector("main > header")?.getBoundingClientRect();
      const overlay = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      const titlebarBottom = Math.max(overlay ? overlay.y + overlay.height : 0, header?.bottom ?? 56);
      const captionLeft = overlay ? overlay.x + overlay.width : innerWidth - 138;
      const hit = close ? document.elementFromPoint(close.x + close.width / 2, close.y + close.height / 2) : null;
      return { close: close && { left: close.left, top: close.top, right: close.right, bottom: close.bottom }, backdropTop: backdrop?.top, viewportTop: viewport?.top, portalParent: document.querySelector(".settings-modal-backdrop")?.parentElement?.id, titlebarBottom, caption: { left: captionLeft, top: 0, right: innerWidth, bottom: titlebarBottom }, hitIsClose: hit === closeElement || !!hit?.closest(".settings-dialog-header .close-btn"), appRegion: closeElement ? getComputedStyle(closeElement).getPropertyValue("-webkit-app-region") : null };
    });
    assert(value.close, `${label}: settings close missing`);
    assert(value.portalParent === "application-viewport", `${label}: settings modal is outside application viewport`);
    assert(value.backdropTop === value.viewportTop && value.backdropTop >= value.titlebarBottom, `${label}: settings backdrop overlaps title bar`);
    const overlaps = value.close.left < value.caption.right && value.close.right > value.caption.left && value.close.top < value.caption.bottom && value.close.bottom > value.caption.top;
    assert(!overlaps, `${label}: settings close intersects caption controls`);
    assert(value.hitIsClose && value.appRegion === "no-drag", `${label}: settings close hit target is invalid`);
    evidence.push({ label, value });
  };
  for (const size of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1100, height: 700 }]) {
    await app.evaluate(({ BrowserWindow }, next) => { const win = BrowserWindow.getAllWindows()[0]; if (win.isMaximized()) win.unmaximize(); win.setContentSize(next.width, next.height); win.webContents.setZoomFactor(1); }, size);
    await geometry(`${size.width}x${size.height}`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize()); await page.waitForTimeout(300); await geometry("maximized");
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize()); await page.waitForTimeout(300); await geometry("restored");
  await page.keyboard.press("Escape"); assert(await dialog.count() === 0, "Escape did not close settings"); assert((await app.windows()).length === 1, "Escape affected application window");
  await page.getByRole("button", { name: /Добавить модель/ }).click(); await dialog.getByLabel("Закрыть настройки").click(); assert(await dialog.count() === 0, "settings close failed"); assert((await app.windows()).length === 1, "settings close affected application window");
  console.log(JSON.stringify({ ok: true, zoom: 1, evidence }, null, 2));
} finally { await app?.close().catch(() => undefined); await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined); }
