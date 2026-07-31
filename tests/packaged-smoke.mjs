import { _electron as electron } from "playwright";
import { access, mkdtemp, rm } from "node:fs/promises";
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
  await page.getByRole("button", { name: "Выйти из chatgpt" }).waitFor();
  await page.getByRole("button", { name: "Выйти из gemini" }).waitFor();
  await page.getByLabel("Режим оркестрации").selectOption("SEQUENTIAL");
  await page.getByLabel("Первым отвечает").selectOption("gemini");
  if (await page.getByLabel("Первым отвечает").inputValue() !== "gemini") {
    throw new Error("Provider starter order was not selectable");
  }

  await page.locator("summary").filter({ hasText: "Требования" }).click();
  await page.getByRole("button", { name: "+ Добавить", exact: true }).first().click();
  await page.getByLabel("Требования, пункт 1").fill("Приложение сохраняет проект локально");
  await page.getByLabel("Критерии приёмки, пункт 1").fill("Проект открывается после перезапуска");
  await page.getByRole("button", { name: "Сохранить черновик" }).click();
  await page.getByText(/Версия 1 · DRAFT/).waitFor();

  const savedProjectState = await page.evaluate(async (name) => {
    const project = (await window.orchestrator.projects.list())
      .find((candidate) => candidate.name === name);
    if (!project) throw new Error("Smoke project not found");
    return (await window.orchestrator.projects.open(project.id)).state?.state;
  }, projectName);
  if (
    savedProjectState?.requirements[0]?.text !== "Приложение сохраняет проект локально" ||
    savedProjectState?.acceptanceCriteria[0]?.text !== "Проект открывается после перезапуска"
  ) {
    throw new Error(`Visual Project State was not persisted: ${JSON.stringify(savedProjectState)}`);
  }

  await page.getByRole("button", { name: /Профиль.*Настройки/ }).click();
  await page.getByRole("heading", { name: "Профиль и настройки" }).waitFor();
  await page.getByRole("button", { name: /Центр качества/ }).click();
  await page.getByText("Центр качества · последние 30 дней", { exact: true }).waitFor();
  await page.getByRole("button", { name: "👤 Профиль", exact: true }).click();
  await page.getByPlaceholder("Отображаемое имя").fill("Smoke tester");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.getByRole("button", { name: /Smoke tester.*Настройки/ }).waitFor();

  const preflight = await page.evaluate(() => window.orchestrator.system.preflight());
  const qualityDashboard = await page.evaluate(() => window.orchestrator.quality.dashboard());
  const releaseInfo = await page.evaluate(() => window.orchestrator.system.info());
  const backupPath = await page.evaluate(() => window.orchestrator.maintenance.backup());
  await access(join(backupPath, "manifest.json"));
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
    providerLogoutAvailable: true,
    providerStarterSelectable: true,
    visualProjectStatePersisted: true,
    settingsPersistedInUi: true,
    trustedOrigin: urlAfter,
    unsafePopupDenied: true,
    preflight,
    qualityDashboardAvailable: Array.isArray(qualityDashboard.overall),
    releaseInfo,
    backupCreated: backupPath,
  }, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
