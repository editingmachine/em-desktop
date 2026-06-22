// Task #1920 — daemon-level coverage for trigger-based per-asset sync and, most
// importantly, the shared single-flight guarantee: a file is NEVER downloaded
// twice concurrently, whether the two requests come from two triggers or from
// the periodic sweep overlapping a trigger.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SyncEngine } from "./sync-engine.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEngine() {
  const store = new Map([["selectedClients", []]]);
  const config = {
    config: {
      get: (k) => store.get(k),
      set: (k, v) => store.set(k, v),
      delete: (k) => store.delete(k),
    },
    getSyncFolder: () => "/tmp/em-sync-test-1920",
  };
  const engine = new SyncEngine({
    apiBase: "http://test.local",
    config,
    keychain: {},
    getDiskUsage: async () => ({}),
  });
  engine.token = "test-token";

  // Manifest with ONE asset (id 7) that has TWO derivative files.
  const manifest = {
    files: [
      { id: 7, name: "a.mp4", relativePath: "a.mp4", size: 100, clientId: 1 },
      { id: 7, name: "a.scrub.mp4", relativePath: "a.scrub.mp4", size: 50, clientId: 1 },
    ],
  };

  engine._json = vi.fn(async (method, route) => {
    if (route === "/api/sync/manifest") return manifest;
    if (route.endsWith("/complete")) return {};
    if (route.startsWith("/api/sync/download/")) return { url: `http://files/${route}` };
    return {};
  });

  // Mock the actual byte transfer: slow enough that a second concurrent call
  // would overlap if single-flight were broken. Counts calls per destination.
  const downloadCalls = new Map();
  engine._download = vi.fn(async (_url, destPath) => {
    downloadCalls.set(destPath, (downloadCalls.get(destPath) || 0) + 1);
    await delay(40);
  });

  return { engine, downloadCalls };
}

describe("SyncEngine trigger-based per-asset sync (Task #1920)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("downloads only the requested asset's files via syncAsset", async () => {
    const { engine, downloadCalls } = makeEngine();
    const res = await engine.syncAsset(7);
    expect(res.downloaded).toBe(2);
    expect(downloadCalls.size).toBe(2); // both derivatives of asset 7
  });

  it("ignores invalid ids and no-ops when signed out / paused", async () => {
    const { engine, downloadCalls } = makeEngine();
    expect((await engine.syncAsset(0)).downloaded).toBe(0);
    expect((await engine.syncAsset("nope")).downloaded).toBe(0);

    engine.token = null;
    expect((await engine.syncAsset(7)).downloaded).toBe(0);
    engine.token = "test-token";
    engine.paused = true;
    expect((await engine.syncAsset(7)).downloaded).toBe(0);

    expect(downloadCalls.size).toBe(0);
  });

  it("coalesces rapid repeated triggers for the same asset into one download per file", async () => {
    const { engine, downloadCalls } = makeEngine();
    const [a, b] = await Promise.all([engine.syncAsset(7), engine.syncAsset(7)]);
    // Same in-flight promise → identical result object.
    expect(a).toBe(b);
    // Each file fetched exactly once despite two concurrent triggers.
    for (const count of downloadCalls.values()) expect(count).toBe(1);
    expect(downloadCalls.size).toBe(2);
  });

  it("never downloads the same file twice when the sweep and a trigger overlap", async () => {
    const { engine, downloadCalls } = makeEngine();
    // Kick the periodic sweep AND an on-demand trigger for the same asset at the
    // same time — the shared per-destination single-flight must collapse the
    // overlapping fetches so each file is pulled exactly once.
    const sweep = engine.syncOnce();
    const trigger = engine.syncAsset(7);
    const [sweepRes] = await Promise.all([sweep, trigger]);

    expect(sweepRes.downloaded).toBeGreaterThan(0);
    for (const count of downloadCalls.values()) expect(count).toBe(1);
    expect(downloadCalls.size).toBe(2); // a.mp4 + a.scrub.mp4, each once
  });
});

// Task #1938 — per-project breakdown grouping + status snapshot shape.
describe("SyncEngine per-project breakdown (Task #1938)", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  function makeBreakdownEngine() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-1938-"));
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) },
      getSyncFolder: () => root,
    };
    const engine = new SyncEngine({ apiBase: "http://test.local", config, keychain: {}, getDiskUsage: async () => ({}) });
    engine.token = "test-token";

    // Two projects: Alpha (2 files, 1 already on disk) + Beta (1 file, pending).
    const manifest = {
      files: [
        { id: 1, name: "a1.mp4", relativePath: "alpha/a1.mp4", size: 10, clientId: 1, projectName: "Alpha" },
        { id: 2, name: "a2.mp4", relativePath: "alpha/a2.mp4", size: 10, clientId: 1, projectName: "Alpha" },
        { id: 3, name: "b1.mp4", relativePath: "beta/b1.mp4", size: 10, clientId: 1, projectName: "Beta" },
      ],
    };
    // Pre-place alpha/a1.mp4 on disk at the right size so it counts as local.
    fs.mkdirSync(path.join(root, "alpha"), { recursive: true });
    fs.writeFileSync(path.join(root, "alpha", "a1.mp4"), Buffer.alloc(10));

    engine._json = vi.fn(async (method, route) => {
      if (route === "/api/sync/manifest") return manifest;
      if (route.endsWith("/complete")) return {};
      if (route.startsWith("/api/sync/download/")) return { url: `http://files/${route}` };
      return {};
    });
    // Actually write the bytes so the breakdown re-stat sees them as local.
    engine._download = vi.fn(async (_url, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.alloc(10));
    });
    return { engine, root };
  }

  it("groups manifest files by project with correct local vs pending counts", async () => {
    const { engine } = makeBreakdownEngine();
    await engine.syncOnce();
    const snap = engine.getStatusSnapshot();
    const alpha = snap.projects.find((p) => p.projectName === "Alpha");
    const beta = snap.projects.find((p) => p.projectName === "Beta");

    expect(alpha).toMatchObject({ totalFiles: 2 });
    expect(beta).toMatchObject({ totalFiles: 1 });
    // After a full sweep everything is on disk → all local, none pending.
    expect(alpha.localFiles).toBe(2);
    expect(alpha.pendingFiles).toBe(0);
    expect(beta.localFiles).toBe(1);
    expect(beta.pendingFiles).toBe(0);
    // Rows are alphabetically stable.
    expect(snap.projects.map((p) => p.projectName)).toEqual(["Alpha", "Beta"]);
  });

  it("counts a pre-existing file as local before any download runs", () => {
    const { engine } = makeBreakdownEngine();
    // Seed lastFiles as a fresh manifest would, then recompute without syncing.
    engine.lastFiles = [
      { id: 1, name: "a1.mp4", relativePath: "alpha/a1.mp4", size: 10, projectName: "Alpha" },
      { id: 2, name: "a2.mp4", relativePath: "alpha/a2.mp4", size: 10, projectName: "Alpha" },
      { id: 3, name: "b1.mp4", relativePath: "beta/b1.mp4", size: 10, projectName: "Beta" },
    ];
    engine._recomputeProjectBreakdown();
    const alpha = engine.projectBreakdown.find((p) => p.projectName === "Alpha");
    const beta = engine.projectBreakdown.find((p) => p.projectName === "Beta");
    expect(alpha).toEqual({ projectName: "Alpha", localFiles: 1, pendingFiles: 1, totalFiles: 2 });
    expect(beta).toEqual({ projectName: "Beta", localFiles: 0, pendingFiles: 1, totalFiles: 1 });
  });

  it("marks exactly the in-flight project active, and clears it once idle", () => {
    const { engine } = makeBreakdownEngine();
    engine.projectBreakdown = [
      { projectName: "Alpha", localFiles: 0, pendingFiles: 1, totalFiles: 1 },
      { projectName: "Beta", localFiles: 0, pendingFiles: 1, totalFiles: 1 },
    ];
    engine.state = "syncing";
    engine.currentProject = "Beta";
    let snap = engine.getStatusSnapshot();
    expect(snap.projects.find((p) => p.projectName === "Beta").active).toBe(true);
    expect(snap.projects.find((p) => p.projectName === "Alpha").active).toBe(false);

    // Going idle clears the active marker even if currentProject lingers.
    engine.state = "idle";
    snap = engine.getStatusSnapshot();
    expect(snap.projects.every((p) => p.active === false)).toBe(true);
  });

  it("reports an empty breakdown when there is nothing to sync", () => {
    const { engine } = makeBreakdownEngine();
    engine.lastFiles = [];
    engine._recomputeProjectBreakdown();
    const snap = engine.getStatusSnapshot();
    expect(snap.projects).toEqual([]);
  });
});
