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

// One bad file (e.g. a missing/expired S3 object that 403s, or a transient
// network blip) must NEVER halt the whole sweep — every OTHER file still needs
// to download. This is the fix for the "stuck at N of M files, pending forever"
// wedge where the sync died behind the first failing file.
describe("SyncEngine sweep resilience to a single failing file", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  function makeEngineWithBadFile() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-resilience-"));
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) },
      getSyncFolder: () => root,
    };
    // downloadRetryBaseMs:0 keeps the Task #2164 retry backoff instant so the
    // persistently-failing bad file (retried then given up on) doesn't slow the
    // test; _sleep is also stubbed defensively.
    const engine = new SyncEngine({ apiBase: "http://test.local", config, keychain: {}, getDiskUsage: async () => ({}), downloadRetryBaseMs: 0 });
    engine.token = "test-token";
    engine._sleep = async () => {};

    // Three files; the MIDDLE one's bytes transfer always fails (like a 403 on
    // a missing S3 object). Before the fix this aborted the whole for-loop and
    // left file #3 pending forever. Post-#2164 the 403 is retried a few times
    // (fresh URL each attempt) and, still failing, the file stays honestly
    // pending — the sweep never wedges.
    const manifest = {
      files: [
        { id: 1, name: "ok1.mp3", relativePath: "ok1.mp3", size: 10, clientId: 1, projectName: "P" },
        { id: 2, name: "bad.mp3", relativePath: "bad.mp3", size: 10, clientId: 1, projectName: "P" },
        { id: 3, name: "ok3.mp3", relativePath: "ok3.mp3", size: 10, clientId: 1, projectName: "P" },
      ],
    };
    engine._json = vi.fn(async (method, route) => {
      if (route === "/api/sync/manifest") return manifest;
      if (route.endsWith("/complete")) return {};
      if (route.startsWith("/api/sync/download/")) return { url: `http://files/${route}` };
      return {};
    });
    engine._download = vi.fn(async (_url, destPath) => {
      if (destPath.endsWith("bad.mp3")) throw new Error("HTTP 403");
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.alloc(10));
    });
    return { engine, root };
  }

  it("downloads every healthy file and skips only the bad one (no wedge)", async () => {
    const { engine, root } = makeEngineWithBadFile();
    const res = await engine.syncOnce();

    // The two good files downloaded; the bad one did NOT halt the sweep.
    expect(res.downloaded).toBe(2);
    expect(fs.existsSync(path.join(root, "ok1.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(root, "ok3.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(root, "bad.mp3"))).toBe(false);

    // Sweep ended cleanly (not stuck in an error state), and the breakdown
    // honestly shows 2 local / 1 pending instead of wedging at 0.
    expect(engine.state).toBe("idle");
    const p = engine.getStatusSnapshot().projects.find((x) => x.projectName === "P");
    expect(p).toMatchObject({ totalFiles: 3, localFiles: 2, pendingFiles: 1 });
  });

  it("treats a missing presigned URL ('no-url') as a skipped failure, not a silent success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-nourl-"));
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) },
      getSyncFolder: () => root,
    };
    const engine = new SyncEngine({ apiBase: "http://test.local", config, keychain: {}, getDiskUsage: async () => ({}) });
    engine.token = "test-token";

    const manifest = {
      files: [
        { id: 1, name: "ok.mp3", relativePath: "ok.mp3", size: 10, clientId: 1, projectName: "P" },
        { id: 2, name: "nourl.mp3", relativePath: "nourl.mp3", size: 10, clientId: 1, projectName: "P" },
      ],
    };
    engine._json = vi.fn(async (method, route) => {
      if (route === "/api/sync/manifest") return manifest;
      if (route.endsWith("/complete")) return {};
      // Asset 2's download endpoint returns no url (e.g. asset has no stored file).
      if (route.startsWith("/api/sync/download/2")) return {};
      if (route.startsWith("/api/sync/download/")) return { url: `http://files/${route}` };
      return {};
    });
    engine._download = vi.fn(async (_url, destPath) => {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.alloc(10));
    });

    const res = await engine.syncOnce();
    expect(res.downloaded).toBe(1);
    expect(fs.existsSync(path.join(root, "ok.mp3"))).toBe(true);
    expect(fs.existsSync(path.join(root, "nourl.mp3"))).toBe(false);
    expect(engine.state).toBe("idle");
    const p = engine.getStatusSnapshot().projects.find((x) => x.projectName === "P");
    expect(p).toMatchObject({ totalFiles: 2, localFiles: 1, pendingFiles: 1 });
  });
});

// Task #2164 — Dropbox-grade download reliability: retry-with-backoff on
// transient failures (fresh presigned URL each attempt), post-download integrity
// verification, and unknown-size handling so a 0/missing-size file isn't
// re-downloaded on every sweep.
describe("SyncEngine download reliability (Task #2164)", () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const http = require("http");

  function makeEngine(manifestFiles, downloadImpl) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-2164-"));
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) },
      getSyncFolder: () => root,
    };
    const engine = new SyncEngine({
      apiBase: "http://test.local",
      config,
      keychain: {},
      getDiskUsage: async () => ({}),
      downloadRetryBaseMs: 0,
    });
    engine.token = "test-token";
    engine._sleep = vi.fn(async () => {}); // instant backoff in tests
    let urlFetches = 0;
    engine._json = vi.fn(async (method, route) => {
      if (route === "/api/sync/manifest") return { files: manifestFiles };
      if (route.endsWith("/complete")) return {};
      if (route.startsWith("/api/sync/download/")) {
        urlFetches++;
        return { url: `http://files${route}?sig=${urlFetches}` };
      }
      return {};
    });
    engine._download = vi.fn(downloadImpl);
    return { engine, root, getUrlFetches: () => urlFetches };
  }

  it("retries a transient failure and succeeds without waiting for the next sweep (fresh URL each attempt)", async () => {
    let calls = 0;
    const { engine, root, getUrlFetches } = makeEngine(
      [{ id: 1, name: "ok.mp4", relativePath: "ok.mp4", size: 10, clientId: 1, projectName: "P" }],
      async (_url, destPath) => {
        calls++;
        if (calls === 1) throw new Error("HTTP 503"); // transient
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, Buffer.alloc(10));
      },
    );

    const res = await engine.syncOnce();

    expect(calls).toBe(2); // failed once, succeeded on retry
    expect(getUrlFetches()).toBe(2); // a FRESH presigned URL per attempt
    expect(engine._sleep).toHaveBeenCalledTimes(1); // backed off once
    expect(res.downloaded).toBe(1);
    expect(fs.existsSync(path.join(root, "ok.mp4"))).toBe(true);
    const p = engine.getStatusSnapshot().projects.find((x) => x.projectName === "P");
    expect(p).toMatchObject({ totalFiles: 1, localFiles: 1, pendingFiles: 0 });
  });

  it("rejects a wrong-size download, discards it, and re-fetches until the bytes match", async () => {
    let calls = 0;
    const { engine, root } = makeEngine(
      [{ id: 1, name: "v.mp4", relativePath: "v.mp4", size: 10, clientId: 1, projectName: "P" }],
      async (_url, destPath) => {
        calls++;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        // First attempt lands a truncated file; second lands the full file.
        fs.writeFileSync(destPath, Buffer.alloc(calls === 1 ? 5 : 10));
      },
    );

    const res = await engine.syncOnce();

    expect(calls).toBe(2); // truncated file rejected + re-fetched
    expect(res.downloaded).toBe(1);
    expect(fs.statSync(path.join(root, "v.mp4")).size).toBe(10);
  });

  it("verifies size inside _download and never promotes a truncated temp file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-2164-dl-"));
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: { get: (k) => store.get(k), set: (k, v) => store.set(k, v), delete: (k) => store.delete(k) },
      getSyncFolder: () => root,
    };
    const engine = new SyncEngine({ apiBase: "http://test.local", config, keychain: {}, getDiskUsage: async () => ({}) });

    // Server hands back only 5 bytes though we expect 10.
    const srv = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end(Buffer.alloc(5));
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;
    const dest = path.join(root, "x.mp4");

    await expect(
      engine._download(`http://127.0.0.1:${port}/x`, dest, null, 10),
    ).rejects.toThrow(/size-mismatch/);
    expect(fs.existsSync(dest)).toBe(false); // never promoted to final name
    expect(fs.existsSync(`${dest}.part`)).toBe(false); // temp cleaned up

    await new Promise((r) => srv.close(r));
  });

  it("does NOT re-download an unknown-size (0) file that is already on disk every sweep", async () => {
    let calls = 0;
    const { engine, root } = makeEngine(
      // size 0 == unknown (e.g. proxy whose size couldn't be read)
      [{ id: 1, name: "u.mp4", relativePath: "u.mp4", size: 0, clientId: 1, projectName: "P" }],
      async (_url, destPath) => {
        calls++;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.writeFileSync(destPath, Buffer.alloc(12));
      },
    );

    const first = await engine.syncOnce();
    expect(first.downloaded).toBe(1);
    expect(calls).toBe(1);

    // Second sweep: the file is on disk and non-empty, so an unknown-size file
    // must be treated as present rather than perpetually re-fetched.
    const second = await engine.syncOnce();
    expect(calls).toBe(1); // NOT re-downloaded
    expect(second.downloaded).toBe(0);
    const p = engine.getStatusSnapshot().projects.find((x) => x.projectName === "P");
    expect(p).toMatchObject({ totalFiles: 1, localFiles: 1, pendingFiles: 0 });
  });
});
