import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryBase = await mkdtemp(join(tmpdir(), "g-plus-g-header-"));
const dataRoot = join(temporaryBase, "очень-длинный-путь-данных-".repeat(4));
await mkdir(dataRoot, { recursive: true });
const screenshotRoot = resolve("docs", "screenshots");
await mkdir(screenshotRoot, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

async function setWindow(width, height) {
  return app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(1);
    return {
      zoom: window.webContents.getZoomFactor(),
      menuBarVisible: window.isMenuBarVisible(),
      autoHideMenuBar: window.autoHideMenuBar,
    };
  }, { width, height });
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { top: value.top, right: value.right, bottom: value.bottom, left: value.left, width: value.width, height: value.height } : null;
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      header: rect("header"),
      brand: rect(".header-left"),
      specification: rect(".specification-btn"),
      notification: rect(".app-notification"),
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      appRegion: getComputedStyle(document.querySelector("header")).getPropertyValue("-webkit-app-region"),
      buttonRegion: getComputedStyle(document.querySelector(".specification-btn")).getPropertyValue("-webkit-app-region"),
    };
  });
}

function assertHeader(state, label) {
  assert(state.header && state.brand && state.specification, `${label}: header region missing`);
  assert(state.header.top === 0 && state.header.bottom === 56, `${label}: header is not exactly 56px`);
  assert(state.specification.right <= state.viewport.width - 138, `${label}: specification overlaps native controls`);
  assert(state.brand.right < state.specification.left, `${label}: brand overlaps specification`);
  assert(state.document.scrollWidth <= state.document.clientWidth, `${label}: horizontal overflow`);
  assert(state.document.scrollHeight <= state.document.clientHeight, `${label}: vertical overflow`);
  assert(state.appRegion === "drag", `${label}: header is not a drag region`);
  assert(state.buttonRegion === "no-drag", `${label}: specification is covered by drag region`);
  if (state.notification) {
    assert(state.notification.top >= state.header.bottom, `${label}: notification overlaps header`);
    assert(state.notification.right <= state.viewport.width && state.notification.left >= 0, `${label}: notification outside viewport`);
    assert(state.notification.height <= 64, `${label}: notification exceeds two-line compact height`);
  }
}

try {
  app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(3_000);
  const project = await page.evaluate(() => window.orchestrator.projects.create("Header geometry project", ["chatgpt"]));
  await page.reload();
  await page.waitForTimeout(3_000);
  await page.getByText(project.name, { exact: true }).click();

  const cases = [
    { width: 1920, height: 1080, theme: "dark", file: "header-1920x1080-dark.png" },
    { width: 1366, height: 768, theme: "light", file: "header-1366x768-light.png" },
    { width: 1100, height: 700, theme: "dark", file: "header-1100x700-long-notification.png" },
  ];
  const evidence = [];

  for (const item of cases) {
    const windowState = await setWindow(item.width, item.height);
    assert(windowState.zoom === 1, `${item.width}: browser zoom is not 100%`);
    assert(windowState.autoHideMenuBar === true && windowState.menuBarVisible === false, `${item.width}: application menu is not safely auto-hidden`);
    await page.evaluate(async (theme) => {
      document.documentElement.dataset.theme = theme;
      await window.orchestrator.window.setTheme(theme);
    }, item.theme);

    if (item.width === 1100) {
      await page.locator(".composer-bottom").evaluate((element) => {
        const data = new DataTransfer();
        data.items.add(new File(["not-a-trusted-path"], "diagnostic.txt", { type: "text/plain" }));
        element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await page.locator(".app-notification").waitFor();
      await page.locator(".app-notification-text").evaluate((element) => {
        element.textContent = "Проект удалён локально. Приложение не увидело все удалённые веб-диалоги; доступные данные сохранены, подробности находятся в журнале диагностики. ".repeat(3);
      });
    }

    await page.waitForTimeout(200);
    const state = await geometry(page);
    assertHeader(state, `${item.width}x${item.height}/${item.theme}`);
    const output = join(screenshotRoot, item.file);
    await page.screenshot({ path: output, fullPage: false });
    evidence.push({ ...item, output, state });
    if (item.width === 1100) {
      await page.getByRole("button", { name: "Закрыть уведомление" }).click();
      await page.locator(".app-notification").waitFor({ state: "detached" });
    }
  }

  const windowControls = await app.evaluate(async ({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.maximize();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    const maximized = window.isMaximized();
    window.restore();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
    return { maximized, restored: !window.isMaximized(), hasApplicationMenu: Menu.getApplicationMenu() !== null };
  });
  assert(windowControls.maximized && windowControls.restored, "Native maximize/restore controls are not functional");
  assert(windowControls.hasApplicationMenu, "Application menu and accelerators were removed");

  console.log(JSON.stringify({ ok: true, windowControls, evidence }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(temporaryBase, { recursive: true, force: true }).catch(() => undefined);
}
