// Task #1758 — local-proxy bridge injected into the portal window.
//
// The portal is the EXISTING web app loaded inside the desktop shell. This
// preload exposes a single, read-only question on `window.emProxy`:
//   "do you have a locally-synced all-intra scrub source for this asset?" →
//    returns a playable `em-proxy://` URL + the resolved `scrubSource`, or
//    null. The web side (client/src/lib/desktop-proxy-bridge.ts) treats every
//    null as a clean "fall back to the HLS Quick preview" signal.
//
// contextIsolation stays ON: nothing here leaks ipcRenderer or node into the
// page — only the flat fields the web bridge contract reads.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("emProxy", {
  isAvailable: true,
  // Task #1766 — local scrub source: the all-intra MP4 when synced. Reports
  // which source resolved so the preview monitor can show an honest indicator.
  resolveLocalScrubSource: (assetId) =>
    ipcRenderer.invoke("em-proxy:resolveScrubSource", assetId),
  // Task #1920 — ask the daemon to fetch this asset's proxy right now (a clip
  // was just added to the timeline). Fire-and-forget + coalesced in main.
  triggerImmediateSync: (assetId) =>
    ipcRenderer.invoke("em-proxy:triggerImmediateSync", assetId),
  // Task #2463 — real download progress for the clip the preview is waiting on.
  // `getSyncProgress` pulls the latest percentage (0-100, or null when not
  // downloading); `onSyncProgress` pushes live per-asset updates so the overlay
  // shows a smooth, honest number instead of a generic "downloading" message.
  // The subscribe wrapper returns an unsubscribe fn and never leaks ipcRenderer.
  getSyncProgress: (assetId) =>
    ipcRenderer.invoke("em-proxy:getSyncProgress", assetId),
  onSyncProgress: (cb) => {
    const handler = (_e, payload) => {
      try {
        cb(payload);
      } catch (_) {
        /* a subscriber throwing must never break the IPC channel */
      }
    };
    ipcRenderer.on("em-proxy:sync-progress", handler);
    return () => ipcRenderer.removeListener("em-proxy:sync-progress", handler);
  },
});
