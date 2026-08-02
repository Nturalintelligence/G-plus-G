const { contextBridge, ipcRenderer } = require("electron");

const api = {
  system: {
    preflight: () => ipcRenderer.invoke("system:preflight"),
    info: () => ipcRenderer.invoke("system:info"),
    openDataFolder: () => ipcRenderer.invoke("system:openDataFolder"),
  },
  maintenance: {
    backup: () => ipcRenderer.invoke("maintenance:backup"),
    resetSession: (provider) =>
      ipcRenderer.invoke("maintenance:resetSession", provider),
  },
  quality: {
    dashboard: () => ipcRenderer.invoke("quality:dashboard"),
  },
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (name) => ipcRenderer.invoke("projects:create", name),
    open: (id) => ipcRenderer.invoke("projects:open", id),
    delete: (id, deleteRemote) => ipcRenderer.invoke("projects:delete", { projectId: id, deleteRemote }),
  },
  provider: {
    login: (provider) => ipcRenderer.invoke("provider:login", provider),
    send: (provider, message) =>
      ipcRenderer.invoke("provider:send", provider, message),
  },
  orchestration: {
    run: (input) => ipcRenderer.invoke("orchestration:run", input),
    pause: () => ipcRenderer.invoke("orchestration:pause"),
    resume: () => ipcRenderer.invoke("orchestration:resume"),
    stop: () => ipcRenderer.invoke("orchestration:stop"),
    onProgress: (callback) => {
      const subscription = (_event, value) => callback(value);
      ipcRenderer.on("orchestration:progress", subscription);
      return () => ipcRenderer.off("orchestration:progress", subscription);
    },
  },
  events: {
    onEvent: (callback) => {
      const subscription = (_event, value) => callback(value);
      ipcRenderer.on("bus:event", subscription);
      return () => ipcRenderer.off("bus:event", subscription);
    },
  },
  state: {
    latest: (projectId) => ipcRenderer.invoke("state:latest", projectId),
    save: (projectId, state) =>
      ipcRenderer.invoke("state:save", projectId, state),
    approve: (id) => ipcRenderer.invoke("state:approve", id),
  },
  exports: {
    spec: (projectId) => ipcRenderer.invoke("export:spec", projectId),
  },
  terminal: {
    execute: (command, cwd) => ipcRenderer.invoke("terminal:execute", { command, cwd }),
  },
  twoTier: {
    executeStep: (userTask, simulatedResponse) =>
      ipcRenderer.invoke("twoTier:executeStep", { userTask, simulatedResponse }),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (value) => ipcRenderer.invoke("settings:save", value),
  },
};

contextBridge.exposeInMainWorld("orchestrator", api);
