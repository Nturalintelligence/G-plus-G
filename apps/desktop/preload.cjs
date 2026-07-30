const { contextBridge, ipcRenderer } = require("electron");

const api = {
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (name) => ipcRenderer.invoke("projects:create", name),
    open: (id) => ipcRenderer.invoke("projects:open", id),
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
};

contextBridge.exposeInMainWorld("orchestrator", api);
