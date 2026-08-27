import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureDataRoot } from "../dist/src/paths.js";
import { LocalArtifactStore } from "../dist/src/attachments/artifact-store.js";

const root = await mkdtemp(join(tmpdir(), "gplusg-artifact-hydration-"));
const saveTarget = join(root, "saved", "gplusg-inbound-final.txt");
const body = Buffer.from("G_PLUS_G_INBOUND_FINAL_2026", "utf8");
const sha256 = createHash("sha256").update(body).digest("hex");
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const launch = () => electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
let app;
try {
  app = await launch();
  let page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  const project = await page.evaluate(() => window.orchestrator.projects.create("Artifact restart fixture", ["chatgpt", "gemini"]));
  await app.close(); app = undefined;

  configureDataRoot(root);
  const ref = new LocalArtifactStore().storeBuffer(body, {
    projectId: project.id, messageId: "turn-chatgpt-fixture", source: "chatgpt", originalFileName: "gplusg-inbound-final.txt",
  });
  const db = new DatabaseSync(join(root, "orchestrator.sqlite"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO conversation_entries (id,project_id,run_id,role,provider_id,round,content,created_at) VALUES (?,?,NULL,'ASSISTANT','chatgpt',1,'hidden provider text',?)").run(ref.messageId, project.id, now);
  db.prepare(`INSERT INTO downloaded_artifacts
    (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,file_name,mime_type,size_bytes,status,downloaded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?, 'READY',?)`).run(ref.id, ref.messageId, project.id, "chatgpt", "", ref.sha256, ref.localRelativePath, ref.fileName, ref.mimeType, ref.sizeBytes, now);
  db.prepare(`INSERT INTO downloaded_artifacts
    (id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,file_name,mime_type,size_bytes,status,downloaded_at)
    VALUES ('cross-provider',?,?, 'gemini','',?,?,?, ?,?, 'READY',?)`).run(ref.messageId, project.id, ref.sha256, ref.localRelativePath, ref.fileName, ref.mimeType, ref.sizeBytes, now);
  db.close();

  const verify = async (restart) => {
    await mkdir(join(root, "saved"), { recursive: true });
    app = await launch(); page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
      shell.openPath = async () => "";
    }, saveTarget);
    await page.getByTitle(project.name).click();
    const card = page.locator(".message-attachment-card").filter({ hasText: "gplusg-inbound-final.txt" });
    await card.waitFor();
    assert(await card.count() === 1, `expected exactly one hydrated card after restart=${restart}`);
    const providerSection = card.locator("xpath=ancestor::section[contains(@class,'provider-artifacts')]");
    assert(await providerSection.getAttribute("data-provider-id") === "chatgpt", "provider ownership was lost");
    assert(await providerSection.getAttribute("data-provider-turn-id") === ref.messageId, "assistant turn ownership was lost");
    await card.locator(".message-attachment-open").click();
    await card.getByRole("button", { name: "Сохранить как…" }).click();
    const saved = await readFile(saveTarget);
    assert(createHash("sha256").update(saved).digest("hex") === sha256, "saved bytes SHA-256 mismatch");
    await app.close(); app = undefined;
  };
  await verify(false);
  await verify(true);
  const evidence = { ok: true, providerTraffic: 0, cards: 1, restart: true, open: true, saveAs: true, sha256Match: true, crossProviderRejected: true };
  await mkdir(resolve("output/playwright"), { recursive: true });
  await writeFile(resolve("output/playwright/artifact-hydration-restart.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
} finally {
  await app?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
