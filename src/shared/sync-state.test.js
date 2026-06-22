// Regression net for Task #1945 — the desktop tray status dot (main process
// `trayState()`) and the control window (renderer `displayState()`) must always
// derive the SAME logical sync state. They live in two files and once drifted
// apart by hand (tray grey while window green on a fresh/empty account). Both
// now route through `deriveSyncState`; this test re-implements each call site's
// thin adapter and asserts they agree across every engine state combination.
//
// Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { deriveSyncState, SYNC_STATES } = require("./sync-state");

// Mirror of main/index.js trayState(): builds the shared input from the engine.
function trayState(engine) {
  return deriveSyncState({
    signedIn: !!(engine && engine.token),
    state: engine?.state,
    paused: engine?.paused,
    filesPending: engine?.filesPending,
  });
}

// Mirror of Dashboard.tsx displayState(): builds the shared input from the
// SyncStatus snapshot the renderer receives over IPC.
function displayState(status) {
  return deriveSyncState({
    signedIn: !!status,
    state: status?.state,
    paused: status?.paused,
    filesPending: status?.filesPending,
  });
}

// One scenario = an engine snapshot + the equivalent renderer SyncStatus, plus
// the logical state we expect BOTH derivations to land on.
const SCENARIOS = [
  {
    name: "offline (signed out / no engine)",
    engine: null,
    status: null,
    expected: "offline",
  },
  {
    name: "offline (engine present but no token)",
    engine: { token: null, state: "idle", paused: false, filesPending: 0 },
    status: null,
    expected: "offline",
  },
  {
    name: "error",
    engine: { token: "t", state: "error", paused: false, filesPending: 3 },
    status: { state: "error", paused: false, filesPending: 3 },
    expected: "error",
  },
  {
    name: "paused via state",
    engine: { token: "t", state: "paused", paused: false, filesPending: 5 },
    status: { state: "paused", paused: false, filesPending: 5 },
    expected: "paused",
  },
  {
    name: "paused via flag",
    engine: { token: "t", state: "idle", paused: true, filesPending: 5 },
    status: { state: "idle", paused: true, filesPending: 5 },
    expected: "paused",
  },
  {
    name: "error wins over paused",
    engine: { token: "t", state: "error", paused: true, filesPending: 1 },
    status: { state: "error", paused: true, filesPending: 1 },
    expected: "error",
  },
  {
    name: "syncing",
    engine: { token: "t", state: "syncing", paused: false, filesPending: 4 },
    status: { state: "syncing", paused: false, filesPending: 4 },
    expected: "syncing",
  },
  {
    name: "paused wins over syncing",
    engine: { token: "t", state: "syncing", paused: true, filesPending: 4 },
    status: { state: "syncing", paused: true, filesPending: 4 },
    expected: "paused",
  },
  {
    name: "idle with files pending (queued, nothing downloading)",
    engine: { token: "t", state: "idle", paused: false, filesPending: 2 },
    status: { state: "idle", paused: false, filesPending: 2 },
    expected: "idle",
  },
  {
    name: "synced — fresh/empty account (pending 0, nothing ever synced)",
    engine: { token: "t", state: "idle", paused: false, filesPending: 0, filesSynced: 0 },
    status: { state: "idle", paused: false, filesPending: 0, filesSynced: 0 },
    expected: "synced",
  },
  {
    name: "synced — work finished (pending 0, files synced)",
    engine: { token: "t", state: "idle", paused: false, filesPending: 0, filesSynced: 12 },
    status: { state: "idle", paused: false, filesPending: 0, filesSynced: 12 },
    expected: "synced",
  },
];

test("tray and window agree on every engine state combination", () => {
  for (const sc of SCENARIOS) {
    const tray = trayState(sc.engine);
    const window = displayState(sc.status);
    assert.equal(
      tray,
      window,
      `tray (${tray}) and window (${window}) disagree for: ${sc.name}`
    );
    assert.equal(tray, sc.expected, `unexpected logical state for: ${sc.name}`);
  }
});

test("every derived state is a known SYNC_STATES value", () => {
  for (const sc of SCENARIOS) {
    assert.ok(
      SYNC_STATES.includes(trayState(sc.engine)),
      `tray produced unknown state for: ${sc.name}`
    );
    assert.ok(
      SYNC_STATES.includes(displayState(sc.status)),
      `window produced unknown state for: ${sc.name}`
    );
  }
});

// Structural guard: the two real call sites MUST route through the shared
// module. Their bodies can't be require()'d here (Electron/React imports), so
// assert at the source level that neither re-implements the state machine.
test("both real call sites delegate to deriveSyncState (no re-implementation)", () => {
  const mainSrc = fs.readFileSync(
    path.join(__dirname, "..", "main", "index.js"),
    "utf8"
  );
  const dashSrc = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "pages", "Dashboard.tsx"),
    "utf8"
  );

  for (const [label, src] of [["main/index.js", mainSrc], ["Dashboard.tsx", dashSrc]]) {
    assert.match(
      src,
      /deriveSyncState/,
      `${label} no longer imports/uses deriveSyncState — the tray and window can drift again`
    );
  }

  // The trayState()/displayState() bodies should be thin adapters, not contain
  // the precedence ladder themselves. If a future edit inlines the rule, the
  // tell-tale resting-state expression reappears in a call site.
  const inlinedRule = /filesPending\s*>\s*0\s*\?/;
  assert.doesNotMatch(
    mainSrc,
    inlinedRule,
    "main/index.js re-implements the filesPending rule instead of using deriveSyncState"
  );
  assert.doesNotMatch(
    dashSrc,
    inlinedRule,
    "Dashboard.tsx re-implements the filesPending rule instead of using deriveSyncState"
  );
});

test("filesPending===0 maps to synced regardless of filesSynced", () => {
  // The original drift: a fresh account (filesSynced 0) must NOT read grey
  // "idle" while a finished account (filesSynced > 0) reads green.
  const fresh = displayState({ state: "idle", paused: false, filesPending: 0, filesSynced: 0 });
  const finished = displayState({ state: "idle", paused: false, filesPending: 0, filesSynced: 9 });
  assert.equal(fresh, "synced");
  assert.equal(finished, "synced");
  assert.equal(fresh, finished);
});
