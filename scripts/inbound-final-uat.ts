import crypto from "node:crypto";
import { createAdapter, parseProvider } from "../src/adapters/adapter-registry.js";
import { LocalArtifactStore } from "../src/attachments/artifact-store.js";
import { writeDiagnostic } from "../src/observability/logger.js";
import { configureDataRoot, dataPath } from "../src/paths.js";
import { AppDatabase } from "../src/storage/database.js";
import { ProjectRepository } from "../src/storage/repository.js";
import { installSurfaceObserver, readSurfaceObserver, type SurfaceObserverDto } from "../src/uat/browser-surface-observer.js";
import { runAfterObserverPreflight, runSurfaceObserverPreflight } from "../src/uat/observer-preflight.js";

const provider = parseProvider(process.argv[2]);
if (provider !== "gemini") throw new Error("This final UAT harness is restricted to Gemini");
const root = process.env.G_PLUS_G_USER_DATA;
if (!root) throw new Error("G_PLUS_G_USER_DATA is required");
const prompt = "Создай настоящий скачиваемый текстовый файл gplusg-inbound-final.txt, содержащий ровно строку G_PLUS_G_INBOUND_FINAL_2026, и приложи его к ответу. Не заменяй файл блоком кода или обычным текстом.";
const expected = "G_PLUS_G_INBOUND_FINAL_2026";

const result = await runAfterObserverPreflight(runSurfaceObserverPreflight, async () => {
  configureDataRoot(root);
  const database = new AppDatabase(dataPath("orchestrator.sqlite"));
  database.migrate();
  const repository = new ProjectRepository(database);
  const project = repository.createProject(`Inbound Final UAT ${provider} ${new Date().toISOString()}`, [provider], "One-message final inbound artifact UAT");
  const conversation = repository.createConversation(project.id, provider);
  const userEntryId = `entry_uat_user_${crypto.randomUUID()}`;
  const assistantEntryId = `entry_uat_assistant_${crypto.randomUUID()}`;
  repository.appendConversationEntry({ id: userEntryId, projectId: project.id, role: "USER", providerId: provider, round: 1, content: prompt });
  const adapter = createAdapter(provider, 180_000, true, database.raw);
  let submitted = false;
  const eventTypes: string[] = [];
  const captureChannels = new Set<string>();
  let surfaceEvidence: SurfaceObserverDto | null = null;
  let observedPage: any = null;
  const observers: Array<[string, (...args: any[]) => void]> = [];
  try {
    await adapter.launch();
    observedPage = (adapter as any).page;
    if (!observedPage) throw new Error("Gemini page unavailable after launch");
    await installSurfaceObserver(observedPage);
    const onDownload = () => captureChannels.add("download event");
    const onPopup = () => captureChannels.add("popup/navigation");
    const onFrame = (frame: any) => { if (frame === observedPage.mainFrame?.()) captureChannels.add("popup/navigation"); };
    const onResponse = (response: any) => {
      const headers = response.headers?.() || {};
      const mime = String(headers["content-type"] || "").split(";", 1)[0].toLowerCase();
      const disposition = String(headers["content-disposition"] || "");
      if (/attachment/i.test(disposition) || ["text/plain", "text/markdown", "application/octet-stream"].includes(mime)) {
        captureChannels.add(response.fromServiceWorker?.() ? "service-worker response" : "network response");
      }
    };
    observers.push(["download", onDownload], ["popup", onPopup], ["framenavigated", onFrame], ["response", onResponse]);
    for (const [event, listener] of observers) observedPage.on(event, listener);

    const remote = await adapter.createConversation();
    repository.updateConversationExternalRef(conversation.id, remote.url);
    const turn = await adapter.sendMessage({ content: prompt, responseArtifactTarget: { projectId: project.id, messageId: assistantEntryId } });
    const eventsPromise = (async () => {
      for await (const event of adapter.observeTurn(turn)) {
        eventTypes.push(event.type);
        if (event.type === "MESSAGE_SUBMITTED") submitted = true;
      }
    })();
    const response = await adapter.getFinalResponse(turn);
    await eventsPromise;
    const current = await adapter.getCurrentConversation().catch(() => null);
    if (current?.url) repository.updateConversationExternalRef(conversation.id, current.url);
    repository.appendConversationEntry({ id: assistantEntryId, projectId: project.id, role: "ASSISTANT", providerId: provider, round: 1, content: response.response });
    surfaceEvidence = await readSurfaceObserver(observedPage);
    const rows = database.raw.prepare("SELECT id, file_name, mime_type, size_bytes, sha256, local_relative_path, status, failure_reason, failure_detail, physical_click_count FROM downloaded_artifacts WHERE project_id = ? AND provider_id = ? ORDER BY downloaded_at").all(project.id, provider) as Array<Record<string, unknown>>;
    const ready = rows.find((row) => row.status === "READY");
    let contentMatch = false;
    if (ready) {
      const bytes = new LocalArtifactStore().readBuffer(String(ready.local_relative_path));
      contentMatch = bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\r?\n$/, "") === expected;
    }
    return {
      preflight: "PASS",
      provider,
      projectId: project.id,
      assistantEntryId,
      submittedMessages: submitted ? 1 : 0,
      submissionState: submitted ? "CONFIRMED" : "UNKNOWN",
      eventTypes,
      captureChannels: [...captureChannels],
      surfaceEvidence,
      artifacts: rows.map((row) => ({
        id: row.id, fileName: row.file_name, mimeType: row.mime_type, sizeBytes: row.size_bytes,
        sha256: row.sha256, status: row.status, failureReason: row.failure_reason,
        failureDetail: row.failure_detail, physicalClickCount: row.physical_click_count,
      })),
      contentMatch,
    };
  } catch (error) {
    const diagnostic = await writeDiagnostic(error, {
      operation: "inbound-final-uat",
      provider,
      projectId: project.id,
      providerDiagnostics: await adapter.collectDiagnostics().catch(() => ({})),
      surfaceEvidence: await readSurfaceObserver(observedPage).catch(() => null),
    });
    console.error(`Диагностика: ${diagnostic}`);
    throw error;
  } finally {
    if (observedPage) for (const [event, listener] of observers) observedPage.off(event, listener);
    await adapter.close().catch(() => undefined);
    database.close();
  }
});

console.log(JSON.stringify(result, null, 2));
