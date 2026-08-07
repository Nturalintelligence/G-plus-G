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
  await page.getByRole("button", { name: "Новый" }).click();
  await page.getByPlaceholder("Например: Мой Салон Красоты").fill(projectName);
  await page.getByRole("button", { name: "Создать проект" }).click();
  await page.getByText(projectName, { exact: true }).waitFor();
  const projectApiCheck = await page.evaluate(async (name) => {
    const project = (await window.orchestrator.projects.list())
      .find((candidate) => candidate.name === name);
    if (!project) throw new Error("Smoke project not found");
    const opened = await window.orchestrator.projects.open(project.id);
    const state = {
      requirements: [{ id: "req-smoke", text: "Persist locally", sourceTurnIds: [] }],
      constraints: [], decisions: [], rejectedOptions: [], openQuestions: [],
      acceptanceCriteria: [{ id: "ac-smoke", text: "Reload succeeds", sourceTurnIds: [] }],
    };
    await window.orchestrator.state.save(project.id, state);
    const savedState = await window.orchestrator.state.latest(project.id);
    const settings = await window.orchestrator.settings.get();
    await window.orchestrator.settings.save({
      ...settings,
      profile: { ...settings.profile, displayName: "Smoke tester" },
    });
    const savedSettings = await window.orchestrator.settings.get();
    return {
      openedProjectId: opened.project.id,
      projectStatePersisted: savedState?.state?.requirements?.[0]?.text === "Persist locally",
      settingsPersisted: savedSettings.profile.displayName === "Smoke tester",
      terminalApiExposed: "terminal" in window.orchestrator,
      twoTierApiExposed: "twoTier" in window.orchestrator,
    };
  }, projectName);
  if (
    !projectApiCheck.projectStatePersisted ||
    !projectApiCheck.settingsPersisted ||
    projectApiCheck.terminalApiExposed ||
    projectApiCheck.twoTierApiExposed
  ) {
    throw new Error(`Packaged persistence/security check failed: ${JSON.stringify(projectApiCheck)}`);
  }

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
    projectApiAvailable: Boolean(projectApiCheck.openedProjectId),
    visualProjectStatePersisted: projectApiCheck.projectStatePersisted,
    settingsPersisted: projectApiCheck.settingsPersisted,
    unsafeExecutionApisAbsent: true,
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
