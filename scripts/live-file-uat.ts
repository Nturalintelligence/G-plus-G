import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAdapter, parseProvider } from "../src/adapters/adapter-registry.js";
import type { AttachmentRefV1 } from "../src/attachments/attachments.js";
import { AttachmentStagingService } from "../src/attachments/attachment-staging.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { configureDataRoot, dataPath } from "../src/paths.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";
import { writeDiagnostic } from "../src/observability/logger.js";

const provider = parseProvider(process.argv[2]);
const receiveOnly = process.argv[3] === "receive";
const imageOnly = process.argv[3] === "image";
const existingProjectId = process.argv[4];
const root = process.env.G_PLUS_G_USER_DATA;
if (!root) throw new Error("G_PLUS_G_USER_DATA must point to the authenticated desktop profile");
configureDataRoot(root);

const database = new AppDatabase(dataPath("orchestrator.sqlite"));
database.migrate();
const repository = new ProjectRepository(database);
const project = receiveOnly
  ? repository.openProject(existingProjectId ?? "")
  : repository.createProject(`File UAT ${provider} ${new Date().toISOString()}`, [provider], "Minimal live attachment and response-file UAT");
if (!project) throw new Error("Existing File UAT project not found");
const messageId = `msg_file_uat_${Date.now()}`;
const staging = new AttachmentStagingService(database.raw);
const png = receiveOnly || imageOnly ? null : staging.stageBytes(
  readFileSync(resolve("tests/fixtures/remove-controls-regression.png")),
  { projectId: project.id, messageId },
  "gplusg-uat.png",
);
const markdown = receiveOnly || imageOnly ? null : staging.stageBytes(
  Buffer.from("G_PLUS_G_FILE_UAT_CONTENT_2026\n", "utf8"),
  { projectId: project.id, messageId },
  "gplusg-uat.md",
);

function attachment(id: string): AttachmentRefV1 {
  const row = database.raw.prepare("SELECT * FROM message_attachments WHERE id = ?").get(id) as Record<string, unknown>;
  return {
    id: String(row.id), messageId: String(row.message_id), projectId: String(row.project_id),
    kind: row.kind as AttachmentRefV1["kind"], fileName: String(row.file_name),
    mimeType: String(row.mime_type), sizeBytes: Number(row.size_bytes), sha256: String(row.sha256),
    localRelativePath: String(row.local_relative_path), source: "user", status: row.status as AttachmentRefV1["status"],
  };
}

const attachments = png && markdown ? [attachment(png.id), attachment(markdown.id)] : undefined;
const adapter = createAdapter(provider, 180_000, true, database.raw);
try {
  await adapter.launch();
  const output = await new Orchestrator(database, new Map([[provider, adapter]])).run(
    project.id,
    "MANUAL",
    imageOnly
      ? "Создай одно небольшое оригинальное изображение: оранжевый круг на белом фоне. Верни именно созданное изображение с доступным скачиванием, без поиска в интернете и без дополнительных вариантов."
      : receiveOnly
      ? "Используй доступный инструмент создания файлов. Создай реальный скачиваемый текстовый файл gplusg-provider-result.txt, содержащий ровно строку G_PLUS_G_PROVIDER_FILE_RESULT_2026, и приложи файл к ответу. Не показывай вместо файла блок кода."
      : "Прочитай оба прикреплённых файла. Создай и приложи к ответу небольшой Markdown-файл gplusg-provider-result.md с одной строкой G_PLUS_G_PROVIDER_FILE_RESULT_2026. В тексте кратко подтверди имена обоих входных файлов.",
    [provider],
    {
      ...(!receiveOnly ? { userMessageId: messageId, attachments } : {}),
      // The shared limits schema requires one retry slot, while the
      // attachment path fails closed before retrying any unknown submission.
      limits: { maxTurns: 1, maxTurnMs: 180_000, maxSessionMs: 240_000, maxRetries: 1, confirmationEvery: 1 },
    },
  );
  const submission = receiveOnly ? null : database.raw.prepare("SELECT state FROM provider_submissions WHERE message_id = ? AND provider_id = ?").get(messageId, provider);
  const deliveries = attachments
    ? database.raw.prepare(`SELECT status FROM attachment_deliveries WHERE provider_id = ? AND attachment_id IN (${attachments.map(() => "?").join(",")}) ORDER BY id`).all(provider, ...attachments.map((item) => item.id))
    : [];
  const artifacts = database.raw.prepare("SELECT id, message_id, file_name, mime_type, size_bytes, sha256, status FROM downloaded_artifacts WHERE project_id = ? AND provider_id = ?").all(project.id, provider);
  console.log(JSON.stringify({
    ok: output.status === "COMPLETED" && (receiveOnly || submission?.state === "CONFIRMED"),
    provider,
    projectId: project.id,
    submittedMessages: 1,
    mode: imageOnly ? "image" : receiveOnly ? "receive" : "send",
    submissionState: submission?.state ?? null,
    deliveryStates: deliveries.map((row) => row.status),
    responseArtifacts: artifacts,
  }, null, 2));
} catch (error) {
  const diagnostic = await writeDiagnostic(error, {
    operation: "live-file-uat",
    provider,
    projectId: project.id,
    providerDiagnostics: await adapter.collectDiagnostics().catch(() => ({})),
  });
  console.error(`Диагностика: ${diagnostic}`);
  throw error;
} finally {
  await adapter.close().catch(() => undefined);
  database.close();
}
