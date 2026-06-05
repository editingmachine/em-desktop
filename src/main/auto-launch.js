// Task #1742 — auto-start on system login.
// Uses Electron's built-in login-item settings (no extra dependency on win/mac).
const { app } = require("electron");

function setAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: true, // start minimized to tray
      args: ["--hidden"],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function getAutoLaunch() {
  try {
    return app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
}

module.exports = { setAutoLaunch, getAutoLaunch };
