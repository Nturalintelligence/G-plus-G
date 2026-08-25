import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve("release/win-unpacked/G plus G.exe");
const developmentMode = process.env.G_PLUS_G_DEV_SMOKE === "1";
const dataRoot = await mkdtemp(join(tmpdir(), "g-plus-g-composer-crash-"));
const firstBytes = new Uint8Array(await readFile(resolve("tests/fixtures/user-regression-screenshot.png")));
const secondBytes = new Uint8Array(await readFile(resolve("tests/fixtures/remove-controls-regression.png")));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
let app;

async function launch() {
  app = await electron.launch(developmentMode
    ? { args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot } }
    : { executablePath, env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return page;
}

try {
  let page = await launch();
  const projectName = `Crash draft ${Date.now()}`;
  const project = await page.evaluate((name) => window.orchestrator.projects.create(name, ["chatgpt", "gemini"], "Crash-safe draft smoke"), projectName);
  await page.reload();
  await page.getByText(projectName, { exact: true }).click();
  const initial = await page.evaluate(async ({ projectId, first, second }) => {
    const draft = await window.orchestrator.attachments.listDraft(projectId);
    const messageId = draft?.messageId ?? `msg_crash_${Date.now()}`;
    const firstRef = await window.orchestrator.attachments.stageClipboard(projectId, messageId, new Uint8Array(first), "image/png", "Первый полноэкранный снимок.png");
    const secondRef = await window.orchestrator.attachments.stageClipboard(projectId, messageId, new Uint8Array(second), "image/png", "Второй Unicode снимок.png");
    return { messageId, firstId: firstRef.id, secondId: secondRef.id };
  }, { projectId: project.id, first: [...firstBytes], second: [...secondBytes] });

  await page.evaluate((projectId) => window.orchestrator.composerDraft.clear(projectId), project.id);
  await page.reload();
  await page.getByText(projectName, { exact: true }).click();
  await page.locator(".composer-bottom .attachment-card").nth(1).waitFor();
  await page.waitForFunction(async ({ projectId, messageId }) => {
    const saved = await window.orchestrator.composerDraft.get(projectId);
    return saved?.messageId === messageId && saved.attachmentIds.length === 2;
  }, { projectId: project.id, messageId: initial.messageId });
  await page.evaluate(async ({ projectId, initial }) => {
    await window.orchestrator.composerDraft.save({
      projectId,
      text: "Первоначальный crash-safe текст",
      messageId: initial.messageId,
      attachmentIds: [initial.secondId, initial.firstId],
      mode: "PARALLEL",
      continuationPolicy: "approval",
      starter: "gemini",
      providers: ["gemini", "chatgpt"],
      viewMode: "LIVE",
      finalizerMode: "PEER_AGREEMENT",
      finalResponder: "gemini",
      composerExpanded: true,
    });
  }, { projectId: project.id, initial });
  await page.reload();
  await page.getByText(projectName, { exact: true }).click();
  const textarea = page.getByLabel("Сообщение для моделей");
  await textarea.waitFor();
  await page.waitForFunction(
    (expected) => document.querySelector('textarea[aria-label="Сообщение для моделей"]')?.value === expected,
    "Первоначальный crash-safe текст",
  );
  assert(await textarea.inputValue() === "Первоначальный crash-safe текст", "Configured draft did not hydrate before crash scenario");
  await textarea.fill("Текст, сохранённый renderer debounce перед аварийным завершением");
  let beforeCrash;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    beforeCrash = await page.evaluate((projectId) => window.orchestrator.composerDraft.get(projectId), project.id);
    if (beforeCrash?.text.includes("renderer debounce")) break;
    await page.waitForTimeout(100);
  }
  assert(beforeCrash?.text.includes("renderer debounce"), `Renderer debounce did not persist text before crash: ${JSON.stringify({ beforeCrash, textarea: await textarea.inputValue(), status: await page.locator(".status").allTextContents().catch(() => []) })}`);
  assert(JSON.stringify(beforeCrash.attachmentIds) === JSON.stringify([initial.secondId, initial.firstId]), "Attachment order changed before crash");

  app.process().kill();
  await app.close().catch(() => undefined); app = undefined;

  page = await launch();
  await page.getByText(projectName, { exact: true }).click();
  const restoredTextarea = page.getByLabel("Сообщение для моделей");
  await restoredTextarea.waitFor();
  await page.waitForFunction((expected) => document.querySelector('textarea[aria-label="Сообщение для моделей"]')?.value === expected, beforeCrash.text);
  const restored = await page.evaluate((projectId) => window.orchestrator.composerDraft.get(projectId), project.id);
  assert(await restoredTextarea.inputValue() === beforeCrash.text, `Draft text was not restored after process kill: ${JSON.stringify({ beforeCrash, restored, textarea: await restoredTextarea.inputValue() })}`);
  assert(restored?.messageId === initial.messageId, "Draft message id changed after crash");
  assert(JSON.stringify(restored.attachmentIds) === JSON.stringify([initial.secondId, initial.firstId]), "Attachment order was not restored after crash");
  assert(restored.mode === "PARALLEL" && restored.continuationPolicy === "approval" && restored.starter === "gemini", "Discussion settings were not restored");
  assert(JSON.stringify(restored.providers) === JSON.stringify(["gemini", "chatgpt"]), "Participants were not restored");
  assert(restored.viewMode === "LIVE" && restored.finalizerMode === "PEER_AGREEMENT" && restored.finalResponder === "gemini" && restored.composerExpanded, "Final-answer settings were not restored");
  const titles = await page.locator(".composer-bottom .attachment-card").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title")));
  assert(titles[0]?.startsWith("Второй Unicode снимок.png") && titles[1]?.startsWith("Первый полноэкранный снимок.png"), `Renderer attachment order is wrong: ${JSON.stringify(titles)}`);

  await app.close(); app = undefined;
  const database = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const runs = database.prepare("SELECT COUNT(*) AS count FROM orchestration_runs WHERE project_id = ?").get(project.id).count;
  const submissions = database.prepare("SELECT COUNT(*) AS count FROM provider_submissions WHERE message_id = ?").get(initial.messageId).count;
  database.close();
  assert(runs === 0 && submissions === 0, `Draft recovery triggered work: ${JSON.stringify({ runs, submissions })}`);
  console.log(JSON.stringify({ ok: true, projectId: project.id, attachmentOrder: restored.attachmentIds, debounceRecovered: true, automaticRuns: runs, automaticSubmissions: submissions }, null, 2));
} finally {
  await app?.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined);
}
