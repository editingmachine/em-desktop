// Task #1742 — context bridge between the React renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("emSync", {
  // Auth
  login: (email, password) => ipcRenderer.invoke("auth:login", email, password),
  logout: () => ipcRenderer.invoke("auth:logout"),
  getSession: () => ipcRenderer.invoke("auth:session"),

  // Sync control
  startSync: () => ipcRenderer.invoke("sync:start"),
  pauseSync: () => ipcRenderer.invoke("sync:pause"),
  resumeSync: () => ipcRenderer.invoke("sync:resume"),
  syncNow: () => ipcRenderer.invoke("sync:now"),
  getStatus: () => ipcRenderer.invoke("sync:status"),

  // Disk + settings
  getDiskInfo: () => ipcRenderer.invoke("disk:info"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (s) => ipcRenderer.invoke("settings:update", s),
  chooseSyncFolder: () => ipcRenderer.invoke("app:chooseSyncFolder"),

  // App
  openSyncFolder: () => ipcRenderer.invoke("app:openSyncFolder"),
  openPortal: () => ipcRenderer.invoke("app:openPortal"),
  getVersion: () => ipcRenderer.invoke("app:version"),
  installUpdate: () => ipcRenderer.invoke("update:install"),

  // Events (main → renderer)
  onStatusUpdate: (cb) => ipcRenderer.on("status:update", (_e, s) => cb(s)),
  onProgress: (cb) => ipcRenderer.on("sync:progress", (_e, p) => cb(p)),
  onError: (cb) => ipcRenderer.on("sync:error", (_e, e) => cb(e)),
  onUpdateEvent: (cb) => ipcRenderer.on("update:event", (_e, e) => cb(e)),
});
