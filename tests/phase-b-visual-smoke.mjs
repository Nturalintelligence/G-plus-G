import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve("release/win-unpacked/G plus G.exe");
const outputDir = resolve("output/playwright");
const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-phase-b1-"));
await mkdir(outputDir, { recursive: true });
let application;

async function launch() {
  application = await electron.launch({ executablePath, env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot } });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page;
}

try {
  let page = await launch();
  const projectName = `Phase B.1 visual ${Date.now()}`;
  await page.getByRole("button", { name: "Новый" }).click();
  await page.getByPlaceholder("Например: Мой Салон Красоты").fill(projectName);
  await page.getByRole("button", { name: "Создать проект" }).click();
  await page.getByText(projectName, { exact: true }).waitFor();

  const staged = await page.evaluate(async (name) => {
    const project = (await window.orchestrator.projects.list()).find((item) => item.name === name);
    if (!project) throw new Error("Visual smoke project not found");
    const specs = [
      ["wide.png", "image/png", 1600, 120, "#d8653b"],
      ["tall.jpeg", "image/jpeg", 120, 1600, "#3b82f6"],
      ["screen.webp", "image/webp", 480, 300, "#22c55e"],
      ["screen-2.png", "image/png", 500, 320, "#a855f7"],
    ];
    const refs = [];
    for (const [fileName, mimeType, width, height, color] of specs) {
      const canvas = document.createElement("canvas");
      canvas.width = Number(width); canvas.height = Number(height);
      const context = canvas.getContext("2d");
      context.fillStyle = String(color); context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "white"; context.font = "28px sans-serif"; context.fillText(String(fileName), 12, 42);
      const blob = await new Promise((resolveBlob) => canvas.toBlob(resolveBlob, String(mimeType), .9));
      refs.push(await window.orchestrator.attachments.stageClipboard(project.id, "draft-visual", new Uint8Array(await blob.arrayBuffer()), String(mimeType), String(fileName)));
    }
    return { projectId: project.id, refs };
  }, projectName);
  for (const dto of staged.refs) {
    if ("localRelativePath" in dto || "sha256" in dto || "providerMetadata" in dto) throw new Error("Unsafe renderer DTO");
  }

  await application.close(); application = undefined;
  const database = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const insert = database.prepare(`INSERT INTO conversation_entries
    (id, project_id, run_id, role, provider_id, round, content, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`);
  insert.run("visual-user", staged.projectId, "USER", null, null, "Проверь полный ход обсуждения", "2026-08-24T10:00:00.000Z");
  const longText = "Длинный ответ модели без обрезания. ".repeat(90);
  for (let round = 1; round <= 7; round += 1) {
    insert.run(`visual-turn-${round}`, staged.projectId, "ASSISTANT", round % 2 ? "chatgpt" : "gemini", round, `${longText}\n\nРаунд ${round}: проверка полной хронологии.`, `2026-08-24T10:0${round}:00.000Z`);
  }
  insert.run("visual-final", staged.projectId, "ASSISTANT", "final", 8, "Итоговый ответ остаётся видимым отдельно.", "2026-08-24T10:08:00.000Z");
  database.close();

  page = await launch();
  await page.getByText(projectName, { exact: true }).click();
  await page.locator('[title^="wide.png"]').waitFor();
  let thumbnails = page.locator(".attachment-thumbnail");
  if (await thumbnails.count() !== 4) throw new Error("Expected four image thumbnails");

  for (const [theme, zoom] of [["light", 1], ["dark", 1.25], ["dark", 1.5]]) {
    await page.evaluate(async ({ selectedTheme }) => {
      const settings = await window.orchestrator.settings.get();
      await window.orchestrator.settings.save({ ...settings, appearance: { ...settings.appearance, theme: selectedTheme } });
    }, { selectedTheme: theme });
    await page.reload();
    await page.getByText(projectName, { exact: true }).click();
    await page.locator('[title^="wide.png"]').waitFor();
    await page.evaluate((selectedZoom) => { document.body.style.zoom = String(selectedZoom); }, zoom);
    const geometry = await page.evaluate(() => {
      const composer = document.querySelector(".composer-bottom").getBoundingClientRect();
      const cards = [...document.querySelectorAll(".attachment-thumbnail")].map((node) => node.getBoundingClientRect());
      return { composerRight: composer.right, bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth, cards: cards.map((box) => ({ right: box.right, width: box.width, height: box.height })) };
    });
    if (geometry.bodyOverflow || geometry.cards.some((card) => card.right > geometry.composerRight + 1 || Math.abs(card.width - card.height) > 1)) throw new Error(`Thumbnail layout overflow: ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: join(outputDir, `phase-b1-${theme}-${Math.round(Number(zoom) * 100)}.png`), fullPage: true });
  }

  thumbnails = page.locator(".attachment-thumbnail");
  await page.evaluate(() => { document.body.style.zoom = "1"; });
  await thumbnails.first().locator(".attachment-thumbnail-open").click();
  const modal = page.locator(".image-preview-modal-card");
  await modal.waitFor();
  const modalBox = await modal.boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (!modalBox || !viewport || modalBox.width > viewport.width * .91 || modalBox.height > viewport.height * .91) throw new Error(`Preview exceeds viewport: ${JSON.stringify({ modalBox, viewport })}`);
  await page.screenshot({ path: join(outputDir, "phase-b1-preview.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  await thumbnails.first().locator(".attachment-thumbnail-open").click();
  await page.locator(".image-preview-backdrop").click({ position: { x: 5, y: 5 } });
  await modal.waitFor({ state: "hidden" });
  await thumbnails.first().locator(".attachment-thumbnail-open").click();
  await page.getByLabel("Закрыть просмотр").click();
  await modal.waitFor({ state: "hidden" });

  const initialCount = await thumbnails.count();
  await thumbnails.last().locator(".attachment-thumbnail-remove").click();
  if (await thumbnails.count() !== initialCount - 1) throw new Error("Thumbnail removal failed");

  await page.getByRole("button", { name: /Показать ход обсуждения/ }).click();
  let discussion = page.getByLabel("Ход обсуждения моделей");
  await discussion.waitFor();
  if (await discussion.locator(".discussion-turn").count() !== 7) throw new Error("Discussion chronology is incomplete");
  await page.screenshot({ path: join(outputDir, "phase-b1-right-drawer.png"), fullPage: true });
  const discussionScroll = discussion.locator(".discussion-view-scroll");
  await discussionScroll.evaluate((node) => { node.scrollTop = 500; });
  await page.getByLabel("Вернуться к итоговому ответу").click();
  await page.getByRole("button", { name: /Показать ход обсуждения/ }).click();
  if (await discussionScroll.evaluate((node) => node.scrollTop) < 450) throw new Error("Discussion scroll position was not preserved");
  await page.getByLabel("Вернуться к итоговому ответу").click();

  await page.evaluate(async () => {
    const settings = await window.orchestrator.settings.get();
    await window.orchestrator.settings.save({ ...settings, appearance: { ...settings.appearance, discussionView: "FULLSCREEN" } });
  });
  await page.reload(); await page.getByText(projectName, { exact: true }).click();
  await page.getByRole("button", { name: /Показать ход обсуждения/ }).click();
  discussion = page.getByLabel("Ход обсуждения моделей");
  await page.screenshot({ path: join(outputDir, "phase-b1-fullscreen.png"), fullPage: true });
  const persisted = await page.evaluate(() => window.orchestrator.settings.get());
  if (persisted.appearance.discussionView !== "FULLSCREEN") throw new Error("Discussion setting was not persisted");

  await page.setViewportSize({ width: 700, height: 760 });
  const narrowBox = await discussion.boundingBox();
  if (!narrowBox || narrowBox.width < 690) throw new Error("Narrow discussion did not switch to fullscreen");
  await page.screenshot({ path: join(outputDir, "phase-b1-narrow.png"), fullPage: true });

  console.log(JSON.stringify({ ok: true, thumbnails: 4, discussionTurns: 7, persistedView: persisted.appearance.discussionView }, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
