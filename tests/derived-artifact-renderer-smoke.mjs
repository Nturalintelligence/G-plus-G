import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureDataRoot } from "../dist/src/paths.js";
import { DerivedArtifactService } from "../dist/src/attachments/derived-artifact.js";

const root = await mkdtemp(join(tmpdir(), "gplusg-derived-renderer-"));
const target = join(root, "saved", "gplusg-inbound-final.txt");
const expectedSha = "8e2f74f110636e05fb49232d1435d280aae71b94b63156b2ea536676e007a21d";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const launch = () => electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: root, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
let app;
try {
  app = await launch(); let page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  const project = await page.evaluate(() => window.orchestrator.projects.create("Derived artifact fixture", ["gemini"]));
  await app.close(); app = undefined;
  configureDataRoot(root);
  const db = new DatabaseSync(join(root, "orchestrator.sqlite"));
  const now = new Date().toISOString();
  db.prepare("INSERT INTO conversation_entries(id,project_id,role,provider_id,round,content,created_at) VALUES ('task-derived',?,'USER','gemini',1,?,?)")
    .run(project.id, "Создай файл gplusg-inbound-final.txt, содержащий ровно строку G_PLUS_G_INBOUND_FINAL_2026", now);
  db.prepare("INSERT INTO conversation_entries(id,project_id,role,provider_id,round,content,created_at) VALUES ('turn-derived',?,'ASSISTANT','gemini',1,?,?)")
    .run(project.id, "```text\nG_PLUS_G_INBOUND_FINAL_2026\n```", new Date(Date.parse(now) + 1).toISOString());
  db.prepare(`INSERT INTO downloaded_artifacts(id,message_id,project_id,provider_id,original_url,sha256,local_relative_path,status,downloaded_at,file_name,mime_type,size_bytes)
    VALUES ('failed-derived','turn-derived',?,'gemini','','','','FAILED',?,'','application/octet-stream',0)`).run(project.id, now);
  const service = new DerivedArtifactService(db);
  const prepared = service.prepare("failed-derived");
  if (prepared.status !== "READY") throw new Error(prepared.reason);
  service.create(prepared.proposal, "ASK", true);
  db.close();

  const verify = async () => {
    await mkdir(join(root, "saved"), { recursive: true });
    app = await launch(); page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
    await app.evaluate(({ dialog, shell }, saveTarget) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTarget }); shell.openPath = async () => ""; }, target);
    await page.getByTitle(project.name).click();
    const card = page.locator(".message-attachment-card").filter({ hasText: "gplusg-inbound-final.txt" });
    await card.waitFor();
    assert(await card.getByText("Derived", { exact: true }).count() === 1, "Derived badge missing");
    assert(await card.getByText("Создано G+G из ответа Gemini", { exact: false }).count() === 1, "Derived provenance label missing");
    await card.locator(".message-attachment-open").click();
    await card.getByRole("button", { name: "Сохранить как…" }).click();
    assert(createHash("sha256").update(await readFile(target)).digest("hex") === expectedSha, "Save As SHA mismatch");
    await app.close(); app = undefined;
  };
  await verify(); await verify();
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, provenance: "GPLUSG_DERIVED_FROM_PROVIDER_RESPONSE", card: true, open: true, saveAs: true, restart: true, dedup: true }));
} finally { await app?.close().catch(() => undefined); await rm(root, { recursive: true, force: true }).catch(() => undefined); }
