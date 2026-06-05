// Task #1742 — desktop app local configuration store.
// Non-secret settings live here (sync folder, interval, selected clients).
// Credentials (the session token/cookie) are stored in the OS keychain — see keychain.js.
const Conf = require("conf");
const os = require("os");
const path = require("path");

const config = new Conf({ projectName: "em-desktop" });

function getDeviceId() {
  let deviceId = config.get("deviceId");
  if (!deviceId) {
    deviceId = `${os.hostname()}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 11)}`;
    config.set("deviceId", deviceId);
  }
  return deviceId;
}

function getDefaultSyncFolder() {
  return path.join(os.homedir(), "EditingMachine", "Projects");
}

function getSyncFolder() {
  let folder = config.get("syncFolder");
  if (!folder) {
    folder = getDefaultSyncFolder();
    config.set("syncFolder", folder);
  }
  return folder;
}

module.exports = {
  config,
  getDeviceId,
  getDefaultSyncFolder,
  getSyncFolder,
};
