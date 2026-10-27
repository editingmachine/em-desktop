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

// Task #2463 — latest per-asset download percentage (0-100), kept fresh from the
// engine's `progress` event so the portal can query/subscribe to a real number
// for the clip it's waiting on. Cleared when a sweep finishes (nothing syncing).
const assetSyncProgress = new Map();

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
  const release = engine?.acquireLocalRead?.(filePath);
  if (!release) return new Response(null, { status: 409 });
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    release();
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
    release();
    return new Response(null, {
      status: 416,
      headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
    });
  }

  if (parsed.kind === "range") {
    const { start, end } = parsed;
    const stream = fs.createReadStream(filePath, { start, end });
    stream.once("close", release);
    stream.once("error", release);
    const body = Readable.toWeb(stream);
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
  const stream = fs.createReadStream(filePath);
  stream.once("close", release);
  stream.once("error", release);
  const body = Readable.toWeb(stream);
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
const { deriveSyncState, SYNC_LABELS } = require("../shared/sync-state");
const { initAutoUpdate, checkForUpdates, quitAndInstall } = require("./updater");
// True while a user-initiated "Check for Updates…" is awaiting its result, so
// the auto-update notify handler knows to surface a dialog (the background
// 6-hourly check stays silent). A safety timer guarantees the flag can never
// stick true if no terminal update event ever arrives (e.g. an early click
// before listeners attach, or a dropped check), which would otherwise lock the
// menu item out permanently.
let manualCheckInProgress = false;
let manualCheckTimer = null;

function endManualCheck() {
  manualCheckInProgress = false;
  if (manualCheckTimer) {
    clearTimeout(manualCheckTimer);
    manualCheckTimer = null;
  }
}

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

// Derive the branded tray state from the engine. The actual rule lives in the
// shared sync-state module so the tray and the control window (Dashboard.tsx
// displayState) can never drift apart.
function trayState() {
  return deriveSyncState({
    signedIn: !!(engine && engine.token),
    state: engine?.state,
    paused: engine?.paused,
    filesPending: engine?.filesPending,
  });
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
  const label = SYNC_LABELS[trayState()] || SYNC_LABELS.idle;
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
    { label: "Check for Updates…", click: () => checkForUpdatesManual() },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
  ]);
}

// Tray "Check for Updates…" handler. Kicks off a check and gives the user
// immediate feedback. The actual result (available / up-to-date / error) is
// surfaced by the initAutoUpdate notify handler while manualCheckInProgress.
async function checkForUpdatesManual() {
  if (manualCheckInProgress) return;
  manualCheckInProgress = true;
  // Fail-safe: drop the flag after 60s even if no terminal event arrives.
  manualCheckTimer = setTimeout(endManualCheck, 60_000);
  const res = await checkForUpdates();
  if (!res.ok) {
    endManualCheck();
    const detail =
      res.reason === "dev"
        ? "Updates are disabled in development builds."
        : res.reason === "unsupported"
          ? "Automatic updates aren't available in this build."
          : res.message || "Couldn't check for updates right now. Please try again later.";
    await dialog.showMessageBox({
      type: res.reason === "error" ? "error" : "info",
      buttons: ["OK"],
      title: "Check for Updates",
      message: "Editing Machine Sync",
      detail,
    });
  }
}

function refreshTray() {
  if (!tray) return;
  const s = trayState();
  tray.setImage(trayIcon(s));
  tray.setToolTip(`Editing Machine Sync — ${SYNC_LABELS[s] || s}`);
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
  engine.on("progress", (p) => {
    controlWindow?.webContents.send("sync:progress", p);
    // Task #2463 — remember + forward the per-asset download percentage so the
    // portal (web app) can show a real "downloading NN%" number on the preview
    // overlay for the exact clip under the playhead. The control window keeps
    // reading the batch-level `p` above unchanged.
    const id = Number(p?.assetId);
    const pct = Number(p?.filePct);
    if (Number.isFinite(id) && id > 0 && Number.isFinite(pct)) {
      assetSyncProgress.set(id, Math.max(0, Math.min(100, Math.round(pct))));
      portalWindow?.webContents.send("em-proxy:sync-progress", { assetId: id, pct: assetSyncProgress.get(id) });
    }
  });
  // Task #2463 — a completed sweep means nothing is actively downloading, so
  // drop stale per-asset progress; a fresh sweep repopulates it.
  engine.on("status", (status) => {
    if (status?.state && status.state !== "syncing") assetSyncProgress.clear();
  });
  engine.on("error", (err) =>
    controlWindow?.webContents.send("sync:error", { message: err?.message }),
  );
  engine.on("local-paths-invalidated", () => proxyPathByAssetId.clear());
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
  // Task #1938 — return the SAME shape the live "status" event emits (incl. the
  // per-project breakdown) via the engine's single snapshot builder, so the
  // initial fetch and live updates never disagree.
  ipcMain.handle("sync:status", () => engine.getStatusSnapshot());
  ipcMain.handle("sync:proxy-first", async () => {
    if (!engine) return { enabled: false, version: 1, reason: "not_ready" };
    return engine.getProxyFirstConfig();
  });
  ipcMain.handle("sync:legacy-projects", async () => {
    if (!engine?.token) throw new Error("Sign in before identifying a legacy project folder");
    const manifest = await engine._json("GET", "/api/sync/manifest?version=2", null);
    if (manifest?.version !== 2 || manifest.complete !== true ||
        manifest.accountId !== engine.user?.id || !Array.isArray(manifest.projects)) {
      throw new Error("Unable to load authoritative projects; no files were changed");
    }
    return manifest.projects.map(({ projectId, projectCode, projectName }) =>
      ({ projectId, projectCode, projectName }));
  });
  ipcMain.handle("sync:map-legacy-directory", async (_event, projectId, confirmedProjectCode) => {
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof confirmedProjectCode !== "string") {
      throw new Error("Select a project and confirm its existing project number");
    }
    const root = path.resolve(cfg.getSyncFolder());
    const userId = engine.user?.id;
    const selected = await dialog.showOpenDialog({
      title: "Select the old project folder — not the client or sync root",
      defaultPath: root,
      properties: ["openDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    if (root !== path.resolve(cfg.getSyncFolder()) || userId !== engine.user?.id || !engine.token) {
      throw new Error("Account or sync folder changed. Select the folder again.");
    }
    const relative = path.relative(root, selected.filePaths[0]).split(path.sep).join("/");
    await engine.mapLegacyDirectory(projectId, relative, confirmedProjectCode);
    proxyPathByAssetId.clear();
    return { success: true };
  });

  ipcMain.handle("disk:info", () => getDiskUsage(cfg.getSyncFolder()));

  ipcMain.handle("settings:get", () => ({
    syncFolder: cfg.getSyncFolder(),
    syncInterval: cfg.config.get("syncInterval") || 5,
    autoStart: getAutoLaunch(),
    selectedClients: cfg.config.get("selectedClients") || [],
    cleanupRemoved: false,
    projectStorageNoticeAcknowledged: cfg.config.get("projectStorageNoticeAcknowledged") === true,
    apiBase: PORTAL_URL,
    usingKeychain: keychain.usingKeychain,
  }));
  ipcMain.handle("settings:update", (_e, s) => {
    if (s.syncInterval) cfg.config.set("syncInterval", Number(s.syncInterval));
    if (s.selectedClients) cfg.config.set("selectedClients", s.selectedClients);
    if (typeof s.autoStart === "boolean") setAutoLaunch(s.autoStart);
    if (typeof s.projectStorageNoticeAcknowledged === "boolean") {
      cfg.config.set("projectStorageNoticeAcknowledged", s.projectStorageNoticeAcknowledged);
    }
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

  // Task #2463 — pull the latest download percentage for an asset. Push events
  // (`em-proxy:sync-progress`) drive the smooth live update; this query is the
  // fallback so a surface mounting mid-download shows the current number
  // immediately. Returns null when nothing is downloading for that asset.
  ipcMain.handle("em-proxy:getSyncProgress", (_e, assetId) => {
    const id = Number(assetId);
    if (!Number.isFinite(id) || id <= 0) return null;
    const pct = assetSyncProgress.get(id);
    return typeof pct === "number" ? pct : null;
  });

  // Task #1766 — instant local scrub source: the all-intra progressive MP4
  // (frame-exact native <video> seeks, no sidecar). Returns the resolved
  // `scrubSource` so the preview monitor can show an honest indicator. Returns
  // null when nothing is synced yet (web falls back to the network preview).
  ipcMain.handle("em-proxy:resolveScrubSource", (_e, assetId) => {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return null;
      const resolved = engine?.resolveLocalScrubSource(id);
      if (!resolved || !resolved.filePath) return null;
      if (!engine.isLocalPathAvailable?.(resolved.filePath)) return null;
      proxyPathByAssetId.set(`${id}/intra`, resolved.filePath);
      return {
        proxyUrl: `em-proxy://asset/${id}/intra`,
        scrubSource: resolved.scrubSource,
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
      if (!filePath || !engine?.isLocalPathAvailable?.(filePath)) return new Response(null, { status: 404 });
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

      // Surface results of a user-initiated "Check for Updates…" via a dialog.
      // The background 6-hourly check leaves manualCheckInProgress false, so it
      // stays silent (only the update-downloaded prompt below fires for it).
      if (manualCheckInProgress) {
        if (evt?.type === "update-not-available") {
          endManualCheck();
          await dialog.showMessageBox({
            type: "info",
            buttons: ["OK"],
            title: "Check for Updates",
            message: "You're up to date.",
            detail: `Editing Machine Sync ${app.getVersion()} is the latest version.`,
          });
          return;
        }
        if (evt?.type === "update-available") {
          endManualCheck();
          await dialog.showMessageBox({
            type: "info",
            buttons: ["OK"],
            title: "Update available",
            message: `Editing Machine Sync ${evt.version || ""} is available.`.trim(),
            detail: "It's downloading now — you'll be prompted to restart once it's ready.",
          });
          // fall through: let the download continue.
        }
        if (evt?.type === "update-error") {
          endManualCheck();
          await dialog.showMessageBox({
            type: "error",
            buttons: ["OK"],
            title: "Check for Updates",
            message: "Couldn't check for updates",
            detail: evt.message || "Please try again later.",
          });
          return;
        }
      }

      // When a new version finishes downloading, prompt to restart & install.
      // (electron-updater also auto-installs on the next quit if they pick Later.)
      if (evt?.type === "update-downloaded") {
        // Clear any in-flight manual check (the download may finish without us
        // having observed update-available, e.g. an already-staged update).
        endManualCheck();
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
