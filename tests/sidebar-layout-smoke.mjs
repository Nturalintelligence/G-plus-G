import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-sidebar-layout-"));
const screenshotRoot = resolve("docs", "screenshots");
await mkdir(screenshotRoot, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

async function setContentSize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(size.width, size.height);
    window.webContents.setZoomFactor(1);
  }, { width, height });
}

async function geometry(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box ? { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height } : null;
    };
    const list = document.querySelector(".projects-list-nav");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight,
      },
      sidebar: rect(".sidebar-pane"),
      header: rect(".sidebar-header"),
      list: rect(".projects-list-nav"),
      models: rect(".sidebar-models-section"),
      footer: rect(".sidebar-footer"),
      workspace: rect(".workspace"),
      listMetrics: list ? {
        clientHeight: list.clientHeight,
        scrollHeight: list.scrollHeight,
        clientWidth: list.clientWidth,
        scrollWidth: list.scrollWidth,
        scrollTop: list.scrollTop,
        overflowY: getComputedStyle(list).overflowY,
        overflowX: getComputedStyle(list).overflowX,
      } : null,
      devicePixelRatio: window.devicePixelRatio,
    };
  });
}

function assertFit(state, label) {
  assert(state.sidebar && state.header && state.list && state.models && state.footer && state.workspace, `${label}: required region missing`);
  assert(state.sidebar.top >= 0 && state.sidebar.bottom <= state.viewport.height + 0.5, `${label}: sidebar outside viewport`);
  assert(state.footer.bottom <= state.viewport.height + 0.5, `${label}: footer outside viewport`);
  assert(state.models.bottom <= state.footer.top + 0.5, `${label}: models overlap footer`);
  assert(state.header.bottom <= state.list.top + 0.5, `${label}: header overlaps project list`);
  assert(state.list.bottom <= state.models.top + 0.5, `${label}: project list overlaps models`);
  assert(state.listMetrics.scrollHeight > state.listMetrics.clientHeight, `${label}: project list is not independently scrollable`);
  assert(state.listMetrics.overflowY === "auto", `${label}: project list overflow-y is not auto`);
  assert(state.listMetrics.scrollWidth <= state.listMetrics.clientWidth, `${label}: project list has horizontal overflow`);
  assert(state.document.scrollWidth <= state.document.clientWidth, `${label}: document has horizontal overflow`);
  assert(state.document.scrollHeight <= state.document.clientHeight, `${label}: document has vertical overflow`);
}

try {
  app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const names = Array.from({ length: 36 }, (_, index) =>
    `Проект ${String(index + 1).padStart(2, "0")} — очень длинное Unicode название для проверки многоточия 漢字 🚀 ${"секция-".repeat(4)}`,
  );
  await page.evaluate(async (projectNames) => {
    for (const name of projectNames) await window.orchestrator.projects.create(name, ["chatgpt", "gemini"]);
  }, names);
  await page.reload();
  await page.locator(".project-row").first().waitFor();
  await page.waitForTimeout(3_000);
  assert(await page.locator(".project-row").count() >= 36, "Fewer than 36 projects rendered");

  const display = await app.evaluate(({ BrowserWindow, screen }) => ({
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    browserZoomFactor: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
  }));
  assert(display.browserZoomFactor === 1, `Browser zoom must be 100%, got ${display.browserZoomFactor * 100}%`);
  const cases = [
    { width: 1920, height: 1080, theme: "dark", file: "sidebar-long-list-1920x1080-dark.png" },
    { width: 1366, height: 768, theme: "light", file: "sidebar-long-list-1366x768-light.png" },
    { width: 1100, height: 700, theme: "dark", file: "sidebar-long-list-1100x700-dark.png" },
  ];
  const evidence = [];
  let persistedProjectTitle = "";

  for (const item of cases) {
    await setContentSize(item.width, item.height);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, item.theme);
    await page.waitForTimeout(250);
    const before = await geometry(page);
    assertFit(before, `${item.width}x${item.height}/${item.theme}`);

    const rows = page.locator(".project-row");
    for (const index of [0, Math.floor((await rows.count()) / 2), (await rows.count()) - 1]) {
      await rows.nth(index).locator(".project-btn").click();
      await rows.nth(index).locator('.project-btn[aria-current="page"]').waitFor();
      await page.waitForFunction((rowIndex) => {
        const row = document.querySelectorAll(".project-row")[rowIndex]?.getBoundingClientRect();
        const list = document.querySelector(".projects-list-nav")?.getBoundingClientRect();
        return Boolean(row && list && row.top >= list.top - 1 && row.bottom <= list.bottom + 1);
      }, index);
    }

    const middle = rows.nth(Math.floor((await rows.count()) / 2));
    await middle.locator(".project-btn").click();
    await middle.locator('.project-btn[aria-current="page"]').waitFor();
    persistedProjectTitle = await middle.locator(".project-name").getAttribute("title") || "";
    await middle.locator(".project-menu-btn").click();
    await middle.locator(".project-context-menu").waitFor();
    assert(persistedProjectTitle.length > 60, "Full project title tooltip is missing");
    await middle.locator(".project-menu-btn").click();

    const footerBeforeWheel = await page.locator(".sidebar-footer").boundingBox();
    const workspaceBeforeWheel = await page.locator(".workspace").boundingBox();
    await page.locator(".projects-list-nav").hover();
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(100);
    const after = await geometry(page);
    const footerAfterWheel = await page.locator(".sidebar-footer").boundingBox();
    const workspaceAfterWheel = await page.locator(".workspace").boundingBox();
    assert(after.listMetrics.scrollTop > 0, "Mouse wheel did not scroll project list");
    const footerShift = footerBeforeWheel && footerAfterWheel ? Math.abs(footerBeforeWheel.y - footerAfterWheel.y) : Number.POSITIVE_INFINITY;
    assert(footerShift < 1, `Project scrolling moved sidebar footer by ${footerShift}px`);
    assert(workspaceBeforeWheel && workspaceAfterWheel && Math.abs(workspaceBeforeWheel.height - workspaceAfterWheel.height) < 0.5, "Project scrolling resized workspace");
    assertFit(after, `${item.width}x${item.height}/${item.theme}/scrolled`);

    const output = join(screenshotRoot, item.file);
    await page.screenshot({ path: output, fullPage: false });
    evidence.push({ ...item, output, geometry: after });
  }

  await page.reload();
  await page.locator('.project-btn[aria-current="page"]').waitFor();
  const restoredTitle = await page.locator('.project-btn[aria-current="page"] .project-name').getAttribute("title");
  assert(restoredTitle === persistedProjectTitle, "Selected project did not survive renderer reload");

  console.log(JSON.stringify({ ok: true, projectCount: names.length, browserZoomFactor: display.browserZoomFactor, windowsScaleFactor: display.scaleFactor, evidence }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
