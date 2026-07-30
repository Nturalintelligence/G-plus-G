import { join, resolve, sep } from "node:path";
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
import { Orchestrator, type RunMode } from "../../src/orchestrator/orchestrator.js";
import { ProjectStateService, type ProjectState } from "../../src/project-state.js";
import { AppDatabase } from "../../src/storage/database.js";
import { ProjectRepository } from "../../src/storage/repository.js";
import type { ModelAdapter } from "../../src/adapters/adapter-contract.js";
import { configureDataRoot, dataPath } from "../../src/paths.js";
import {
  logEvent,
  writeDiagnostic,
} from "../../src/observability/logger.js";
import { SettingsStore } from "../../src/settings/settings.js";
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

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activeAdapters: Map<string, ModelAdapter> | null = null;
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

function db(): AppDatabase {
  if (!database) throw new Error("Database is not initialized");
  return database;
}

async function closeActiveAdapters(): Promise<void> {
  const adapters = activeAdapters;
  activeAdapters = null;
  if (!adapters) return;
  await Promise.allSettled([...adapters.values()].map((adapter) => adapter.close()));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#0d1117",
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
  providers: Array<"chatgpt" | "gemini">;
  limits?: OrchestrationLimits;
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
    input.providers.length > 2
  ) {
    throw new Error("Select one or two providers");
  }
  const providers = [...new Set(input.providers)];
  if (
    providers.some(
      (provider) => provider !== "chatgpt" && provider !== "gemini",
    )
  ) {
    throw new Error("Invalid provider");
  }
  const limits =
    input.limits === undefined
      ? undefined
      : (input.limits as OrchestrationLimits);
  if (limits) validateLimits(limits);
  return {
    projectId,
    mode: input.mode as RunMode,
    task,
    providers: providers as Array<"chatgpt" | "gemini">,
    ...(limits ? { limits } : {}),
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
    if (providerOperationActive || activeOrchestrator || activeAdapters) {
      throw new Error("Cannot create a backup while a provider operation is active");
    }
    const destination = dataPath("backups");
    const path = await createBackupBundle({ destinationRoot: destination });
    logEvent("INFO", "maintenance.backup.created", { path });
    return path;
  });
  handle("maintenance:resetSession", async (_event, providerValue: unknown) => {
    if (providerOperationActive || activeOrchestrator || activeAdapters) {
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
  handle("projects:create", (_event, name: unknown) =>
    new ProjectRepository(db()).createProject(
      requireString(name, "Project name", 200),
    ),
  );
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
      events: repository.projectEvents(projectId),
      transcript: repository.conversationEntries(projectId),
      state: new ProjectStateService(db()).latest(projectId),
    };
  });
  handle("provider:login", async (_event, providerValue: unknown) => {
    if (providerOperationActive || activeOrchestrator || activeAdapters) {
      throw new Error("Another provider operation is already active");
    }
    providerOperationActive = true;
    const provider = parseProvider(
      requireString(providerValue, "provider", 20),
    );
    const adapter = createAdapter(provider);
    activeAdapters = new Map([[provider, adapter]]);
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
      await closeActiveAdapters();
      providerOperationActive = false;
    }
  });
  handle(
    "provider:send",
    async (_event, providerValue: unknown, messageValue: unknown) => {
      if (providerOperationActive || activeOrchestrator || activeAdapters) {
        throw new Error("Another provider operation is already active");
      }
      providerOperationActive = true;
      const message = requireString(messageValue, "message", 100_000);
      const provider = parseProvider(
        requireString(providerValue, "provider", 20),
      );
      const adapter = createAdapter(provider);
      activeAdapters = new Map([[provider, adapter]]);
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
        await closeActiveAdapters();
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
      if (providerOperationActive || activeOrchestrator || activeAdapters) {
        throw new Error("An orchestration run is already active");
      }
      const input = validateRunInput(inputValue);
      const adapters = new Map(
        input.providers.map((provider) => [provider, createAdapter(provider)]),
      );
      activeAdapters = adapters;
      try {
        const launches = await Promise.allSettled(
          [...adapters.values()].map((adapter) => adapter.launch()),
        );
        const launchFailure = launches.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (launchFailure) throw launchFailure.reason;
        const sessions = await Promise.all(
          [...adapters.entries()].map(async ([provider, adapter]) => ({
            provider,
            state: await adapter.checkSession(),
          })),
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
          input.limits,
          {
            confirm: async (summary) => {
              const result = await dialog.showMessageBox(mainWindow!, {
                type: "question",
                buttons: ["Продолжить", "Остановить"],
                defaultId: 0,
                cancelId: 1,
                title: "Подтверждение продолжения",
                message: summary,
                detail: "Модели достигли контрольной точки ограниченной дискуссии.",
              });
              return result.response === 0;
            },
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
        const message = /LOGIN_REQUIRED/.test(rawMessage)
          ? "Нужен вход в ChatGPT. Нажмите «Войти · chatgpt», завершите вход и повторите отправку."
          : rawMessage;
        throw new Error(`${message} Диагностика: ${diagnosticPath}`);
      } finally {
        await closeActiveAdapters();
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
  if ((!activeOrchestrator && !activeAdapters) || quitAfterCleanup) return;
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
