import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureDataRoot } from "../dist/src/paths.js";
import { AppDatabase } from "../dist/src/storage/database.js";
import { ProjectRepository } from "../dist/src/storage/repository.js";
import { AttachmentStagingService } from "../dist/src/attachments/attachment-staging.js";

const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-message-cards-"));
const screenshots = resolve("docs", "screenshots");
await mkdir(screenshots, { recursive: true });
const assert = (condition, message) => { if (!condition) throw new Error(message); };
configureDataRoot(dataRoot);
const database = new AppDatabase();
database.migrate();
const repository = new ProjectRepository(database);
const project = repository.createProject("Message cards restart persistence", ["chatgpt", "gemini"]);
repository.appendConversationEntry({ id: "entry-user-attachment", projectId: project.id, role: "USER", content: "тест" });
new AttachmentStagingService(database.raw).stageBytes(
  new Uint8Array(await readFile(resolve("tests/fixtures/user-regression-screenshot.png"))),
  { projectId: project.id, messageId: "entry-user-attachment" },
  "пользовательский-скриншот.png",
);
repository.appendConversationEntry({ id: "entry-user-multiline", projectId: project.id, role: "USER", content: "Первая строка\nВторая строка\nТретья строка" });
const markdown = "# Длинный Markdown\n\n**Исходная разметка** сохраняется.\n\n```ts\nconst answer = 42;\nconsole.log(answer);\n```\n\n" + "Очень длинный текст с переносом без горизонтального выхода. ".repeat(22);
repository.appendConversationEntry({ id: "entry-chatgpt", projectId: project.id, role: "ASSISTANT", providerId: "chatgpt", round: 1, content: markdown });
repository.appendConversationEntry({ id: "entry-gemini", projectId: project.id, role: "ASSISTANT", providerId: "gemini", round: 2, content: "Gemini: компактный промежуточный ответ." });
repository.appendConversationEntry({ id: "entry-final", projectId: project.id, role: "ASSISTANT", providerId: "final", round: 3, content: "Итоговый ответ\n\n```text\nготово\n```\n[[G_PLUS_G_DONE:internal-run-id]]" });
repository.appendConversationEntry({ id: "entry_stopped_visual", projectId: project.id, role: "SYSTEM", content: "Обсуждение остановлено пользователем" });
database.close();

let app;
async function launch() {
  app = await electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.locator(".project-row").first().waitFor();
  await page.getByTitle(project.name).click();
  await page.locator(".message.user").first().waitFor();
  return page;
}

async function resize(width, height) {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(size.width, size.height);
    win.webContents.setZoomFactor(1);
  }, { width, height });
}

async function assertNoOverflow(page, label) {
  const state = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  assert(state.scroll <= state.client, `${label}: horizontal overflow ${state.scroll}/${state.client}`);
}

try {
  let page = await launch();
  const cases = [
    { width: 1920, height: 1080, theme: "dark", file: "phase-e2-messages-1920x1080-dark.png" },
    { width: 1366, height: 768, theme: "light", file: "phase-e2-messages-1366x768-light.png" },
    { width: 1100, height: 700, theme: "dark", file: "phase-e2-messages-1100x700-dark.png" },
  ];
  for (const item of cases) {
    await resize(item.width, item.height);
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, item.theme);
    const card = page.locator(".message.user").first();
    const before = await card.boundingBox();
    await card.hover();
    await page.waitForTimeout(200);
    const hoverAction = card.locator(".message-copy");
    const hoverState = await card.locator(".message-actions").evaluate((element) => ({ opacity: getComputedStyle(element).opacity, visibility: getComputedStyle(element).visibility, pointerEvents: getComputedStyle(element).pointerEvents }));
    assert(await hoverAction.isVisible(), `${item.width}: hover copy action is hidden ${JSON.stringify(hoverState)}`);
    const afterHover = await card.boundingBox();
    await hoverAction.focus();
    assert(await hoverAction.isVisible(), `${item.width}: keyboard-focused copy action is hidden`);
    const afterFocus = await card.boundingBox();
    assert(before && afterHover && afterFocus && Math.abs(before.height - afterHover.height) < 0.5 && Math.abs(before.height - afterFocus.height) < 0.5, `${item.width}: action bar changes card height`);
    await assertNoOverflow(page, `${item.width}x${item.height}`);
    await page.screenshot({ path: join(screenshots, item.file), fullPage: false });
  }

  await page.locator(".run-summary-bar-header").click();
  await page.getByRole("button", { name: "Живой диалог" }).click();
  assert(await page.locator(".message.assistant.chatgpt").count() === 1, "ChatGPT message missing in live transcript");
  assert(await page.locator(".message.assistant.gemini").count() === 1, "Gemini message missing in live transcript");
  assert(await page.locator(".message.cancelled").count() === 1, "Cancelled system message is not distinguished");
  const chatgptCopy = page.locator(".message.assistant.chatgpt .message-copy");
  await chatgptCopy.focus();
  await page.waitForTimeout(200);
  await chatgptCopy.click();
  await chatgptCopy.getByText("Скопировано", { exact: true }).waitFor({ timeout: 3_000 });

  const finalCopy = page.locator(".message.assistant.final .message-copy");
  await finalCopy.focus();
  await page.waitForTimeout(200);
  await finalCopy.click();
  await finalCopy.getByText("Скопировано", { exact: true }).waitFor({ timeout: 3_000 });

  await app.close();
  app = undefined;
  page = await launch();
  const attachmentCard = page.locator(".message.user").filter({ hasText: "тест" });
  assert(await attachmentCard.locator(".message-attachments").count() === 1, "User attachment did not persist after restart");
  await attachmentCard.locator(".message-copy").focus();
  await page.waitForTimeout(200);
  await attachmentCard.locator(".message-copy").click();
  await attachmentCard.locator(".message-copy").getByText("Скопировано", { exact: true }).waitFor({ timeout: 3_000 });
  await assertNoOverflow(page, "restart");

  const zoom = await app.evaluate(({ BrowserWindow, screen }) => ({
    zoomFactor: BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    windowsScaleFactor: screen.getPrimaryDisplay().scaleFactor,
  }));
  assert(zoom.zoomFactor === 1, `Browser zoom is not 100%: ${zoom.zoomFactor}`);
  console.log(JSON.stringify({ ok: true, copiedMarkdownChars: markdown.length, restartPersistence: true, ...zoom }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
