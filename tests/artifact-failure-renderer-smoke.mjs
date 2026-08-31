import { _electron as electron } from "playwright";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "gplusg-artifact-failure-"));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const launch = () => electron.launch({ args: ["."], cwd: resolve("."), env: { ...process.env, G_PLUS_G_USER_DATA: dataRoot, G_PLUS_G_SKIP_PROVIDER_STATUS: "1" } });
let app;
try {
  app = await launch();
  let page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  const project = await page.evaluate(() => window.orchestrator.projects.create("Fixture failed artifact", ["gemini"]));
  await app.close(); app = undefined;

  const database = new DatabaseSync(join(dataRoot, "orchestrator.sqlite"));
  const now = new Date().toISOString();
  database.prepare("INSERT INTO conversation_entries (id, project_id, run_id, role, provider_id, round, content, created_at) VALUES (?, ?, NULL, 'ASSISTANT', 'gemini', 1, ?, ?)").run("entry-failed-artifact", project.id, "Ответ с недоступным файлом", now);
  database.prepare("INSERT INTO downloaded_artifacts (id, message_id, project_id, provider_id, original_url, sha256, local_relative_path, file_name, mime_type, size_bytes, status, downloaded_at, failure_reason, failure_detail) VALUES (?, ?, ?, 'gemini', '', '', '', '', 'application/octet-stream', 0, 'FAILED', ?, 'EMPTY_RESPONSE_BODY', 'Provider returned an empty response body')").run("dl-failed-artifact", "entry-failed-artifact", project.id, now);
  database.close();

  app = await launch(); page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded");
  const details = await page.evaluate((projectId) => window.orchestrator.projects.open(projectId), project.id);
  assert(details.transcript.some((entry) => entry.id === "entry-failed-artifact" && entry.attachments?.some((item) => item.status === "FAILED")), "failed artifact missing from project IPC: " + JSON.stringify(details.transcript));
  await page.getByTitle(project.name).click();
  const card = page.locator(".message-attachment-card").filter({ hasText: "Не удалось получить файл" });
  await card.waitFor();
  assert(await card.getByRole("status").count() === 1, "failed artifact is not rendered as a status");
  assert(await card.locator(".message-attachment-open button, button:has-text('Сохранить как')").count() === 0, "failed artifact still exposes an open/save action");
  assert(await card.getByRole("button", { name: "Повторно проверить provider" }).count() === 1, "safe local recheck action is missing");
  assert(await card.getByRole("button", { name: "Создать файл из ответа" }).count() === 1, "derived artifact action is missing");
  assert(await card.getByText(/Файл не получен: EMPTY_RESPONSE_BODY/).count() === 1, "typed safe failure explanation is not visible");
  console.log(JSON.stringify({ ok: true, providerTraffic: 0, failureReason: "EMPTY_RESPONSE_BODY", openActions: 0, recheckActions: 1 }));
} finally { await app?.close().catch(() => undefined); await rm(dataRoot, { recursive: true, force: true }).catch(() => undefined); }
