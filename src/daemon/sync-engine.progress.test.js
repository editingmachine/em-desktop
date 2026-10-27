// Task #2470 — verification coverage for the download-percentage PUSH path at
// its source: the sync daemon's `progress` event.
//
// The renderer store/overlay/surface (clip-sync-store.ts) and the preload/main
// relay are unit-tested elsewhere, but the very first hop — the daemon actually
// emitting a real, climbing per-asset percentage as bytes arrive — could only be
// exercised in a packaged binary. This suite streams REAL bytes over a local
// HTTP server (no mocked `_download`) so `onProgress` fires from genuine socket
// chunks, then asserts the engine emits `progress` payloads shaped exactly as
// main/index.js relays them onward:
//   { file, pct, bytes, assetId, filePct }
// with a per-asset `filePct` that climbs monotonically and reaches 100.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import { SyncEngine } from "./sync-engine.js";

// A tiny HTTP server that streams `totalBytes` in small delayed chunks so the
// download produces several `data` events (and thus several progress ticks),
// exactly like a real multi-MB clip trickling in over the network.
function makeChunkedServer(totalBytes, chunkSize = 4096) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(totalBytes),
      });
      let sent = 0;
      const pump = () => {
        if (sent >= totalBytes) return res.end();
        const n = Math.min(chunkSize, totalBytes - sent);
        sent += n;
        res.write(Buffer.alloc(n, 1), () => setTimeout(pump, 2));
      };
      pump();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}/file.mp4` });
    });
  });
}

describe("SyncEngine download-progress push path (Task #2470)", () => {
  let root;
  let started = [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "em-sync-2470-"));
    started = [];
  });

  afterEach(() => {
    for (const s of started) {
      try {
        s.close();
      } catch (_) {}
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (_) {}
  });

  function makeEngine(fileUrl, size) {
    const store = new Map([["selectedClients", []]]);
    const config = {
      config: {
        get: (k) => store.get(k),
        set: (k, v) => store.set(k, v),
        delete: (k) => store.delete(k),
      },
      getSyncFolder: () => root,
    };
    const engine = new SyncEngine({
      apiBase: "http://test.local",
      config,
      keychain: {},
      getDiskUsage: async () => ({}),
    });
    engine.token = "test-token";

    // ONE asset (id 42) with a single all-intra proxy file. The manifest carries
    // `id: 42` (what the progress event keys `assetId` on) AND `assetId: 42`
    // (what resolveLocalScrubSource matches on) — the two must agree or the
    // overlay's percentage would key on a different number than the clip it
    // tracks. Asserting the emitted assetId below pins that contract.
    const manifest = {
      files: [
        {
          id: 42,
          assetId: 42,
          name: "clip.intra.mp4",
          relativePath: "clip.intra.mp4",
          size,
          clientId: 1,
          projectName: "Demo",
          proxyKind: "all-intra",
        },
      ],
    };

    // Real byte transfer runs against the local server; only the JSON control
    // calls are stubbed. The download route hands back the real streaming URL.
    engine._json = async (method, route) => {
      if (route === "/api/sync/manifest?version=2") return manifest;
      if (route.endsWith("/complete")) return {};
      if (route.startsWith("/api/sync/download/")) return { url: fileUrl };
      return {};
    };

    return engine;
  }

  it("emits a climbing per-asset filePct that reaches 100 during a real streamed download", async () => {
    const size = 64 * 1024; // 64 KB streamed in 4 KB chunks → ~16 progress ticks
    const { server, url } = await makeChunkedServer(size);
    started.push(server);

    const engine = makeEngine(url, size);
    const events = [];
    engine.on("progress", (p) => events.push(p));

    const res = await engine.syncOnce();
    expect(res.downloaded).toBe(1);

    // The file actually landed on disk at the expected size.
    const dest = path.join(root, "clip.intra.mp4");
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBe(size);

    // Several progress ticks fired (not just a single 0→100 jump).
    expect(events.length).toBeGreaterThan(2);

    // Every event carries the correct per-asset routing key and the two shapes
    // main/index.js reads: the whole-batch `pct` and the per-asset `filePct`.
    for (const e of events) {
      expect(e.assetId).toBe(42);
      expect(typeof e.file).toBe("string");
      expect(e.pct).toBeGreaterThanOrEqual(0);
      expect(e.pct).toBeLessThanOrEqual(100);
      expect(e.filePct).toBeGreaterThanOrEqual(0);
      expect(e.filePct).toBeLessThanOrEqual(100);
    }

    // filePct climbs (never snaps backwards) and reaches 100 by the end.
    const filePcts = events.map((e) => e.filePct);
    for (let i = 1; i < filePcts.length; i++) {
      expect(filePcts[i]).toBeGreaterThanOrEqual(filePcts[i - 1]);
    }
    expect(filePcts[filePcts.length - 1]).toBe(100);

    // The batch aggregate is monotonic and finishes at 100 too.
    const pcts = events.map((e) => e.pct);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
    expect(pcts[pcts.length - 1]).toBe(100);
  });

  it("keeps the latest per-asset percentage readable mid-download (pull-fallback source)", async () => {
    // Mirrors the main-process relay (assetSyncProgress map in main/index.js):
    // remember the newest filePct per asset from the push feed so a preview that
    // OPENS mid-download can pull the current number immediately (getSyncProgress)
    // rather than waiting for the next push. Here we prove the daemon supplies a
    // continuously-updated value the relay can cache.
    const size = 48 * 1024;
    const { server, url } = await makeChunkedServer(size);
    started.push(server);

    const engine = makeEngine(url, size);

    // Stand-in for the main process's assetSyncProgress Map + getSyncProgress.
    const assetSyncProgress = new Map();
    engine.on("progress", (p) => {
      const id = Number(p?.assetId);
      const pct = Number(p?.filePct);
      if (Number.isFinite(id) && id > 0 && Number.isFinite(pct)) {
        assetSyncProgress.set(id, Math.max(0, Math.min(100, Math.round(pct))));
      }
    });
    const getSyncProgress = (id) =>
      assetSyncProgress.has(id) ? assetSyncProgress.get(id) : null;

    // Snapshot the pulled value partway through the download to prove a
    // mid-flight open sees a real number, not null.
    let midFlightPull = null;
    engine.on("progress", (p) => {
      if (midFlightPull === null && p.filePct > 0 && p.filePct < 100) {
        midFlightPull = getSyncProgress(42);
      }
    });

    await engine.syncOnce();

    expect(midFlightPull).not.toBeNull();
    expect(midFlightPull).toBeGreaterThan(0);
    expect(midFlightPull).toBeLessThan(100);
    // After completion the cached value is the final 100 the relay would serve.
    expect(getSyncProgress(42)).toBe(100);
    // Unknown assets pull null (relay returns null → overlay shows generic text).
    expect(getSyncProgress(999)).toBeNull();
  });
});
