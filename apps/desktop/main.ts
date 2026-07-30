import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, net, protocol } from "electron";
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

let mainWindow: BrowserWindow | null = null;
let database: AppDatabase | null = null;
let activeOrchestrator: Orchestrator | null = null;
let activeAdapters: Map<string, ModelAdapter> | null = null;
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
  void mainWindow
    .loadURL("app://bundle/index.html")
    .catch((error) => console.error("Failed to load desktop renderer", error));
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
  ipcMain.handle("projects:list", () => new ProjectRepository(db()).listProjects());
  ipcMain.handle("projects:create", (_event, name: string) =>
    new ProjectRepository(db()).createProject(name),
  );
  ipcMain.handle("projects:open", (_event, id: string) => {
    const repository = new ProjectRepository(db());
    const project = repository.openProject(id);
    if (!project) throw new Error(`Project not found: ${id}`);
    return {
      project,
      recoveredTurns: activeOrchestrator ? 0 : repository.recoverUnfinishedTurns(id),
      events: repository.events(),
      transcript: repository.conversationEntries(id),
      state: new ProjectStateService(db()).latest(id),
    };
  });
  ipcMain.handle("provider:login", async (_event, providerValue: string) => {
    const provider = parseProvider(providerValue);
    const adapter = createAdapter(provider);
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
      await adapter.close();
    }
  });
  ipcMain.handle(
    "provider:send",
    async (_event, providerValue: string, message: string) => {
      const provider = parseProvider(providerValue);
      const adapter = createAdapter(provider);
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
        await adapter.close();
      }
    },
  );
  ipcMain.handle(
    "orchestration:run",
    async (
      _event,
      input: {
        projectId: string;
        mode: RunMode;
        task: string;
        providers: Array<"chatgpt" | "gemini">;
      },
    ) => {
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
          undefined,
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
  ipcMain.handle("orchestration:pause", () => activeOrchestrator?.pause());
  ipcMain.handle("orchestration:resume", () => activeOrchestrator?.resume());
  ipcMain.handle("orchestration:stop", () => activeOrchestrator?.stop());
  ipcMain.handle(
    "state:save",
    (_event, projectId: string, state: ProjectState) =>
      new ProjectStateService(db()).createVersion(projectId, state),
  );
  ipcMain.handle("state:approve", (_event, id: string) =>
    new ProjectStateService(db()).approve(id),
  );
  ipcMain.handle("state:latest", (_event, projectId: string) =>
    new ProjectStateService(db()).latest(projectId),
  );
  ipcMain.handle("export:spec", async (_event, projectId: string) => {
    const state = new ProjectStateService(db()).latest(projectId);
    if (!state) throw new Error("Create Project State before export");
    return new SpecExporter(db()).export(projectId, state);
  });
}

app.whenReady().then(() => {
  configureDataRoot(app.getPath("userData"));
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
