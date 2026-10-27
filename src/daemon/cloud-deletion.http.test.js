import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { SyncEngine } from "./sync-engine";

const roots = [], servers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve));
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
function json(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-deletion-http-")); roots.push(root);
  const store = new Map();
  const config = { config: { get: k => structuredClone(store.get(k)), set: (k,v) => store.set(k, structuredClone(v)) },
    getSyncFolder: () => root };
  const state = { deleted: false, omit: false, generation: "11111111-1111-4111-8111-111111111111", downloads: 0, afterBytes: null };
  const project = { projectId: 9, clientId: 1, projectCode: "001-0009", projectName: "Project",
    relativeDirectory: "Client-1/001-0009", status: "editing", lifecycleState: "active", retired: false, revision: "r1" };
  const file = { id: 40, assetId: 40, projectId: 9, clientId: 1, generation: state.generation,
    name: "source.mp4", relativePath: `${project.relativeDirectory}/40-source.mp4`, size: 8 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, state.base);
    if (url.pathname === "/api/sync/manifest")
      return json(res, 200, { version: 2, complete: true, accountId: 1, generatedAt: new Date().toISOString(),
        projects: [project], files: state.omit ? [] : [file], totalFiles: state.omit ? 0 : 1 });
    if (url.pathname === "/api/sync/deletions/reconcile") {
      let data = ""; for await (const chunk of req) data += chunk;
      const body = JSON.parse(data);
      return json(res, 200, { version: 1, complete: true, accountId: 1, generatedAt: new Date().toISOString(),
        results: body.candidates.map(c => ({ ...c, deleted: state.deleted && c.generation === file.generation })) });
    }
    if (url.pathname === "/api/sync/download/40/identity")
      return state.deleted ? json(res, 403, { error: "deleted" }) : json(res, 200, { assetId: 40, generation: state.generation });
    if (url.pathname === "/api/sync/download/40")
      return state.deleted ? json(res, 409, { error: "deleted" }) : json(res, 200, { url: `${state.base}/bytes`, generation: state.generation });
    if (url.pathname === "/api/smart-cloud/assets/40/desktop-recovery-download")
      return state.deleted ? json(res, 409, { error: "deleted" }) : json(res, 200, { url: `${state.base}/bytes` });
    if (url.pathname === "/api/sync/download/40/complete") return json(res, 200, { success: true });
    if (url.pathname === "/bytes") {
      state.downloads++;
      res.writeHead(200, { "content-length": 8 }); res.end("original");
      state.afterBytes?.();
      return;
    }
    return json(res, 404, { error: "unhandled fixture route" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); servers.push(server);
  state.base = `http://127.0.0.1:${server.address().port}`;
  const engine = new SyncEngine({ apiBase: state.base, config, maxDownloadAttempts: 1 });
  engine.user = { id: 1, role: "editor" }; engine.token = "fixture-session";
  engine.projectSync.watch = () => {};
  return { root, store, engine, state, file, abs: path.join(root, file.relativePath) };
}

describe("real HTTP and byte-stream deletion races", () => {
  it.each([false, true])("retains a downloaded operator recovery copy after cloud deletion (legacy generation: %s)", async legacy => {
    const f = await fixture();
    f.file.kind = "desktop_recovery";
    f.file.recoveryProjectId = 9;
    f.file.localDeletionProtected = true;
    f.file.relativePath = "Client-1/001-0009/operator-uploads/40/source.mp4";
    f.file.downloadPath = "/api/smart-cloud/assets/40/desktop-recovery-download?desktopProjectId=9";
    f.file.sha256 = createHash("sha256").update("original").digest("hex");
    if (!legacy) delete f.file.generation;
    const copy = path.join(f.root, f.file.relativePath);
    await f.engine.syncOnce();
    expect(fs.readFileSync(copy, "utf8")).toBe("original"); // actually downloaded over HTTP
    expect(f.engine.projectSync.data.downloads[f.file.relativePath].remote.kind).toBe("desktop_recovery");
    f.state.deleted = true; f.state.omit = true;
    await f.engine.syncOnce();
    await f.engine.syncOnce();
    expect(fs.readFileSync(copy, "utf8")).toBe("original");
    expect(f.engine.projectSync.data.downloads[f.file.relativePath].deletionReceipt).toBeUndefined();
    expect(f.engine.projectSync.deletedDownloads.snapshot()).toMatchObject({
      completed: 0, blocked: 1, issues: [{ reason: expect.stringMatching(/Operator recovery copy retained/),
        remedy: expect.stringMatching(/Preserve this operator recovery copy/) }],
    });
    expect(f.engine.projectSync.data.reclaimedBytes).toBe(0);
    expect(f.state.downloads).toBe(1);
    f.engine.stop();
  });
  it("retains a detached copy, then cleans it on next sync, even with a stale manifest and duplicate sync triggers", async () => {
    const f = await fixture();
    await f.engine.syncOnce();
    expect(fs.readFileSync(f.abs, "utf8")).toBe("original");
    expect(f.engine.projectSync.data.downloads[f.file.relativePath].remote.generation).toBe(f.file.generation);
    f.state.omit = true;
    await f.engine.syncOnce();
    expect(fs.existsSync(f.abs)).toBe(true);
    f.state.deleted = true; f.state.omit = false; // stale/partial listing is not itself authority
    await Promise.all([f.engine.syncOnce(), f.engine.syncAsset(40), f.engine.syncAsset(40)]);
    expect(fs.existsSync(f.abs)).toBe(false);
    expect(f.state.downloads).toBe(1); // no stale manifest re-download
    expect(f.engine.projectSync.deletedDownloads.snapshot().completed).toBe(1);
    expect(f.engine.lastFiles).toEqual([]);
    f.engine.stop();
  });
  it("does not promote in-flight bytes if cloud deletion commits before download completion", async () => {
    const f = await fixture();
    f.state.afterBytes = () => { f.state.deleted = true; };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await f.engine.syncOnce();
    expect(result.downloaded).toBe(0);
    expect(fs.existsSync(f.abs)).toBe(false);
    expect(fs.existsSync(f.abs + ".part")).toBe(false);
    expect(warn).not.toHaveBeenCalled(); // intentional cleanup is not a transfer warning
    f.engine.stop();
  });
  it.each(["account", "session", "selection"])("does not promote downloads after an in-flight %s switch", async kind => {
    const f = await fixture();
    f.state.afterBytes = () => {
      if (kind === "account") f.engine.user.id = 2;
      if (kind === "session") f.engine.token = "other-session";
      if (kind === "selection") f.store.set("selectedClients", [2]);
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.engine.syncOnce();
    expect(fs.existsSync(f.abs)).toBe(false);
    expect(fs.existsSync(f.abs + ".part")).toBe(false);
    expect(f.engine.projectSync.data.downloads).toEqual({});
    f.engine.stop();
  });
  it("retains a newly valid source generation instead of acting on an old receipt", async () => {
    const f = await fixture();
    f.state.afterBytes = () => { f.state.generation = "22222222-2222-4222-8222-222222222222"; };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await f.engine.syncOnce();
    expect(fs.existsSync(f.abs)).toBe(false);
    f.file.generation = f.state.generation;
    f.state.afterBytes = null;
    await f.engine.syncOnce();
    expect(fs.readFileSync(f.abs, "utf8")).toBe("original");
    expect(f.engine.projectSync.data.downloads[f.file.relativePath].remote.generation).toBe(f.state.generation);
    f.engine.stop();
  });
});
