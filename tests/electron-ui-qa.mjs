import { _electron as electron } from "playwright";
import { resolve } from "node:path";

const cwd = resolve(".");
const executablePath = resolve("node_modules/electron/dist/electron.exe");
const screenshotPath = resolve("release/ui-qa-0.0.4.png");
let app;

try {
  app = await electron.launch({ executablePath, args: ["."], cwd });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const projectName = `UI QA ${Date.now()}`;
  await page.getByPlaceholder("Название проекта").fill(projectName);
  await page.getByRole("button", { name: "Создать" }).click();
  await page.getByRole("heading", { name: projectName }).waitFor();

  const composer = page.getByPlaceholder(/Напишите сообщение/);
  await composer.fill("line one");
  await composer.press("Shift+Enter");
  await composer.type("line two");
  const shiftEnterValue = await composer.inputValue();

  await page.locator("select").selectOption("MANUAL");
  const gemini = page.getByLabel("gemini");
  if (await gemini.isChecked()) await gemini.uncheck();
  await composer.fill("Ответь только словом UI_ENTER_OK");
  await composer.press("Enter");
  const clearedAfterEnter = (await composer.inputValue()) === "";

  await page.locator(".status").filter({
    hasNotText: /Модели обсуждают сообщение/,
  }).waitFor({ timeout: 60_000 });
  const finalStatus = await page.locator(".status").innerText();
  const messagesAfterSend = await page.locator(".message").count();
  await page.screenshot({ path: screenshotPath, type: "png" });

  await app.close();
  app = await electron.launch({ executablePath, args: ["."], cwd });
  const reopened = await app.firstWindow();
  await reopened.getByRole("button", { name: new RegExp(projectName) }).click();
  const messagesAfterRestart = await reopened.locator(".message").count();
  const modeLabel = await reopened.locator("select").inputValue();
  const fit = await reopened.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    scrollY: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));

  console.log(JSON.stringify({
    projectName,
    shiftEnterValue,
    clearedAfterEnter,
    finalStatus,
    messagesAfterSend,
    messagesAfterRestart,
    modeLabel,
    fit,
    screenshotPath,
  }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
}
