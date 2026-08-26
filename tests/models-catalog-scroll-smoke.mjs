import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-model-catalog-"));
const screenshots = resolve("docs", "screenshots");
await mkdir(screenshots, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };

let app;
try {
  app = await electron.launch({
    args: ["."],
    cwd: resolve("."),
    env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.getByRole("button", { name: /Добавить модель/ }).click();
  await page.getByRole("button", { name: "Модели и авторизация" }).click();
  const modal = page.locator(".settings-modal-dialog");
  const header = modal.locator(".models-catalog-header");
  const list = modal.locator(".models-settings-list");
  const search = modal.locator(".models-search-input");
  await list.waitFor();

  async function resize(width, height) {
    await app.evaluate(({ BrowserWindow }, size) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(size.width, size.height);
      win.webContents.setZoomFactor(1);
    }, { width, height });
  }

  async function setCardCount(count) {
    await list.evaluate((element, requested) => {
      element.querySelectorAll(":scope > [data-smoke-clone]").forEach((clone) => clone.remove());
      const originals = [...element.querySelectorAll(":scope > .model-setting-card")];
      if (!originals.length) throw new Error("No production model card fixture");
      for (let index = originals.length; index < requested; index += 1) {
        const clone = originals[index % originals.length].cloneNode(true);
        clone.dataset.smokeClone = "true";
        const name = clone.querySelector(".model-name-text");
        if (name) name.textContent = `Очень длинное Unicode-название модели №${index + 1} — Проверка прокрутки`;
        element.append(clone);
      }
    }, count);
  }

  async function geometry(label, expectedCount) {
    await setCardCount(expectedCount);
    await list.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(100);
    const state = await modal.evaluate((dialog) => {
      const catalogHeader = dialog.querySelector(".models-catalog-header");
      const catalogList = dialog.querySelector(".models-settings-list");
      const footer = dialog.querySelector(".settings-dialog-footer");
      const topCard = catalogList?.querySelector(".model-setting-card");
      if (!catalogHeader || !catalogList || !footer || !topCard) throw new Error("Missing model catalog geometry");
      const modalRect = dialog.getBoundingClientRect();
      const headerRect = catalogHeader.getBoundingClientRect();
      const listRect = catalogList.getBoundingClientRect();
      const cardRect = topCard.getBoundingClientRect();
      const footerRect = footer.getBoundingClientRect();
      const probe = document.elementFromPoint(listRect.left + 24, Math.max(headerRect.top + 1, listRect.top - 2));
      return {
        modal: { top: modalRect.top, bottom: modalRect.bottom },
        header: { top: headerRect.top, bottom: headerRect.bottom },
        list: { top: listRect.top, bottom: listRect.bottom, clientHeight: catalogList.clientHeight, scrollHeight: catalogList.scrollHeight },
        footer: { top: footerRect.top, bottom: footerRect.bottom },
        cardTop: cardRect.top,
        probeIsCard: Boolean(probe?.closest(".model-setting-card")),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert(state.header.top >= state.modal.top && state.header.bottom <= state.modal.bottom, `${label}: header outside modal`);
    assert(state.list.top >= state.header.bottom - 0.5 && state.list.bottom <= state.modal.bottom, `${label}: list outside content viewport`);
    assert(state.list.bottom <= state.footer.top + 0.5 && state.footer.bottom <= state.modal.bottom, `${label}: footer is obscured or outside modal`);
    assert(state.list.scrollHeight > state.list.clientHeight, `${label}: list is not independently scrollable`);
    assert(state.cardTop < state.list.top, `${label}: first card did not travel beneath list boundary`);
    assert(!state.probeIsCard, `${label}: clipped card paints over catalog header`);
    assert(state.documentOverflow <= 0, `${label}: horizontal overflow`);
    assert(await search.isEnabled(), `${label}: search is not clickable`);
    await list.evaluate((element) => { element.scrollTop = 0; });
    return state;
  }

  await setCardCount(5);
  await search.fill("ChatGPT");
  assert(await list.locator(":scope > .model-setting-card").count() === 1, "search/filter failed after scrolling");
  await search.fill("");
  await list.locator(".accordion-toggle-btn").first().click();
  assert(await list.locator(".model-setting-card.expanded").count() === 1, "model expansion failed");
  await resize(1100, 700);
  await geometry("1100x700 with 5 models", 5);

  const cases = [
    { width: 1920, height: 1080, theme: "dark", count: 50 },
    { width: 1366, height: 768, theme: "light", count: 20 },
    { width: 1100, height: 700, theme: "dark", count: 50 },
  ];
  const evidence = [];
  for (const item of cases) {
    await resize(item.width, item.height);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, item.theme);
    evidence.push({ ...item, geometry: await geometry(`${item.width}x${item.height}`, item.count) });
    await page.screenshot({ path: join(screenshots, `phase-e-model-catalog-${item.width}x${item.height}-${item.theme}.png`), fullPage: false });
  }
  console.log(JSON.stringify({ ok: true, zoomFactor: await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), evidence }, null, 2));
} finally {
  if (app) await app.close();
  await rm(dataRoot, { recursive: true, force: true });
}
