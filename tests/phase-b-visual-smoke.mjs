import { _electron as electron } from "playwright";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve("release/win-unpacked/G plus G.exe");
const outputDir = resolve("output/playwright");
const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-phase-b-"));
await mkdir(outputDir, { recursive: true });
let application;

try {
  application = await electron.launch({ executablePath, env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot } });
  const page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const projectName = `Phase B visual ${Date.now()}`;
  await page.getByRole("button", { name: "Новый" }).click();
  await page.getByPlaceholder("Например: Мой Салон Красоты").fill(projectName);
  await page.getByRole("button", { name: "Создать проект" }).click();
  await page.getByText(projectName, { exact: true }).waitFor();

  const dto = await page.evaluate(async (name) => {
    const project = (await window.orchestrator.projects.list()).find((item) => item.name === name);
    if (!project) throw new Error("Visual smoke project not found");
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (char) => char.charCodeAt(0));
    return window.orchestrator.attachments.stageClipboard(project.id, "draft-visual", png, "image/png", "pixel.png");
  }, projectName);
  if ("localRelativePath" in dto || "sha256" in dto || "providerMetadata" in dto) {
    throw new Error(`Unsafe renderer DTO: ${JSON.stringify(dto)}`);
  }
  const previewProbe = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { ok: response.ok, status: response.status, contentType: response.headers.get("content-type"), bytes: (await response.arrayBuffer()).byteLength };
  }, dto.previewUrl);
  if (!previewProbe.ok || previewProbe.contentType !== "image/png" || previewProbe.bytes === 0) {
    throw new Error(`Attachment preview protocol failed: ${JSON.stringify(previewProbe)}`);
  }

  for (const theme of ["light", "dark"]) {
    await page.evaluate(async (value) => {
      const settings = await window.orchestrator.settings.get();
      await window.orchestrator.settings.save({ ...settings, appearance: { ...settings.appearance, theme: value } });
    }, theme);
    await page.reload();
    await page.getByText(projectName, { exact: true }).click();
    await page.getByText("pixel.png", { exact: true }).waitFor();
    const composer = page.getByLabel("Сообщение для моделей");
    await composer.fill("Обычная вставка текста работает");
    if (await composer.inputValue() !== "Обычная вставка текста работает") throw new Error("Composer text input failed");
    await page.screenshot({ path: join(outputDir, `phase-b-${theme}.png`), fullPage: true });
  }

  console.log(JSON.stringify({ ok: true, dto, previewProbe, screenshots: ["phase-b-light.png", "phase-b-dark.png"] }, null, 2));
} finally {
  await application?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
