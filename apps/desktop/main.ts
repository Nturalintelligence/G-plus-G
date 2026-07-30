import { join, resolve, sep } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, ipcMain, net, protocol } from "electron";
import { createAdapter, parseProvider } from "../../src/adapters/adapter-registry.js";
import { SpecExporter } from "../../src/artifacts/spec-exporter.js";
import { Orchestrator, type RunMode } from "../../src/orchestrator/orchestrator.js";
import { ProjectStateService, type ProjectState } from "../../src/project-state.js";
import { AppDatabase } from "../../src/storage/database.js";
import { ProjectRepository } from "../../src/storage/repository.js";
import type { ModelAdapter } from "../../src/adapters/adapter-contract.js";

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

function writeDiagnostic(error: unknown, context: Record<string, unknown>): string {
  const directory = join(app.getPath("userData"), "logs");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `diagnostic-${Date.now()}.json`);
  const value = error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : { message: String(error) };
  writeFileSync(
    path,
    JSON.stringify({ occurredAt: new Date().toISOString(), error: value, context }, null, 2),
    "utf8",
  );
  return path;
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
      recoveredTurns: repository.recoverUnfinishedTurns(id),
      events: repository.events(),
      transcript: repository.conversationEntries(id),
      state: new ProjectStateService(db()).latest(id),
    };
  });
  ipcMain.handle("provider:login", async (_event, providerValue: string) => {
    const adapter = createAdapter(parseProvider(providerValue));
    await adapter.launch();
    try {
      await adapter.openLoginMode();
      return adapter.checkSession();
    } finally {
      await adapter.close();
    }
  });
  ipcMain.handle(
    "provider:send",
    async (_event, providerValue: string, message: string) => {
      const adapter = createAdapter(parseProvider(providerValue));
      await adapter.launch();
      try {
        const turn = await adapter.sendMessage({ content: message });
        return adapter.getFinalResponse(turn);
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
        activeOrchestrator = new Orchestrator(db(), adapters);
        return await activeOrchestrator.run(
          input.projectId,
          input.mode,
          input.task,
          input.providers,
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
  registerRendererProtocol();
  database = new AppDatabase(join(app.getPath("userData"), "orchestrator.sqlite"));
  database.migrate();
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
