import fs from "node:fs";
import path, { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { createAdapter, parseProvider } from "../../src/adapters/adapter-registry.js";
import { SpecExporter } from "../../src/artifacts/spec-exporter.js";
import {
  Orchestrator,
  type FinalizerMode,
  type RunMode,
} from "../../src/orchestrator/orchestrator.js";
import { ProjectStateService, type ProjectState } from "../../src/project-state.js";
import { AppDatabase } from "../../src/storage/database.js";
import { ProjectRepository } from "../../src/storage/repository.js";
import { CliExecutionService } from "../../src/cli-executors/cli-execution-service.js";
import type { AttachmentRefV1 } from "../../src/attachments/attachments.js";
import type { ModelAdapter } from "../../src/adapters/adapter-contract.js";
import { configureDataRoot, dataPath } from "../../src/paths.js";
import {
  logEvent,
  writeDiagnostic,
} from "../../src/observability/logger.js";
import { SettingsStore, type ProviderId, PROVIDER_METADATA } from "../../src/settings/settings.js";
import {
  validateLimits,
  type OrchestrationLimits,
} from "../../src/orchestrator/limits.js";
import {
  createBackupBundle,
  getReleaseInfo,
  runPreflight,
} from "../../src/release/release-tools.js";
import { resetProviderSession } from "../../src/maintenance.js";
import { QualityMetrics } from "../../src/observability/metrics.js";
import { globalEventBus } from "../../src/events/event-bus.js";
import { TaskFsmRepository } from "../../src/storage/task-fsm-repository.js";
import { ThreeTierMemoryManager } from "../../src/context/three-tier-memory.js";
import { ContextRolloverManager } from "../../src/context/context-rollover.js";
import { PromptRegistry } from "../../src/orchestrator/prompt-registry.js";
import { LocalArtifactStore } from "../../src/attachments/artifact-store.js";
import {
  AttachmentStagingService,
  toRendererAttachment,
  type RendererAttachmentDto,
} from "../../src/attachments/attachment-staging.js";
import { AttachmentDraftLifecycle } from "../../src/attachments/attachment-draft-lifecycle.js";
import { ComposerDraftRepository, type ComposerDraftInput } from "../../src/composer-draft.js";
import { ProjectTrashService } from "../../src/project-trash.js";

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activeOrchestrationAdapters: Map<string, ModelAdapter> | null = null;
const activeLoginAdapters = new Map<string, ModelAdapter>();
let activeInteractiveLogin: { provider: string; promise: Promise<any> } | null = null;
let providerOperationActive = false;
let quitAfterCleanup = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: "attachment-preview",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

let cliService: CliExecutionService | null = null;

function getCliService(): CliExecutionService {
  if (!cliService) {
    const workspaceRoot = dataPath("cli-workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    cliService = new CliExecutionService(db().raw, {
      workspaceRoot,
    });
  }
  return cliService;
}

function db(): AppDatabase {
  if (!database) throw new Error("Database is not initialized");
  return database;
}

function assertProjectExists(projectId: string): void {
  const row = db().raw.prepare("SELECT 1 AS found FROM projects WHERE id = ?").get(projectId);
  if (!row) throw new Error(`Project not found: ${projectId}`);
}

function attachmentRefFromRow(row: Record<string, unknown>): AttachmentRefV1 {
  const quarantineReason = row.quarantine_reason
    ? String(row.quarantine_reason) as AttachmentRefV1["quarantineReason"]
    : undefined;
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    projectId: String(row.project_id),
    kind: row.kind as AttachmentRefV1["kind"],
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    localRelativePath: String(row.local_relative_path),
    source: row.source as AttachmentRefV1["source"],
    status: row.status as AttachmentRefV1["status"],
    ...(quarantineReason ? { quarantineReason } : {}),
  };
}

function findAttachmentRef(attachmentId: string): AttachmentRefV1 | null {
  const row = db().raw.prepare("SELECT * FROM message_attachments WHERE id = ?").get(attachmentId) as Record<string, unknown> | undefined;
  if (row) return attachmentRefFromRow(row);
  const downloaded = db().raw.prepare("SELECT * FROM downloaded_artifacts WHERE id = ?").get(attachmentId) as Record<string, unknown> | undefined;
  return downloaded ? downloadedArtifactRefFromRow(downloaded) : null;
}

function downloadedArtifactRefFromRow(row: Record<string, unknown>): AttachmentRefV1 {
  const status = String(row.status);
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    projectId: String(row.project_id),
    kind: String(row.mime_type).startsWith("image/") ? "image" : "document",
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes),
    sha256: String(row.sha256),
    localRelativePath: String(row.local_relative_path),
    source: String(row.provider_id) as AttachmentRefV1["source"],
    status: status === "READY" ? "READY" : status === "QUARANTINED" ? "QUARANTINED" : "FAILED",
    ...(status === "QUARANTINED" ? { quarantineReason: "MIME_MISMATCH" as const } : {}),
  };
}

function attachmentDtoFromRow(row: Record<string, unknown>): RendererAttachmentDto {
  const dto = toRendererAttachment(attachmentRefFromRow(row));
  const lastError = row.last_error ? String(row.last_error) : undefined;
  return lastError ? { ...dto, error: lastError } : dto;
}

function attachmentViewsForProject(projectId: string): {
  transcriptAttachments: Record<string, RendererAttachmentDto[]>;
  draft: { messageId: string; attachments: RendererAttachmentDto[] } | null;
} {
  const rows = db().raw.prepare(`
    SELECT ma.*,
      CASE WHEN ce.id IS NULL THEN 1 ELSE 0 END AS is_draft
    FROM message_attachments ma
    LEFT JOIN conversation_entries ce ON ce.id = ma.message_id
    WHERE ma.project_id = ?
    ORDER BY ma.created_at, ma.rowid
  `).all(projectId) as Array<Record<string, unknown>>;
  const transcriptAttachments: Record<string, RendererAttachmentDto[]> = {};
  const draftRows = rows.filter((row) => Number(row.is_draft) === 1);
  const activeDraftId = draftRows.at(-1)?.message_id ? String(draftRows.at(-1)!.message_id) : null;
  for (const row of rows) {
    const messageId = String(row.message_id);
    if (Number(row.is_draft) === 0) {
      (transcriptAttachments[messageId] ??= []).push(attachmentDtoFromRow(row));
    }
  }
  const downloadedRows = db().raw.prepare(`
    SELECT * FROM downloaded_artifacts
    WHERE project_id = ?
    ORDER BY downloaded_at, rowid
  `).all(projectId) as Array<Record<string, unknown>>;
  for (const row of downloadedRows) {
    const ref = downloadedArtifactRefFromRow(row);
    (transcriptAttachments[ref.messageId] ??= []).push(toRendererAttachment(ref));
  }
  return {
    transcriptAttachments,
    draft: activeDraftId
      ? { messageId: activeDraftId, attachments: draftRows.filter((row) => String(row.message_id) === activeDraftId).map(attachmentDtoFromRow) }
      : null,
  };
}

async function closeActiveAdapters(): Promise<void> {
  if (activeOrchestrationAdapters) {
    const adapters = activeOrchestrationAdapters;
    activeOrchestrationAdapters = null;
    await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()));
  }
  for (const adapter of activeLoginAdapters.values()) {
    await adapter.close().catch(() => undefined);
  }
  activeLoginAdapters.clear();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    autoHideMenuBar: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#151516",
      symbolColor: "#F7F6F2",
      height: 56,
    },
    backgroundColor: "#0d1117",
    icon: join(app.getAppPath(), "build", "icon.png"),
    webPreferences: {
      preload: join(app.getAppPath(), "apps/desktop/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  const openExternal = (url: string): void => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        void shell.openExternal(parsed.toString());
      }
    } catch {
      logEvent("WARN", "renderer.external_link.rejected", { url });
    }
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("app://bundle/")) return;
    event.preventDefault();
    openExternal(url);
  });
  mainWindow.webContents.on("will-redirect", (event, url) => {
    if (url.startsWith("app://bundle/")) return;
    event.preventDefault();
    openExternal(url);
  });
  void mainWindow
    .loadURL("app://bundle/index.html")
    .catch((error) => console.error("Failed to load desktop renderer", error));
}

globalEventBus.on("*", (event) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("bus:event", event);
  }
});

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? "";
  if (!url.startsWith("app://bundle/")) {
    logEvent("WARN", "ipc.untrusted_sender.rejected", { url });
    throw new Error("Untrusted IPC sender");
  }
}

function handle(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedRenderer(event);
    return listener(event, ...args);
  });
}

function requireString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const clean = value.trim();
  if (!allowEmpty && !clean) throw new Error(`${label} cannot be empty`);
  if (clean.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return clean;
}

function validateRunInput(value: unknown): {
  projectId: string;
  mode: RunMode;
  task: string;
  providers: ProviderId[];
  limits?: OrchestrationLimits | undefined;
  finalizerMode?: FinalizerMode | undefined;
  finalResponder?: string | undefined;
  attachments?: AttachmentRefV1[] | undefined;
  userMessageId?: string | undefined;
  promptCustomizations?: Record<string, { role?: string; customPrompt?: string }> | undefined;
} {
  if (!value || typeof value !== "object") throw new Error("Invalid run input");
  const input = value as Record<string, unknown>;
  const projectId = requireString(input.projectId, "projectId", 200);
  const task = requireString(input.task, "task", 100_000);
  const modes: RunMode[] = ["MANUAL", "SEQUENTIAL", "PARALLEL", "DEBATE"];
  if (typeof input.mode !== "string" || !modes.includes(input.mode as RunMode)) {
    throw new Error("Invalid orchestration mode");
  }
  if (
    !Array.isArray(input.providers) ||
    input.providers.length < 1 ||
    input.providers.length > 10
  ) {
    throw new Error("Select between one and ten providers");
  }
  const providers = [...new Set(input.providers)] as ProviderId[];
  if (
    providers.some(
      (provider) => !(provider in PROVIDER_METADATA),
    )
  ) {
    throw new Error("Invalid provider");
  }
  const limits =
    input.limits === undefined
      ? undefined
      : (input.limits as OrchestrationLimits);
  if (limits) validateLimits(limits);
  const finalizerModes: FinalizerMode[] = ["MANUAL", "LEAD_SELECTS", "PEER_AGREEMENT"];
  const finalizerMode = input.finalizerMode === undefined
    ? undefined
    : finalizerModes.includes(input.finalizerMode as FinalizerMode)
      ? input.finalizerMode as FinalizerMode
      : (() => { throw new Error("Invalid finalizer mode"); })();
  const finalResponder = input.finalResponder === undefined
    ? undefined
    : requireString(input.finalResponder, "finalResponder", 100);
  const userMessageId = input.userMessageId === undefined
    ? undefined
    : requireString(input.userMessageId, "userMessageId", 200);
  const promptCustomizations: Record<string, { role?: string; customPrompt?: string }> = {};
  if (input.promptCustomizations && typeof input.promptCustomizations === "object") {
    for (const provider of providers) {
      const customization = (input.promptCustomizations as Record<string, unknown>)[provider];
      if (!customization || typeof customization !== "object") continue;
      const values = customization as Record<string, unknown>;
      const role = typeof values.role === "string" ? values.role.trim().slice(0, 200) : "";
      const customPrompt = typeof values.customPrompt === "string"
        ? values.customPrompt.trim().slice(0, 10_000)
        : "";
      if (role || customPrompt) {
        promptCustomizations[provider] = {
          ...(role ? { role } : {}),
          ...(customPrompt ? { customPrompt } : {}),
        };
      }
    }
  }
  const attachments: AttachmentRefV1[] = [];
  if (Array.isArray(input.attachments)) {
    for (const attItem of input.attachments.slice(0, 10)) {
      const attId = typeof attItem === "string" ? attItem : (attItem as any)?.id;
      if (typeof attId === "string" && attId.trim().length > 0) {
        const row = db().raw.prepare("SELECT * FROM message_attachments WHERE id = ? AND project_id = ?").get(attId, projectId) as Record<string, unknown> | undefined;
        if (row) {
          const ref = attachmentRefFromRow(row);
          if (ref.status === "QUARANTINED" || ref.status === "FAILED") {
            throw new Error(`Attachment '${ref.fileName}' is not deliverable: ${ref.quarantineReason ?? ref.status}`);
          }
          new LocalArtifactStore().readVerifiedBuffer(ref);
          attachments.push(ref);
        }
      }
    }
  }

  return {
    projectId,
    mode: input.mode as RunMode,
    task,
    providers,
    limits: input.limits as OrchestrationLimits | undefined,
    ...(finalizerMode ? { finalizerMode } : {}),
    ...(finalResponder ? { finalResponder } : {}),
    attachments,
    ...(userMessageId ? { userMessageId } : {}),
    ...(Object.keys(promptCustomizations).length > 0 ? { promptCustomizations } : {}),
  };
}

function registerRendererProtocol(): void {
  const rendererRoot = resolve(app.getAppPath(), "dist/desktop");
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");
    const filePath = resolve(rendererRoot, relativePath || "index.html");
    if (filePath !== rendererRoot && !filePath.startsWith(`${rendererRoot}${sep}`)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });
  protocol.handle("attachment-preview", (request) => {
    try {
      const url = new URL(request.url);
      const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      if (url.hostname !== "local" || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
        return new Response("Forbidden", { status: 403 });
      }
      const ref = findAttachmentRef(id);
      if (!ref || ref.kind !== "image" || ref.status === "FAILED" || ref.status === "QUARANTINED") {
        return new Response("Not found", { status: 404 });
      }
      const bytes = new LocalArtifactStore().readVerifiedBuffer(ref);
      return new Response(new Uint8Array(bytes), {
        headers: { "Content-Type": ref.mimeType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

function registerIpc(): void {
  const settingsStore = new SettingsStore(dataPath("settings.json"));
  handle("system:preflight", () => runPreflight());
  handle("system:info", () => getReleaseInfo());
  handle("quality:dashboard", () => new QualityMetrics(db()).dashboard());
  handle("system:openDataFolder", async () => {
    const error = await shell.openPath(dataPath());
    if (error) throw new Error(error);
    return dataPath();
  });
  handle("maintenance:backup", async () => {
    if (providerOperationActive || activeOrchestrator || activeOrchestrationAdapters || activeLoginAdapters.size > 0 || activeInteractiveLogin !== null) {
      throw new Error("Cannot create a backup while a provider operation is active");
    }
    const destination = dataPath("backups");
    const path = await createBackupBundle({ destinationRoot: destination });
    logEvent("INFO", "maintenance.backup.created", { path });
    return path;
  });
  handle("maintenance:resetSession", async (_event, providerValue: unknown) => {
    if (providerOperationActive || activeOrchestrator || activeOrchestrationAdapters || activeLoginAdapters.size > 0 || activeInteractiveLogin !== null) {
      throw new Error("Cannot reset a session while a provider operation is active");
    }
    const provider = parseProvider(
      requireString(providerValue, "provider", 20),
    );
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      buttons: ["Сбросить сессию", "Отмена"],
      defaultId: 1,
      cancelId: 1,
      title: `Сброс сессии ${provider}`,
      message: `Удалить локальную браузерную сессию ${provider}?`,
      detail: "Проекты и история не удаляются. При следующем использовании потребуется войти снова.",
    });
    if (confirmation.response !== 0) return { reset: false, provider };
    const path = await resetProviderSession(provider);
    logEvent("INFO", "maintenance.session.reset", { provider });
    return { reset: true, provider, path };
  });
  handle("settings:get", () => settingsStore.load());
  handle("settings:save", (_event, value: unknown) => {
    const settings = settingsStore.save(value);
    logEvent("INFO", "settings.saved", {
      theme: settings.appearance.theme,
      density: settings.appearance.density,
    });
    return settings;
  });
  handle("system:copyText", (_event, textValue: unknown) => {
    if (typeof textValue !== "string") throw new Error("clipboard text must be a string");
    if (textValue.length > 2_000_000) throw new Error("clipboard text exceeds 2000000 characters");
    const text = textValue;
    try {
      clipboard.writeText(text);
      return { success: true };
    } catch (error) {
      logEvent("ERROR", "renderer.clipboard.write_failed", {
        textLength: text.length,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw new Error("Не удалось записать текст в системный буфер обмена");
    }
  });
  handle("composerDraft:get", (_event, projectIdValue: unknown) => {
    const projectId = requireString(projectIdValue, "projectId", 200);
    assertProjectExists(projectId);
    return new ComposerDraftRepository(db().raw).get(projectId);
  });
  handle("composerDraft:save", (_event, value: unknown) => {
    const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    const projectId = requireString(input.projectId, "projectId", 200);
    assertProjectExists(projectId);
    if (typeof input.text !== "string" || input.text.length > 100_000) throw new Error("Draft text is invalid");
    const messageId = requireString(input.messageId, "messageId", 200);
    const attachmentIds = Array.isArray(input.attachmentIds)
      ? [...new Set(input.attachmentIds.map((id) => requireString(id, "attachmentId", 200)))].slice(0, 100)
      : [];
    if (attachmentIds.length > 0) {
      const placeholders = attachmentIds.map(() => "?").join(",");
      const rows = db().raw.prepare(`SELECT id FROM message_attachments WHERE project_id = ? AND message_id = ? AND id IN (${placeholders})`).all(projectId, messageId, ...attachmentIds) as Array<{ id: string }>;
      const valid = new Set(rows.map((row) => row.id));
      if (attachmentIds.some((id) => !valid.has(id))) throw new Error("Draft contains an attachment outside its project/message");
    }
    const mode = requireString(input.mode, "mode", 20) as ComposerDraftInput["mode"];
    if (!["MANUAL", "SEQUENTIAL", "PARALLEL", "DEBATE"].includes(mode)) throw new Error("Invalid draft mode");
    const continuationPolicy = requireString(input.continuationPolicy, "continuationPolicy", 20) as ComposerDraftInput["continuationPolicy"];
    if (!["autonomous", "approval"].includes(continuationPolicy)) throw new Error("Invalid continuation policy");
    const providers = Array.isArray(input.providers)
      ? [...new Set(input.providers.map((provider) => parseProvider(requireString(provider, "provider", 100))))]
      : [];
    const starter = parseProvider(requireString(input.starter, "starter", 100));
    const viewMode = requireString(input.viewMode, "viewMode", 20) as ComposerDraftInput["viewMode"];
    if (!["SYNTHESIZED", "LIVE"].includes(viewMode)) throw new Error("Invalid draft view mode");
    const finalizerMode = requireString(input.finalizerMode, "finalizerMode", 30) as ComposerDraftInput["finalizerMode"];
    if (!["MANUAL", "LEAD_SELECTS", "PEER_AGREEMENT"].includes(finalizerMode)) throw new Error("Invalid finalizer mode");
    const finalResponder = requireString(input.finalResponder, "finalResponder", 100);
    const saved = new ComposerDraftRepository(db().raw).save({
      projectId, text: input.text, messageId, attachmentIds, mode, continuationPolicy,
      starter, providers, viewMode, finalizerMode, finalResponder,
      composerExpanded: Boolean(input.composerExpanded),
    });
    return saved;
  });
  handle("composerDraft:clear", (_event, projectIdValue: unknown) => {
    const projectId = requireString(projectIdValue, "projectId", 200);
    assertProjectExists(projectId);
    new ComposerDraftRepository(db().raw).clear(projectId);
    logEvent("INFO", "composer.draft.cleared", { projectId });
    return { success: true };
  });
  handle("projects:list", () => new ProjectRepository(db()).listProjects());
  handle("projects:trash:list", () => new ProjectTrashService(db()).summaries());
  handle("projects:trash", async (_event, idsValue: unknown) => {
    if (!Array.isArray(idsValue) || idsValue.length === 0 || idsValue.length > 500) throw new Error("Select 1 to 500 projects");
    const projectIds = idsValue.map((id) => requireString(id, "projectId", 200));
    await activeOrchestrator?.stop();
    const moved = new ProjectTrashService(db()).move(projectIds);
    logEvent("INFO", "projects.trash.moved", { projectIds, count: moved.length });
    return moved;
  });
  handle("projects:restore", (_event, idsValue: unknown) => {
    if (!Array.isArray(idsValue) || idsValue.length === 0 || idsValue.length > 500) throw new Error("Select 1 to 500 projects");
    const projectIds = idsValue.map((id) => requireString(id, "projectId", 200));
    new ProjectTrashService(db()).restore(projectIds);
    logEvent("INFO", "projects.trash.restored", { projectIds });
    return { success: true };
  });
  handle("projects:deletePermanent", (_event, idsValue: unknown) => {
    if (!Array.isArray(idsValue) || idsValue.length === 0 || idsValue.length > 500) throw new Error("Select 1 to 500 projects");
    const projectIds = idsValue.map((id) => requireString(id, "projectId", 200));
    const repository = new ProjectRepository(db());
    for (const projectId of projectIds) {
      const project = repository.openProject(projectId);
      if (!project || project.status !== "ARCHIVED") throw new Error(`Project is not in trash: ${projectId}`);
    }
    repository.deleteProjects(projectIds);
    logEvent("INFO", "projects.trash.deleted_permanently", { projectIds });
    return { success: true };
  });
  handle("provider:openWebChat", async (_event, providerValue: unknown, conversationIdValue: unknown) => {
    const provider = parseProvider(requireString(providerValue, "provider", 20));
    const conversationId = conversationIdValue ? requireString(conversationIdValue, "conversationId", 200) : null;
    const conversation = conversationId
      ? db().raw.prepare("SELECT external_ref FROM conversations WHERE id = ? AND provider_id = ?").get(conversationId, provider) as { external_ref?: string | null } | undefined
      : undefined;
    const fallback = provider === "chatgpt" ? "https://chatgpt.com/" : "https://gemini.google.com/app";
    const target = conversation?.external_ref || fallback;
    const parsed = new URL(target);
    const allowedHosts = provider === "chatgpt" ? new Set(["chatgpt.com", "chat.openai.com"]) : new Set(["gemini.google.com"]);
    if (parsed.protocol !== "https:" || !allowedHosts.has(parsed.hostname)) throw new Error("Unsafe provider conversation URL");
    await shell.openExternal(parsed.toString());
    return { success: true };
  });
  handle("provider:rebindConversation", (_event, providerValue: unknown, conversationIdValue: unknown) => {
    const provider = parseProvider(requireString(providerValue, "provider", 20));
    const conversationId = requireString(conversationIdValue, "conversationId", 200);
    const result = db().raw.prepare("UPDATE conversations SET external_ref = NULL, updated_at = ? WHERE id = ? AND provider_id = ?").run(new Date().toISOString(), conversationId, provider);
    if (result.changes !== 1) throw new Error("Conversation not found");
    logEvent("INFO", "provider.conversation.rebind_requested", { provider, conversationId });
    return { success: true };
  });
  handle("projects:create", (_event, nameOrInput: unknown, providersValue: unknown) => {
    const input = nameOrInput && typeof nameOrInput === "object"
      ? nameOrInput as Record<string, unknown>
      : { name: nameOrInput, providers: providersValue };
    const providers = Array.isArray(input.providers)
      ? input.providers.map(p => String(p))
      : [];
    return new ProjectRepository(db()).createProject(
      requireString(input.name, "Project name", 200),
      providers,
      requireString(input.description ?? "", "Project description", 2_000, true),
    );
  });
  handle("projects:open", (_event, id: unknown) => {
    const projectId = requireString(id, "projectId", 200);
    const repository = new ProjectRepository(db());
    const project = repository.openProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    new AttachmentDraftLifecycle(db().raw).expireAndCleanup();
    const recoveredRuns = activeOrchestrator
      ? 0
      : repository.recoverUnfinishedRuns(projectId);
    const attachmentViews = attachmentViewsForProject(projectId);
    return {
      project,
      recoveredTurns: activeOrchestrator
        ? 0
        : repository.recoverUnfinishedTurns(projectId),
      recoveredRuns,
      conversations: repository.getConversationsForProject(projectId).map((c) => ({
        id: c.id,
        providerId: c.providerId,
        externalRef: c.externalRef,
      })),
      events: repository.projectEvents(projectId),
      transcript: repository.conversationEntries(projectId).map((entry) => ({
        ...entry,
        attachments: attachmentViews.transcriptAttachments[entry.id] ?? [],
      })),
      attachmentDraft: attachmentViews.draft,
      state: new ProjectStateService(db()).latest(projectId),
    };
  });
  handle("projects:delete", async (_event, input: unknown) => {
    const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const projectId = requireString(obj.projectId, "Project ID", 200);
    const deleteRemote = Boolean(obj.deleteRemote);

    logEvent("INFO", "project.delete.started", { projectId, deleteRemote });

    const repository = new ProjectRepository(db());
    const conversations = repository.getConversationsForProject(projectId);
    const remoteResults: Array<{ providerId: string; conversationId: string; deleted: boolean; error?: string }> = [];

    if (deleteRemote) {
      const adapters = new Map<string, ModelAdapter>();
      try {
        for (const conv of conversations) {
          if (!conv.externalRef) continue;
          try {
            let adapter = adapters.get(conv.providerId);
            if (!adapter) {
              adapter = createAdapter(parseProvider(conv.providerId), 30_000, true, db().raw);
              adapters.set(conv.providerId, adapter);
              await adapter.launch();
            }
            if (typeof adapter.deleteConversation !== "function") {
              remoteResults.push({
                providerId: conv.providerId,
                conversationId: conv.id,
                deleted: false,
                error: "Провайдер не поддерживает автоматическое удаление",
              });
              continue;
            }
            logEvent("INFO", "provider.conversation.deleting_remote", {
              providerId: conv.providerId,
              url: conv.externalRef,
            });
            const deleted = await adapter.deleteConversation({ id: conv.id, url: conv.externalRef });
            remoteResults.push({
              providerId: conv.providerId,
              conversationId: conv.id,
              deleted,
              ...(!deleted ? { error: "Диалог не найден или недоступен в веб-интерфейсе" } : {}),
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            remoteResults.push({ providerId: conv.providerId, conversationId: conv.id, deleted: false, error });
            logEvent("WARN", "provider.conversation.delete_remote_failed", {
              providerId: conv.providerId,
              error,
            });
          }
        }
      } finally {
        await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()));
      }
    }

    repository.deleteProject(projectId);
    const remoteFailures = remoteResults.filter((result) => !result.deleted).length;
    logEvent("INFO", "project.delete.completed", { projectId, remoteFailures });
    return { success: true, localDeleted: true, remoteResults };
  });

  const activeProviderOperations = new Map<string, Promise<any>>();

  handle("provider:login", async (_event, providerValue: unknown) => {
    const provider = parseProvider(
      requireString(providerValue, "provider", 20),
    );

    if (activeOrchestrator || activeOrchestrationAdapters) {
      throw new Error("Orchestration is currently active. Please wait or pause first.");
    }

    if (activeInteractiveLogin) {
      if (activeInteractiveLogin.provider === provider) {
        return activeInteractiveLogin.promise;
      }
      const activeName = PROVIDER_METADATA[activeInteractiveLogin.provider as ProviderId]?.name ?? activeInteractiveLogin.provider;
      const err = new Error(
        `Сейчас выполняется вход в ${activeName}. Завершите или отмените его перед входом в другую модель.`
      );
      (err as any).code = "LOGIN_ALREADY_ACTIVE";
      (err as any).activeProvider = activeInteractiveLogin.provider;
      throw err;
    }

    const adapter = createAdapter(provider, 180_000, false);
    activeLoginAdapters.set(provider, adapter);

    const loginTask = (async () => {
      logEvent("INFO", "provider.login.started", { provider });
      try {
        await adapter.launch();
        await adapter.openLoginMode();
        const session = await adapter.checkSession();
        logEvent("INFO", "provider.login.completed", { provider, session });
        return session;
      } catch (error) {
        const diagnosticPath = writeDiagnostic(error, {
          operation: "provider:login",
          provider,
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Диагностика: ${diagnosticPath}`,
        );
      } finally {
        activeLoginAdapters.delete(provider);
        await adapter.close().catch((err) => {
          logEvent("WARN", "provider.login.close_failed", { provider, error: err });
        });
      }
    })();

    activeInteractiveLogin = { provider, promise: loginTask };
    try {
      return await loginTask;
    } finally {
      if (activeInteractiveLogin?.provider === provider) {
        activeInteractiveLogin = null;
      }
    }
  });

  handle("provider:status", async (_event, providerValue: unknown) => {
    const provider = parseProvider(
      requireString(providerValue, "provider", 20),
    );

    const meta = PROVIDER_METADATA[provider];
    if (!meta || !meta.statusProbe) {
      return { provider, session: "UNKNOWN", ready: false, isSupported: false };
    }

    if (activeInteractiveLogin?.provider === provider || activeLoginAdapters.has(provider)) {
      return { provider, session: "BUSY", ready: false };
    }

    const adapter = createAdapter(provider, 30_000, true);
    try {
      await adapter.launch();
      const session = await adapter.checkSession();
      return { provider, session, ready: session === "AUTHENTICATED" };
    } catch (error) {
      return { provider, session: "UNKNOWN", ready: false, error: String(error) };
    } finally {
      await adapter.close().catch(() => undefined);
    }
  });

  handle(
    "provider:send",
    async (_event, providerValue: unknown, messageValue: unknown) => {
      if (providerOperationActive || activeOrchestrator || activeOrchestrationAdapters || activeInteractiveLogin) {
        throw new Error("Another provider operation is already active");
      }
      providerOperationActive = true;
      const message = requireString(messageValue, "message", 100_000);
      const provider = parseProvider(
        requireString(providerValue, "provider", 20),
      );
      const adapter = createAdapter(provider, 180_000, true, db().raw);
      logEvent("INFO", "provider.send.started", {
        provider,
        messageLength: message.length,
      });
      try {
        await adapter.launch();
        const turn = await adapter.sendMessage({ content: message });
        const result = await adapter.getFinalResponse(turn);
        logEvent("INFO", "provider.send.completed", {
          provider,
          responseFingerprint: result.responseFingerprint,
          elapsedMs: result.elapsedMs,
        });
        return result;
      } catch (error) {
        const diagnosticPath = writeDiagnostic(error, {
          operation: "provider:send",
          provider,
          messageLength: message.length,
        });
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Диагностика: ${diagnosticPath}`,
        );
      } finally {
        await adapter.close().catch(() => undefined);
        providerOperationActive = false;
      }
    },
  );

  handle(
    "orchestration:run",
    async (
      _event,
      inputValue: unknown,
    ) => {
      if (providerOperationActive || activeOrchestrator || activeOrchestrationAdapters || activeInteractiveLogin) {
        throw new Error("An orchestration run is already active");
      }
      const input = validateRunInput(inputValue);
      const adapters = new Map(
        input.providers.map((provider) => [provider, createAdapter(provider, 180_000, true, db().raw)]),
      );
      activeOrchestrationAdapters = adapters;
      try {
        const launches = await Promise.allSettled(
          [...adapters.entries()].map(async ([provider, adapter]) => {
            const startedAt = Date.now();
            logEvent("INFO", "provider.launch.started", { provider });
            try {
              await adapter.launch();
              logEvent("INFO", "provider.launch.completed", {
                provider,
                elapsedMs: Date.now() - startedAt,
              });
            } catch (error) {
              logEvent("ERROR", "provider.launch.failed", {
                provider,
                elapsedMs: Date.now() - startedAt,
                error,
              });
              throw error;
            }
          }),
        );
        const launchFailure = launches.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (launchFailure) throw launchFailure.reason;
        const sessions = await Promise.all(
          [...adapters.entries()].map(async ([provider, adapter]) => {
            const state = await adapter.checkSession();
            logEvent("INFO", "provider.session.checked", { provider, state });
            return { provider, state };
          }),
        );
        const unavailable = sessions.filter(({ state }) => state !== "AUTHENTICATED");
        if (unavailable.length > 0) {
          throw new Error(
            `Провайдеры не готовы: ${unavailable
              .map(({ provider, state }) => `${provider} (${state})`)
              .join(", ")}. Сначала выполните вход кнопками слева.`,
          );
        }
        activeOrchestrator = new Orchestrator(db(), adapters);
        return await activeOrchestrator.run(
          input.projectId,
          input.mode,
          input.task,
          input.providers,
          {
            ...(input.limits ? { limits: input.limits } : {}),
            hooks: {
              confirm: async (summary) => {
                logEvent("INFO", "orchestration.confirmation.shown", {
                  projectId: input.projectId,
                  summaryLength: summary.length,
                });
                const result = await dialog.showMessageBox(mainWindow!, {
                  type: "question",
                  buttons: ["Продолжить", "Остановить"],
                  defaultId: 0,
                  cancelId: 1,
                  title: "Подтверждение продолжения",
                  message: summary,
                  detail: "Модели достигли контрольной точки ограниченной дискуссии.",
                });
                logEvent("INFO", "orchestration.confirmation.resolved", {
                  projectId: input.projectId,
                  continued: result.response === 0,
                });
                return result.response === 0;
              },
              onProgress: (event) => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send("orchestration:progress", event);
                }
              },
            },
            ...(input.attachments ? { attachments: input.attachments } : {}),
            ...(input.finalizerMode ? { finalizerMode: input.finalizerMode } : {}),
            ...(input.finalResponder ? { finalResponder: input.finalResponder } : {}),
            ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
            ...(input.promptCustomizations
              ? { promptCustomizations: input.promptCustomizations }
              : {}),
          },
        );
      } catch (error) {
        const diagnosticPath = writeDiagnostic(error, {
          operation: "orchestration:run",
          projectId: input.projectId,
          mode: input.mode,
          providers: input.providers,
        });
        const rawMessage = error instanceof Error ? error.message : String(error);
        let message = rawMessage;
        if (/LOGIN_REQUIRED/.test(rawMessage)) {
          const providerMatch = rawMessage.match(/(\w+) state: LOGIN_REQUIRED/i);
          if (providerMatch && providerMatch[1]) {
            const providerId = providerMatch[1].toLowerCase() as ProviderId;
            const providerName = PROVIDER_METADATA[providerId]?.name ?? providerMatch[1];
            message = `Нужен вход в ${providerName}. Нажмите «Войти · ${providerId}» в левой панели, завершите вход и повторите отправку.`;
          } else {
            message = "Один или несколько провайдеров требуют авторизации. Завершите вход в панели слева и повторите отправку.";
          }
        }
        throw new Error(`${message} Диагностика: ${diagnosticPath}`);
      } finally {
        if (activeOrchestrationAdapters) {
          const toClose = activeOrchestrationAdapters;
          activeOrchestrationAdapters = null;
          await Promise.allSettled([...toClose.values()].map((adapter) => adapter.close()));
        }
        activeOrchestrator = null;
      }
    },
  );
  handle("orchestration:pause", () => activeOrchestrator?.pause());
  handle("orchestration:resume", () => activeOrchestrator?.resume());
  handle("orchestration:stop", () => activeOrchestrator?.stop());
  handle("state:save", (_event, projectIdValue: unknown, state: ProjectState) => {
    const projectId = requireString(projectIdValue, "projectId", 200);
    if (JSON.stringify(state).length > 1_000_000) {
      throw new Error("Project State exceeds 1 MB");
    }
    return new ProjectStateService(db()).createVersion(projectId, state);
  });
  handle("state:approve", (_event, id: unknown) =>
    new ProjectStateService(db()).approve(
      requireString(id, "stateId", 200),
    ),
  );
  handle("state:latest", (_event, projectId: unknown) =>
    new ProjectStateService(db()).latest(
      requireString(projectId, "projectId", 200),
    ),
  );
  handle("export:spec", async (_event, projectIdValue: unknown) => {
    const projectId = requireString(projectIdValue, "projectId", 200);
    const state = new ProjectStateService(db()).latest(projectId);
    if (!state) throw new Error("Create Project State before export");
    return new SpecExporter(db()).export(projectId, state);
  });
  handle("cliTasks:list", (_event, projectId: unknown) => {
    const pId = requireString(projectId, "projectId", 200);
    return new TaskFsmRepository(db().raw).listTasksByProject(pId);
  });
  handle("cliTasks:approve", async (_event, input: unknown) => {
    const data = input as { projectId?: string; taskId?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const taskId = requireString(data?.taskId, "taskId", 200);
    return getCliService().approveTask(projectId, taskId);
  });
  handle("cliTasks:reject", (_event, input: unknown) => {
    const data = input as { projectId?: string; taskId?: string; reason?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const taskId = requireString(data?.taskId, "taskId", 200);
    const reason = data.reason === undefined
      ? undefined
      : requireString(data.reason, "reason", 2_000);
    return getCliService().rejectTask(projectId, taskId, reason);
  });
  handle("cliTasks:cancel", (_event, input: unknown) => {
    const data = input as { projectId?: string; taskId?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const taskId = requireString(data?.taskId, "taskId", 200);
    return getCliService().cancelTask(projectId, taskId);
  });
  handle("cliTasks:retry", (_event, input: unknown) => {
    const data = input as { projectId?: string; taskId?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const taskId = requireString(data?.taskId, "taskId", 200);
    return getCliService().retryTask(projectId, taskId);
  });
  handle("cliTasks:executors", () => getCliService().getAvailableExecutors());
  handle("cliTasks:workspaceCapabilities", () => getCliService().getWorkspaceCapabilities());
  handle("memory:getBrief", (_event, projectId: unknown) => {
    const pId = requireString(projectId, "projectId", 200);
    return new ThreeTierMemoryManager(db().raw).getLatestRollingBrief(pId);
  });
  handle("memory:createCheckpoint", (_event, projectId: unknown) => {
    const pId = requireString(projectId, "projectId", 200);
    const memMgr = new ThreeTierMemoryManager(db().raw);
    const rollMgr = new ContextRolloverManager(db().raw);
    const activeItems = memMgr.getActiveMemoryItems(pId);
    const pack = rollMgr.createContinuationPack({
      projectId: pId,
      previousConversationId: "conv-manual",
      objective: "Manual user checkpoint",
      activeMemoryItems: activeItems,
      completedWork: [],
      openTasks: [],
      failedAttempts: [],
      nextAction: "Continue",
    });
    rollMgr.saveCheckpoint(pack, "manual-run");
    return pack;
  });
  handle("memory:rollover", (_event, input: unknown) => {
    const data = input as { projectId?: string; provider?: string };
    const pId = requireString(data?.projectId, "projectId", 200);
    const prov = requireString(data?.provider, "provider", 100);
    return { success: true, projectId: pId, provider: prov, status: "COMPLETED" };
  });
  handle("prompts:listProposals", () => {
    const rows = db().raw.prepare("SELECT * FROM prompt_change_proposals ORDER BY created_at DESC").all();
    return rows;
  });
  handle("prompts:approveProposal", (_event, id: unknown) => {
    const propId = requireString(id, "proposalId", 200);
    const registry = new PromptRegistry(db().raw);
    return registry.approveChangeProposal(propId, `v1.${Date.now().toString().slice(-3)}.0`, "G+G PRODUCTIVE COLLABORATION PROTOCOL v1-updated");
  });
  handle("attachments:pickFiles", async (_event, input: unknown) => {
    const data = input as { projectId?: string; messageId?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const messageId = requireString(data?.messageId, "messageId", 200);
    assertProjectExists(projectId);
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile", "multiSelections"],
      title: "Select Attachments",
      filters: [{ name: "Supported files", extensions: ["txt", "md", "pdf", "png", "jpg", "jpeg", "webp"] }],
    });
    if (result.canceled || !result.filePaths.length) return [];

    const staging = new AttachmentStagingService(db().raw);
    const refs: RendererAttachmentDto[] = [];
    for (const filePath of result.filePaths) {
      refs.push(staging.stagePath(filePath, { projectId, messageId }));
    }
    return refs;
  });
  handle("attachments:stageDroppedFile", async (_event, input: unknown) => {
    const data = input as { projectId?: string; messageId?: string; filePath?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const messageId = requireString(data?.messageId, "messageId", 200);
    const filePath = requireString(data?.filePath, "filePath", 1000);
    assertProjectExists(projectId);

    return new AttachmentStagingService(db().raw).stagePath(filePath, { projectId, messageId });
  });
  handle("attachments:stageClipboard", async (_event, input: unknown) => {
    const data = input as { projectId?: string; messageId?: string; bytes?: unknown; mimeType?: string; fileName?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const messageId = requireString(data?.messageId, "messageId", 200);
    const mimeType = requireString(data?.mimeType, "mimeType", 100).toLowerCase();
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(mimeType)) {
      throw new Error(`Clipboard type ${mimeType} is unsupported; use file picker or drag-and-drop`);
    }
    assertProjectExists(projectId);
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const requestedName = typeof data.fileName === "string" && data.fileName.trim()
      ? path.basename(data.fileName.trim())
      : `pasted_image_${Date.now()}.${extension}`;
    return new AttachmentStagingService(db().raw).stageBytes(
      data.bytes,
      { projectId, messageId },
      requestedName.toLowerCase().endsWith(`.${extension}`) ? requestedName : `pasted_image_${Date.now()}.${extension}`,
    );
  });
  handle("attachments:listDraft", (_event, input: unknown) => {
    const data = input as { projectId?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    assertProjectExists(projectId);
    return attachmentViewsForProject(projectId).draft;
  });
  handle("attachments:retryDraft", (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref) throw new Error("Attachment not found");
    const sentEntry = db().raw.prepare("SELECT 1 AS found FROM conversation_entries WHERE id=?").get(ref.messageId);
    if (sentEntry) throw new Error("Sent attachments cannot be retried as drafts");
    if (ref.status === "QUARANTINED") throw new Error("Quarantined attachments cannot be retried");
    const integrity = new LocalArtifactStore().verifyIntegrity(ref);
    if (!integrity.valid) {
      db().raw.prepare("UPDATE message_attachments SET status='FAILED', last_error=?, updated_at=? WHERE id=?")
        .run(`Integrity check failed: ${integrity.reason}`, new Date().toISOString(), id);
    } else {
      const now = new Date();
      const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      db().raw.prepare("UPDATE message_attachments SET status='STAGED', last_error=NULL, draft_expires_at=?, updated_at=? WHERE id=?")
        .run(expires, now.toISOString(), id);
    }
    const row = db().raw.prepare("SELECT * FROM message_attachments WHERE id=?").get(id) as Record<string, unknown>;
    return attachmentDtoFromRow(row);
  });
  handle("attachments:removeDraft", (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref) return { success: true };
    const sentEntry = db().raw.prepare("SELECT 1 AS found FROM conversation_entries WHERE id=?").get(ref.messageId);
    if (sentEntry) throw new Error("Cannot remove an attachment from transcript history");
    const deliveryCount = db().raw.prepare("SELECT COUNT(*) AS count FROM attachment_deliveries WHERE attachment_id = ?").get(id) as { count: number };
    if (deliveryCount.count > 0) throw new Error("Cannot remove an attachment that has delivery history");
    db().raw.prepare("DELETE FROM message_attachments WHERE id = ?").run(id);
    const remaining = db().raw.prepare("SELECT COUNT(*) AS count FROM message_attachments WHERE local_relative_path = ?").get(ref.localRelativePath) as { count: number };
    if (remaining.count === 0) {
      const fullPath = new LocalArtifactStore().resolveAbsolutePath(ref.localRelativePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }
    return { success: true };
  });
  handle("attachments:open", async (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref) return { success: false, error: "Attachment not found" };
    if (ref.status === "QUARANTINED" || ref.status === "FAILED") {
      return { success: false, error: `Attachment is not safe to open: ${ref.quarantineReason ?? ref.status}` };
    }
    const openableMimeTypes = new Set(["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg", "image/webp"]);
    if (!openableMimeTypes.has(ref.mimeType)) return { success: false, error: `Opening ${ref.mimeType} is not allowed` };

    const store = new LocalArtifactStore();
    store.readVerifiedBuffer(ref);
    const fullPath = store.resolveAbsolutePath(ref.localRelativePath);
    const err = await shell.openPath(fullPath);
    return { success: !err, error: err || undefined };
  });
  handle("attachments:saveAs", async (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref || ref.status === "QUARANTINED" || ref.status === "FAILED") return { success: false };

    const saveRes = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: ref.fileName,
    });
    if (saveRes.canceled || !saveRes.filePath) return { success: false };

    const store = new LocalArtifactStore();
    const buf = store.readVerifiedBuffer(ref);
    fs.writeFileSync(saveRes.filePath, buf);
    return { success: true, fileName: path.basename(saveRes.filePath) };
  });
  handle("window:setTheme", (_event, theme: unknown) => {
    if (theme !== "dark" && theme !== "light") throw new Error("Unsupported title bar theme");
    mainWindow?.setTitleBarOverlay({
      color: theme === "light" ? "#FFFFFF" : "#151516",
      symbolColor: theme === "light" ? "#121212" : "#F7F6F2",
      height: 56,
    });
    return { success: true };
  });
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: "Файл", submenu: [{ role: "quit" }] },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  configureDataRoot(process.env.G_PLUS_G_USER_DATA ?? app.getPath("userData"));
  registerRendererProtocol();
  database = new AppDatabase(dataPath("orchestrator.sqlite"));
  database.migrate();
  logEvent("INFO", "application.ready", {
    version: app.getVersion(),
    dataRoot: dataPath(),
  });
  registerIpc();
  configureApplicationMenu();
  createWindow();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  if ((!activeOrchestrator && !activeOrchestrationAdapters && activeLoginAdapters.size === 0) || quitAfterCleanup) return;
  event.preventDefault();
  void (async () => {
    await activeOrchestrator?.stop();
    await closeActiveAdapters();
    quitAfterCleanup = true;
    app.quit();
  })();
});

app.on("will-quit", () => {
  database?.close();
  database = null;
});
