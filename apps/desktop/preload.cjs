const { contextBridge, ipcRenderer, webUtils } = require("electron");

const api = {
  system: {
    preflight: () => ipcRenderer.invoke("system:preflight"),
    info: () => ipcRenderer.invoke("system:info"),
    openDataFolder: () => ipcRenderer.invoke("system:openDataFolder"),
    copyText: (text) => ipcRenderer.invoke("system:copyText", text),
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
    trashList: () => ipcRenderer.invoke("projects:trash:list"),
    trash: (ids) => ipcRenderer.invoke("projects:trash", ids),
    restore: (ids) => ipcRenderer.invoke("projects:restore", ids),
    deletePermanent: (ids) => ipcRenderer.invoke("projects:deletePermanent", ids),
  },
  provider: {
    login: (provider) => ipcRenderer.invoke("provider:login", provider),
    status: (provider) => ipcRenderer.invoke("provider:status", provider),
    openWebChat: (provider, conversationId) => ipcRenderer.invoke("provider:openWebChat", provider, conversationId),
    rebindConversation: (provider, conversationId) => ipcRenderer.invoke("provider:rebindConversation", provider, conversationId),
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
  window: {
    setTheme: (theme) => ipcRenderer.invoke("window:setTheme", theme),
    toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  },
  composerDraft: {
    get: (projectId) => ipcRenderer.invoke("composerDraft:get", projectId),
    save: (value) => ipcRenderer.invoke("composerDraft:save", value),
    clear: (projectId) => ipcRenderer.invoke("composerDraft:clear", projectId),
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
    stageClipboard: (projectId, messageId, bytes, mimeType, fileName) => {
      if (!(bytes instanceof Uint8Array)) throw new Error("Clipboard attachment must be Uint8Array");
      return ipcRenderer.invoke("attachments:stageClipboard", { projectId, messageId, bytes, mimeType, fileName });
    },
    listDraft: (projectId) => ipcRenderer.invoke("attachments:listDraft", { projectId }),
    retryDraft: (attachmentId) => ipcRenderer.invoke("attachments:retryDraft", attachmentId),
    removeDraft: (attachmentId) => ipcRenderer.invoke("attachments:removeDraft", attachmentId),
    open: (attachmentId) => ipcRenderer.invoke("attachments:open", attachmentId),
    saveAs: (attachmentId) => ipcRenderer.invoke("attachments:saveAs", attachmentId),
    retryArtifact: (attachmentId) => ipcRenderer.invoke("attachments:retryArtifact", attachmentId),
    createDerivedArtifact: (attachmentId) => ipcRenderer.invoke("attachments:createDerivedArtifact", attachmentId),
    openDiagnostics: () => ipcRenderer.invoke("attachments:openDiagnostics"),
  },
};

contextBridge.exposeInMainWorld("orchestrator", api);
