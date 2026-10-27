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
  autoUpdater.on("update-not-available", (info) =>
    notify?.({ type: "update-not-available", version: info?.version }),
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

// Manually trigger an update check (e.g. from the tray "Check for Updates…"
// item). The result of the check itself is surfaced through the same `notify`
// callback wired in initAutoUpdate (update-available / update-not-available /
// update-error). This returns whether the check could be STARTED, so the caller
// can give immediate feedback when updates aren't possible in this build.
async function checkForUpdates() {
  if (!autoUpdater) return { ok: false, reason: "unsupported" };
  if (process.env.NODE_ENV === "development") return { ok: false, reason: "dev" };
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "error", message: err?.message };
  }
}

function quitAndInstall() {
  if (autoUpdater) autoUpdater.quitAndInstall();
}

module.exports = { initAutoUpdate, checkForUpdates, quitAndInstall };
