import { contextBridge, ipcRenderer } from "electron";

const api = {
  projects: {
    list: () => ipcRenderer.invoke("projects:list"),
    create: (name: string) => ipcRenderer.invoke("projects:create", name),
    open: (id: string) => ipcRenderer.invoke("projects:open", id),
  },
  provider: {
    login: (provider: string) => ipcRenderer.invoke("provider:login", provider),
    send: (provider: string, message: string) =>
      ipcRenderer.invoke("provider:send", provider, message),
  },
  orchestration: {
    run: (input: unknown) => ipcRenderer.invoke("orchestration:run", input),
    pause: () => ipcRenderer.invoke("orchestration:pause"),
    resume: () => ipcRenderer.invoke("orchestration:resume"),
    stop: () => ipcRenderer.invoke("orchestration:stop"),
  },
  state: {
    latest: (projectId: string) => ipcRenderer.invoke("state:latest", projectId),
    save: (projectId: string, state: unknown) =>
      ipcRenderer.invoke("state:save", projectId, state),
    approve: (id: string) => ipcRenderer.invoke("state:approve", id),
  },
  exports: {
    spec: (projectId: string) => ipcRenderer.invoke("export:spec", projectId),
  },
};

contextBridge.exposeInMainWorld("orchestrator", api);
