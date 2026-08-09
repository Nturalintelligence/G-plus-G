import fs from "node:fs";
import path, { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
  type IpcMainInvokeEvent,
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
import { DEFAULT_MAX_ARTIFACT_BYTES, LocalArtifactStore } from "../../src/attachments/artifact-store.js";

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
  return row ? attachmentRefFromRow(row) : null;
}

function persistAttachmentRef(ref: AttachmentRefV1): void {
  db().raw.prepare(`
    INSERT INTO message_attachments
    (id, message_id, project_id, kind, file_name, mime_type, size_bytes, sha256, local_relative_path, source, status, quarantine_reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    ref.id,
    ref.messageId,
    ref.projectId,
    ref.kind,
    ref.fileName,
    ref.mimeType,
    ref.sizeBytes,
    ref.sha256,
    ref.localRelativePath,
    ref.source,
    ref.status,
    ref.quarantineReason ?? null,
    new Date().toISOString(),
  );
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
    backgroundColor: "#0d1117",
    icon: join(app.getAppPath(), "dist/desktop/logo.png"),
    webPreferences: {
      preload: join(app.getAppPath(), "apps/desktop/preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
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
  handle("projects:list", () => new ProjectRepository(db()).listProjects());
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
    const recoveredRuns = activeOrchestrator
      ? 0
      : repository.recoverUnfinishedRuns(projectId);
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
      transcript: repository.conversationEntries(projectId),
      state: new ProjectStateService(db()).latest(projectId),
    };
  });
  handle("projects:delete", async (_event, input: unknown) => {
    const obj = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const projectId = requireString(obj.projectId, "Project ID", 200);
    const deleteRemote = Boolean(obj.deleteRemote);

    logEvent("INFO", "project.delete.started", { projectId, deleteRemote });

    if (deleteRemote && activeOrchestrationAdapters) {
      const repository = new ProjectRepository(db());
      const conversations = repository.getConversationsForProject(projectId);

      for (const conv of conversations) {
        if (!conv.externalRef) continue;
        const adapter = activeOrchestrationAdapters.get(conv.providerId);
        if (adapter && typeof adapter.deleteConversation === "function") {
          try {
            logEvent("INFO", "provider.conversation.deleting_remote", {
              providerId: conv.providerId,
              url: conv.externalRef,
            });
            await adapter.deleteConversation({ id: conv.id, url: conv.externalRef });
          } catch (err) {
            logEvent("WARN", "provider.conversation.delete_remote_failed", {
              providerId: conv.providerId,
              error: err,
            });
          }
        }
      }
    }

    const repository = new ProjectRepository(db());
    new ProjectRepository(db()).deleteProject(projectId);
    logEvent("INFO", "project.delete.completed", { projectId });
    return { success: true };
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
      const adapter = createAdapter(provider, 180_000, true);
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
        input.providers.map((provider) => [provider, createAdapter(provider, 180_000, true)]),
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
      filters: [{ name: "Supported files", extensions: ["txt", "md", "pdf", "png", "jpg", "jpeg"] }],
    });
    if (result.canceled || !result.filePaths.length) return [];

    const store = new LocalArtifactStore();
    const refs: AttachmentRefV1[] = [];
    for (const filePath of result.filePaths) {
      const ref = store.storeFileFromPath(filePath, {
        projectId,
        messageId,
        source: "user",
        originalFileName: path.basename(filePath),
      });
      persistAttachmentRef(ref);
      refs.push(ref);
    }
    return refs;
  });
  handle("attachments:stageDroppedFile", async (_event, input: unknown) => {
    const data = input as { projectId?: string; messageId?: string; filePath?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const messageId = requireString(data?.messageId, "messageId", 200);
    const filePath = requireString(data?.filePath, "filePath", 1000);
    assertProjectExists(projectId);

    const store = new LocalArtifactStore();
    const ref = store.storeFileFromPath(filePath, {
      projectId,
      messageId,
      source: "user",
      originalFileName: path.basename(filePath),
    });
    persistAttachmentRef(ref);
    return ref;
  });
  handle("attachments:stageClipboardImage", async (_event, input: unknown) => {
    const data = input as { projectId?: string; messageId?: string; base64Data?: string };
    const projectId = requireString(data?.projectId, "projectId", 200);
    const messageId = requireString(data?.messageId, "messageId", 200);
    const base64Data = requireString(data?.base64Data, "base64Data", 16_000_000);
    assertProjectExists(projectId);
    const match = /^data:image\/(png|jpe?g);base64,([A-Za-z0-9+/]+={0,2})$/.exec(base64Data);
    if (!match) throw new Error("Clipboard attachment must be a PNG or JPEG data URL");
    const encodedImage = match[2];
    if (!encodedImage) throw new Error("Clipboard image payload is missing");
    const fileBuf = Buffer.from(encodedImage, "base64");
    if (fileBuf.length === 0 || fileBuf.length > DEFAULT_MAX_ARTIFACT_BYTES) {
      throw new Error("Clipboard image is empty or exceeds the size limit");
    }

    const store = new LocalArtifactStore();
    const ref = store.storeBuffer(fileBuf, {
      projectId,
      messageId,
      source: "user",
      originalFileName: `pasted_screenshot_${Date.now()}.${match[1] === "png" ? "png" : "jpg"}`,
    });
    persistAttachmentRef(ref);
    return ref;
  });
  handle("attachments:removeDraft", (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref) return { success: true };
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
    const openableMimeTypes = new Set(["text/plain", "text/markdown", "application/pdf", "image/png", "image/jpeg"]);
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
    return { success: true, targetPath: saveRes.filePath };
  });
  handle("attachments:getPreviewUrl", (_event, attachmentId: unknown) => {
    const id = requireString(attachmentId, "attachmentId", 200);
    const ref = findAttachmentRef(id);
    if (!ref || ref.kind !== "image" || ref.status === "QUARANTINED" || ref.status === "FAILED") return null;

    try {
      const store = new LocalArtifactStore();
      const buf = store.readVerifiedBuffer(ref);
      return `data:${ref.mimeType};base64,${buf.toString("base64")}`;
    } catch {
      return null;
    }
  });
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
