// Task #1742 — Electron main process.
//
// The desktop "shell" does two jobs:
//   1. Logs the user in and loads the EXISTING web portal in a desktop window
//      (no re-built editor — it just displays the portal the user already uses).
//   2. Runs the background file-sync daemon (daemon/sync-engine.js) and a system
//      tray with live status.
//
// It is intentionally decoupled from operator-station internals.
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  dialog,
  nativeImage,
  protocol,
  net,
} = require("electron");
const path = require("path");
const { pathToFileURL } = require("url");

// Task #1758 — the custom `em-proxy://` scheme that serves locally-synced
// proxy files to the portal's <video> element. Must be declared privileged
// BEFORE app `ready` so range requests / fetch work for scrubbing.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "em-proxy",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true,
      bypassCSP: true,
    },
  },
]);

// assetId → absolute on-disk proxy path, populated by `em-proxy:resolve` so
// the protocol handler never has to trust a renderer-supplied file path.
const proxyPathByAssetId = new Map();

function assetIdFromProxyUrl(rawUrl) {
  // em-proxy://asset/<assetId>
  try {
    const u = new URL(rawUrl);
    const id = Number((u.pathname || "").replace(/^\/+/, "").split("/")[0]);
    return Number.isFinite(id) && id > 0 ? id : null;
  } catch (_) {
    return null;
  }
}

const cfg = require("../daemon/config");
const keychain = require("../daemon/keychain");
const { getDiskUsage } = require("../daemon/disk");
const { SyncEngine, DEFAULT_API_BASE } = require("../daemon/sync-engine");
const { setAutoLaunch, getAutoLaunch } = require("./auto-launch");
const { initAutoUpdate, quitAndInstall } = require("./updater");

const PORTAL_URL = process.env.EM_PORTAL_URL || DEFAULT_API_BASE;

let controlWindow = null; // React renderer: login / dashboard / settings
let portalWindow = null; // the existing web portal
let tray = null;
let engine = null;
let isQuitting = false;

function assetPath(name) {
  return path.join(__dirname, "..", "..", "assets", name);
}

// Human labels for each branded tray state (renderer mirrors these).
const TRAY_LABELS = {
  idle: "Idle",
  synced: "Up to date",
  syncing: "Syncing…",
  paused: "Paused",
  error: "Sync error",
  offline: "Offline",
};

// The main process is the single source of truth for the state→icon mapping.
// Derive the branded tray state from the engine, adding a clear "up to date"
// state (synced, nothing pending) and an "offline" state (signed out).
function trayState() {
  if (!engine || !engine.token) return "offline";
  switch (engine.state) {
    case "error":
      return "error";
    case "paused":
      return "paused";
    case "syncing":
      return "syncing";
    default:
      return engine.filesSynced > 0 && engine.filesPending === 0 ? "synced" : "idle";
  }
}

function trayIcon(state) {
  const img = nativeImage.createFromPath(assetPath(`tray-${state}.png`));
  return img.isEmpty() ? nativeImage.createFromPath(assetPath("icon.png")) : img;
}

function createControlWindow() {
  if (controlWindow) {
    controlWindow.show();
    return controlWindow;
  }
  controlWindow = new BrowserWindow({
    width: 460,
    height: 640,
    resizable: false,
    show: false,
    title: "Editing Machine Sync",
    icon: assetPath("icon.png"),
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === "development") {
    controlWindow.loadURL("http://localhost:5173");
  } else {
    controlWindow.loadFile(path.join(__dirname, "..", "renderer", "dist", "index.html"));
  }

  controlWindow.once("ready-to-show", () => controlWindow.show());
  controlWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      controlWindow.hide();
    }
  });
  controlWindow.on("closed", () => (controlWindow = null));
  return controlWindow;
}

function openPortal() {
  if (portalWindow) {
    portalWindow.show();
    portalWindow.focus();
    return;
  }
  portalWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    title: "Editing Machine",
    icon: assetPath("icon.png"),
    backgroundColor: "#0f1115",
    webPreferences: {
      // Task #1758 — inject the read-only local-proxy bridge. contextIsolation
      // stays ON so only `window.emProxy` is exposed, never node/ipc.
      preload: path.join(__dirname, "..", "preload", "portal-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  portalWindow.loadURL(PORTAL_URL);
  portalWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      portalWindow.hide();
    }
  });
  portalWindow.on("closed", () => (portalWindow = null));
}

function buildTrayMenu() {
  const label = TRAY_LABELS[trayState()] || "Idle";
  return Menu.buildFromTemplate([
    { label: `Status: ${label}`, enabled: false },
    { type: "separator" },
    { label: "Open Portal", click: openPortal },
    { label: "Open Control Panel", click: createControlWindow },
    { label: "Open Sync Folder", click: () => shell.openPath(cfg.getSyncFolder()) },
    { type: "separator" },
    engine?.paused
      ? { label: "Resume Sync", click: () => engine.resume() }
      : { label: "Pause Sync", click: () => engine.pause() },
    { label: "Sync Now", click: () => engine?.syncOnce().catch(() => {}) },
    { type: "separator" },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  const s = trayState();
  tray.setImage(trayIcon(s));
  tray.setToolTip(`Editing Machine Sync — ${TRAY_LABELS[s] || s}`);
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(trayIcon(trayState()));
  tray.setToolTip("Editing Machine Sync");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => createControlWindow());
}

function wireEngine() {
  engine = new SyncEngine({ apiBase: PORTAL_URL, config: cfg, keychain, getDiskUsage });
  engine.on("status", (status) => {
    refreshTray();
    controlWindow?.webContents.send("status:update", status);
  });
  engine.on("progress", (p) => controlWindow?.webContents.send("sync:progress", p));
  engine.on("error", (err) =>
    controlWindow?.webContents.send("sync:error", { message: err?.message }),
  );
}

// ---- IPC bridge (see preload/index.js) ------------------------------------
function registerIpc() {
  ipcMain.handle("auth:login", async (_e, email, password) => {
    const user = await engine.login(email, password);
    engine.start();
    openPortal();
    return { success: true, user };
  });
  ipcMain.handle("auth:logout", async () => {
    await engine.logout();
    portalWindow?.close();
    return { success: true };
  });
  ipcMain.handle("auth:session", async () => {
    const ok = await engine.restoreSession();
    return { loggedIn: ok, user: engine.user };
  });

  ipcMain.handle("sync:start", () => { engine.start(); return true; });
  ipcMain.handle("sync:pause", () => { engine.pause(); return true; });
  ipcMain.handle("sync:resume", () => { engine.resume(); return true; });
  ipcMain.handle("sync:now", () => engine.syncOnce().then(() => true).catch(() => false));
  ipcMain.handle("sync:status", () => ({
    state: engine.state,
    paused: engine.paused,
    currentFile: engine.currentFile,
    filesSynced: engine.filesSynced,
    filesPending: engine.filesPending,
    user: engine.user,
  }));

  ipcMain.handle("disk:info", () => getDiskUsage(cfg.getSyncFolder()));

  ipcMain.handle("settings:get", () => ({
    syncFolder: cfg.getSyncFolder(),
    syncInterval: cfg.config.get("syncInterval") || 5,
    autoStart: getAutoLaunch(),
    selectedClients: cfg.config.get("selectedClients") || [],
    cleanupRemoved: cfg.config.get("cleanupRemoved") || false,
    apiBase: PORTAL_URL,
    usingKeychain: keychain.usingKeychain,
  }));
  ipcMain.handle("settings:update", (_e, s) => {
    if (s.syncInterval) cfg.config.set("syncInterval", Number(s.syncInterval));
    if (s.selectedClients) cfg.config.set("selectedClients", s.selectedClients);
    if (typeof s.cleanupRemoved === "boolean") cfg.config.set("cleanupRemoved", s.cleanupRemoved);
    if (typeof s.autoStart === "boolean") setAutoLaunch(s.autoStart);
    return true;
  });
  ipcMain.handle("app:chooseSyncFolder", async () => {
    const r = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    if (!r.canceled && r.filePaths[0]) {
      cfg.config.set("syncFolder", r.filePaths[0]);
      return r.filePaths[0];
    }
    return cfg.getSyncFolder();
  });
  ipcMain.handle("app:openSyncFolder", () => shell.openPath(cfg.getSyncFolder()));
  ipcMain.handle("app:openPortal", () => { openPortal(); return true; });
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("update:install", () => quitAndInstall());

  // Task #1758 — local-proxy bridge for the portal window. Returns a playable
  // `em-proxy://asset/<id>` URL + parsed keyframe-index sidecar, or null when
  // the asset isn't synced (web side falls back to the HLS Quick preview).
  ipcMain.handle("em-proxy:resolve", (_e, assetId) => {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return null;
      const resolved = engine?.resolveLocalProxyFile(id);
      if (!resolved || !resolved.filePath) return null;
      proxyPathByAssetId.set(id, resolved.filePath);
      return {
        proxyUrl: `em-proxy://asset/${id}`,
        keyframeIndex: resolved.keyframeIndex,
      };
    } catch (_) {
      return null;
    }
  });
}

// Single-instance lock so the tray app isn't launched twice.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => createControlWindow());

  app.whenReady().then(async () => {
    // macOS dock icon (packaged builds use the .icns bundle; this covers dev).
    if (process.platform === "darwin" && app.dock) {
      try {
        app.dock.setIcon(nativeImage.createFromPath(assetPath("icon.png")));
      } catch (_) {}
    }
    wireEngine();
    registerIpc();
    createTray();

    // Task #1758 — serve locally-synced proxy files over `em-proxy://`. The
    // renderer only ever holds an `em-proxy://asset/<id>` URL; we map it back
    // to the real path here (populated by `em-proxy:resolve`) and stream it
    // via net.fetch(file://) which honours HTTP range requests for seeking.
    protocol.handle("em-proxy", (request) => {
      const id = assetIdFromProxyUrl(request.url);
      const filePath = id ? proxyPathByAssetId.get(id) : null;
      if (!filePath) return new Response(null, { status: 404 });
      return net.fetch(pathToFileURL(filePath).toString(), {
        headers: request.headers,
      });
    });

    const restored = await engine.restoreSession();
    if (restored) {
      engine.start();
      // Started at login → stay in tray; otherwise surface the portal.
      if (!process.argv.includes("--hidden")) openPortal();
    } else {
      createControlWindow();
    }

    initAutoUpdate(async (evt) => {
      controlWindow?.webContents.send("update:event", evt);
      // When a new version finishes downloading, prompt to restart & install.
      // (electron-updater also auto-installs on the next quit if they pick Later.)
      if (evt?.type === "update-downloaded") {
        const { response } = await dialog.showMessageBox({
          type: "info",
          buttons: ["Restart now", "Later"],
          defaultId: 0,
          cancelId: 1,
          title: "Update ready",
          message: `Editing Machine Sync ${evt.version || ""} is ready to install.`.trim(),
          detail: "Restart the app now to finish updating.",
        });
        if (response === 0) {
          isQuitting = true;
          quitAndInstall();
        }
      }
    });
  });

  app.on("window-all-closed", (e) => {
    // Keep running in the tray; don't quit when windows close.
  });
  app.on("before-quit", () => {
    isQuitting = true;
    engine?.stop();
  });
}
