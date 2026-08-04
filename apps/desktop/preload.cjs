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
    create: (name, providers) => ipcRenderer.invoke("projects:create", name, providers),
    open: (id) => ipcRenderer.invoke("projects:open", id),
    delete: (id, deleteRemote) => ipcRenderer.invoke("projects:delete", { projectId: id, deleteRemote }),
  },
  provider: {
    login: (provider) => ipcRenderer.invoke("provider:login", provider),
    status: (provider) => ipcRenderer.invoke("provider:status", provider),
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
  cliTasks: {
    list: (projectId) => ipcRenderer.invoke("cliTasks:list", projectId),
    approve: (taskId) => ipcRenderer.invoke("cliTasks:approve", taskId),
    reject: (taskId, reason) => ipcRenderer.invoke("cliTasks:reject", { taskId, reason }),
    cancel: (taskId) => ipcRenderer.invoke("cliTasks:cancel", taskId),
    retry: (taskId) => ipcRenderer.invoke("cliTasks:retry", taskId),
  },
  memory: {
    getBrief: (projectId) => ipcRenderer.invoke("memory:getBrief", projectId),
    createCheckpoint: (projectId) => ipcRenderer.invoke("memory:createCheckpoint", projectId),
    rollover: (projectId, provider) => ipcRenderer.invoke("memory:rollover", { projectId, provider }),
  },
  prompts: {
    listProposals: () => ipcRenderer.invoke("prompts:listProposals"),
    approveProposal: (id) => ipcRenderer.invoke("prompts:approveProposal", id),
  },
};

contextBridge.exposeInMainWorld("orchestrator", api);
