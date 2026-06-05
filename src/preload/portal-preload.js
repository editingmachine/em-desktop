// Task #1758 — local-proxy bridge injected into the portal window.
//
// The portal is the EXISTING web app loaded inside the desktop shell. This
// preload exposes a single, read-only question on `window.emProxy`:
//   "do you have a locally-synced all-intra proxy + keyframe index for this
//    asset?" → returns a playable `em-proxy://` URL + the parsed sidecar, or
//    null. The web side (client/src/lib/desktop-proxy-bridge.ts) treats every
//    null as a clean "fall back to the HLS Quick preview" signal.
//
// contextIsolation stays ON: nothing here leaks ipcRenderer or node into the
// page — only the two flat fields the web bridge contract reads.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("emProxy", {
  isAvailable: true,
  resolveLocalProxy: (assetId) =>
    ipcRenderer.invoke("em-proxy:resolve", assetId),
});
