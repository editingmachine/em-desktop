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
} = require("electron");
const path = require("path");
const fs = require("fs");
const { Readable } = require("stream");
const { parseRange, contentTypeForPath } = require("./range");

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

// assetId/variant → absolute on-disk proxy path, populated by
// `em-proxy:resolveScrubSource` so the protocol handler never has to trust a
// renderer-supplied file path.
const proxyPathByAssetId = new Map();

// Lookup key for `proxyPathByAssetId`. The Task #1766 scrub-source URL carries
// a variant segment `em-proxy://asset/<id>/<variant>` (key `<id>/<variant>`) so
// the all-intra and progressive files for the SAME asset never collide.
function proxyKeyFromProxyUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const key = (u.pathname || "").replace(/^\/+/, "");
    const id = Number(key.split("/")[0]);
    if (!Number.isFinite(id) || id <= 0) return null;
    return key;
  } catch (_) {
    return null;
  }
}

// Serve a local file over `em-proxy://` with HTTP Range support so the portal's
// off-DOM <video> can seek within a clip. Returns 206 for a satisfiable range,
// 200 for the whole file (still advertising Accept-Ranges), 416 for an
// unsatisfiable range, or 404 if the file is gone.
function serveLocalFileWithRange(filePath, rangeHeader) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return new Response(null, { status: 404 });
  }
  const total = stat.size;
  const baseHeaders = {
    "Content-Type": contentTypeForPath(filePath),
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  const parsed = parseRange(total, rangeHeader);

  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }

  if (parsed.kind === "range") {
    const { start, end } = parsed;
    const body = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
    return new Response(body, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  // Whole file.
  const body = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(body, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
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
  // In a packaged build the assets folder is copied via electron-builder
  // `extraResources` into <app>/resources/assets (process.resourcesPath). In dev
  // it lives at desktop-app/assets, two levels up from src/main. Resolving the
  // wrong base ships a build whose tray/window icons are missing -> blank,
  // invisible system-tray icon.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, "assets")
    : path.join(__dirname, "..", "..", "assets");
  return path.join(base, name);
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

  // Task #1920 — trigger-based proxy sync. The portal calls this the moment a
  // clip's asset is needed on the timeline but isn't on disk yet, so the daemon
  // fetches just that asset's proxy immediately instead of waiting for the next
  // slow sweep. Fire-and-forget + coalesced inside the engine; safe no-op when
  // signed out.
  ipcMain.handle("em-proxy:triggerImmediateSync", (_e, assetId) => {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return false;
      if (!engine || !engine.token) return false;
      engine.syncAsset(id).catch(() => {});
      return true;
    } catch (_) {
      return false;
    }
  });

  // Task #1766 — instant local scrub source. Prefers the all-intra progressive
  // MP4 (frame-exact native <video> seeks, no sidecar) and falls back to the
  // existing progressive proxy + keyframe-index. Returns the resolved
  // `scrubSource` so the preview monitor can show an honest indicator. Returns
  // null when nothing is synced yet (web falls back to the network preview).
  ipcMain.handle("em-proxy:resolveScrubSource", (_e, assetId) => {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return null;
      const resolved = engine?.resolveLocalScrubSource(id);
      if (!resolved || !resolved.filePath) return null;
      const variant = resolved.scrubSource === "all-intra" ? "intra" : "progressive";
      proxyPathByAssetId.set(`${id}/${variant}`, resolved.filePath);
      return {
        proxyUrl: `em-proxy://asset/${id}/${variant}`,
        scrubSource: resolved.scrubSource,
        keyframeIndex: resolved.keyframeIndex ?? null,
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
    // renderer only ever holds an `em-proxy://asset/<id>/<variant>` URL; we map
    // it back to the real path here (populated by `em-proxy:resolveScrubSource`)
    // and serve it ourselves WITH HTTP Range support.
    //
    // Why we read the byte slice by hand instead of forwarding to
    // net.fetch(file://): the portal compositor decodes frames by seeking an
    // off-DOM <video> to the requested time. A <video> can only SEEK within a
    // file if the response honours `Range` (206 + Content-Range + Accept-Ranges).
    // Forwarding to net.fetch(file://) does NOT reliably translate the incoming
    // Range header into a partial read — it hands back the whole file (200), so
    // the element can load each clip's FIRST frame but can never move inside the
    // clip. That collapsed every in-clip scrub position and every realtime
    // playback tick onto frame 0 — the "one frozen still per clip" bug. Reading
    // the slice with fs guarantees correct 206 partial responses on every OS.
    protocol.handle("em-proxy", (request) => {
      const key = proxyKeyFromProxyUrl(request.url);
      const filePath = key ? proxyPathByAssetId.get(key) : null;
      if (!filePath) return new Response(null, { status: 404 });
      return serveLocalFileWithRange(filePath, request.headers.get("range"));
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
