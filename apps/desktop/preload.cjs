const { contextBridge, ipcRenderer, webUtils } = require("electron");

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
    create: (name, providers, description = "") => ipcRenderer.invoke("projects:create", { name, providers, description }),
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
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (value) => ipcRenderer.invoke("settings:save", value),
  },
  cliTasks: {
    list: (projectId) => ipcRenderer.invoke("cliTasks:list", projectId),
    approve: (projectId, taskId) => ipcRenderer.invoke("cliTasks:approve", { projectId, taskId }),
    reject: (projectId, taskId, reason) => ipcRenderer.invoke("cliTasks:reject", { projectId, taskId, reason }),
    cancel: (projectId, taskId) => ipcRenderer.invoke("cliTasks:cancel", { projectId, taskId }),
    retry: (projectId, taskId) => ipcRenderer.invoke("cliTasks:retry", { projectId, taskId }),
    executors: () => ipcRenderer.invoke("cliTasks:executors"),
    workspaceCapabilities: () => ipcRenderer.invoke("cliTasks:workspaceCapabilities"),
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
  attachments: {
    pickFiles: (projectId, messageId) => ipcRenderer.invoke("attachments:pickFiles", { projectId, messageId }),
    stageDroppedFile: (projectId, messageId, file) => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) throw new Error("Dropped file has no trusted local path");
      return ipcRenderer.invoke("attachments:stageDroppedFile", { projectId, messageId, filePath });
    },
    stageClipboardImage: (projectId, messageId, base64Data) => ipcRenderer.invoke("attachments:stageClipboardImage", { projectId, messageId, base64Data }),
    removeDraft: (attachmentId) => ipcRenderer.invoke("attachments:removeDraft", attachmentId),
    open: (attachmentId) => ipcRenderer.invoke("attachments:open", attachmentId),
    saveAs: (attachmentId) => ipcRenderer.invoke("attachments:saveAs", attachmentId),
    getPreviewUrl: (attachmentId) => ipcRenderer.invoke("attachments:getPreviewUrl", attachmentId),
  },
};

contextBridge.exposeInMainWorld("orchestrator", api);
