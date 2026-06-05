// Task #1742 — auto-update wiring via electron-updater.
// Publishes/feeds are configured in electron-builder.yml (provider: generic/github).
// Safe no-op in dev (electron-updater throws without a published feed).
let autoUpdater = null;
try {
  autoUpdater = require("electron-updater").autoUpdater;
} catch (_) {
  autoUpdater = null;
}

function initAutoUpdate(notify) {
  if (!autoUpdater) return;
  if (process.env.NODE_ENV === "development") return;

  autoUpdater.autoDownload = true;
  autoUpdater.on("update-available", (info) =>
    notify?.({ type: "update-available", version: info?.version }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    notify?.({ type: "update-downloaded", version: info?.version }),
  );
  autoUpdater.on("error", (err) =>
    notify?.({ type: "update-error", message: err?.message }),
  );

  try {
    autoUpdater.checkForUpdatesAndNotify();
    // Re-check every 6 hours.
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
  } catch (_) {}
}

function quitAndInstall() {
  if (autoUpdater) autoUpdater.quitAndInstall();
}

module.exports = { initAutoUpdate, quitAndInstall };
