// Single source of truth for the desktop sync UI state machine.
//
// The tray status dot (main process, `trayState()` in src/main/index.js) and
// the control window (renderer, `displayState()` in pages/Dashboard.tsx) both
// need to turn the raw sync-engine state into one branded logical state. They
// used to do this in two separate places and drifted apart (the tray showed
// grey "idle" on a fresh/empty account while the window read green "all
// complete"). Both now derive from this one function so they can't diverge.
//
// Plain CommonJS so the Electron main process (no build step) can `require()`
// it at runtime; the TypeScript renderer imports the same file through Vite.

// Ordered by precedence (highest first), which is also the order the rules are
// evaluated below.
const SYNC_STATES = ["offline", "error", "paused", "syncing", "idle", "synced"];

/**
 * Derive the branded logical sync state from a normalized engine snapshot.
 *
 * @param {Object|null|undefined} input
 * @param {boolean} [input.signedIn]    true when a session/token is present.
 * @param {string}  [input.state]       raw engine state: idle|syncing|paused|error.
 * @param {boolean} [input.paused]      true when the user paused sync.
 * @param {number}  [input.filesPending] count of files still queued to download.
 * @returns {"offline"|"error"|"paused"|"syncing"|"idle"|"synced"}
 */
function deriveSyncState(input) {
  if (!input || !input.signedIn) return "offline";
  if (input.state === "error") return "error";
  if (input.paused || input.state === "paused") return "paused";
  if (input.state === "syncing") return "syncing";
  // Resting state: green "synced" is the default whenever there's no pending
  // work — including a fresh/empty account with nothing to sync. Grey "idle" is
  // reserved for the honest in-between: files are still queued but nothing is
  // actively downloading at this instant.
  return (input.filesPending || 0) > 0 ? "idle" : "synced";
}

// Single source of truth for the human-readable label of each branded state.
// The tray tooltip/menu (main process) and the control window header (renderer)
// both render these so their wording can never drift (they used to disagree:
// window "All complete"/"Pending" vs tray "Up to date"/"Idle").
const SYNC_LABELS = {
  offline: "Offline",
  idle: "Pending",
  synced: "Up to date",
  syncing: "Syncing…",
  paused: "Paused",
  error: "Sync error",
};

module.exports = { deriveSyncState, SYNC_STATES, SYNC_LABELS };
