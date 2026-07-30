import { _electron as electron } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve("release/win-unpacked/G plus G.exe");
const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-smoke-"));
let application;

try {
  application = await electron.launch({
    executablePath,
    env: {
      ...process.env,
      G_PLUS_G_USER_DATA: dataRoot,
    },
  });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");

  const projectName = `Packaged smoke ${Date.now()}`;
  await page.getByPlaceholder("Название проекта").fill(projectName);
  await page.getByRole("button", { name: "Создать" }).click();
  await page.getByRole("heading", { name: projectName }).waitFor();

  await page.getByRole("button", { name: /Профиль.*Настройки/ }).click();
  await page.getByRole("heading", { name: "Профиль и настройки" }).waitFor();
  await page.getByLabel("Отображаемое имя").fill("Smoke tester");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: /Smoke tester.*Настройки/ }).waitFor();

  const preflight = await page.evaluate(() => window.orchestrator.system.preflight());
  const failedChecks = preflight.filter((check) => check.status === "fail");
  const browserCheck = preflight.find((check) => check.name === "browser");
  if (failedChecks.length > 0 || browserCheck?.status !== "pass") {
    throw new Error(`Packaged preflight failed: ${JSON.stringify(preflight)}`);
  }

  const urlBefore = page.url();
  const popup = await page.evaluate(() => {
    const opened = window.open("javascript:document.body.textContent='compromised'");
    return opened !== null;
  });
  await page.waitForTimeout(300);
  const urlAfter = page.url();

  if (urlBefore !== "app://bundle/index.html" || urlAfter !== urlBefore) {
    throw new Error(`Renderer escaped trusted origin: ${urlBefore} -> ${urlAfter}`);
  }
  if (popup) throw new Error("Unsafe popup was not denied");

  console.log(JSON.stringify({
    ok: true,
    executablePath,
    projectCreated: projectName,
    settingsPersistedInUi: true,
    trustedOrigin: urlAfter,
    unsafePopupDenied: true,
    preflight,
  }, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
