import { afterEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "./sync-engine";

const roots = [];
const servers = [];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

class DurableStore {
  constructor() {
    this.values = new Map();
  }
  get(key) {
    const value = this.values.get(key);
    return value === undefined ? undefined : structuredClone(value);
  }
  set(key, value) {
    this.values.set(key, structuredClone(value));
  }
  delete(key) {
    this.values.delete(key);
  }
}

function makeConfig(root, store = new DurableStore()) {
  return {
    store,
    config: store,
    getSyncFolder: () => root,
    getDeviceId: () => "http-e2e-device",
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

async function uploadServer(options = {}) {
  const state = {
    status: "editing",
    revision: "revision-1",
    admissions: [],
    assets: new Map(),
    puts: [],
    confirms: [],
    retirementRequests: 0,
    nextAssetId: 100,
    wrongReceipt: !!options.wrongReceipt,
    editDuringPut: options.editDuringPut,
  };
  const project = () => ({
    projectId: 9,
    clientId: 9,
    projectCode: "001-0009",
    projectName: "HTTP Contract Project",
    relativeDirectory: "Client-9/001-0009",
    status: state.status,
    lifecycleState: ["archive", "archived"].includes(state.status) ? "archived" : "active",
    retired: ["approved", "archive", "archived"].includes(state.status),
    revision: state.revision,
  });
  const manifest = () => ({
    version: 2,
    complete: true,
    accountId: 1,
    generatedAt: new Date().toISOString(),
    projects: [project()],
    files: [],
    totalFiles: 0,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/api/sync/manifest") {
        return json(res, 200, manifest());
      }
      if (req.method === "POST" && url.pathname === "/api/smart-cloud/assets/presigned-upload") {
        const body = await readJson(req);
        const assetId = state.nextAssetId++;
        state.admissions.push(body);
        state.assets.set(assetId, { admission: body, bytes: null, confirmed: false });
        return json(res, 200, {
          assetId,
          uploadUrl: `${state.baseUrl}/put/${assetId}`,
        });
      }
      const putMatch = url.pathname.match(/^\/put\/(\d+)$/);
      if (req.method === "PUT" && putMatch) {
        const assetId = Number(putMatch[1]);
        const asset = state.assets.get(assetId);
        if (!asset) return json(res, 404, { error: "unknown upload" });
        const chunks = [];
        let edited = false;
        for await (const chunk of req) {
          chunks.push(chunk);
          if (!edited && state.editDuringPut) {
            edited = true;
            state.editDuringPut();
          }
        }
        asset.bytes = Buffer.concat(chunks);
        state.puts.push({
          assetId,
          bytes: asset.bytes,
          contentLength: Number(req.headers["content-length"]),
          contentType: req.headers["content-type"],
        });
        res.writeHead(200, { etag: `"asset-${assetId}"` });
        return res.end();
      }
      const confirmMatch = url.pathname.match(
        /^\/api\/smart-cloud\/assets\/(\d+)\/confirm-upload$/,
      );
      if (req.method === "POST" && confirmMatch) {
        const assetId = Number(confirmMatch[1]);
        const asset = state.assets.get(assetId);
        if (!asset?.bytes) return json(res, 409, { error: "bytes not uploaded" });
        asset.confirmed = true;
        state.confirms.push(assetId);
        return json(res, 200, { success: true });
      }
      const receiptMatch = url.pathname.match(
        /^\/api\/smart-cloud\/assets\/(\d+)\/desktop-recoverability$/,
      );
      if (req.method === "GET" && receiptMatch) {
        const assetId = Number(receiptMatch[1]);
        const asset = state.assets.get(assetId);
        const desktop = asset?.admission.desktopSync;
        const receivedHash = asset?.bytes ? sha256(asset.bytes) : "";
        const exact = asset?.confirmed &&
          asset.bytes.length === asset.admission.fileSize &&
          receivedHash === desktop.sha256;
        return json(res, 200, {
          recoverable: exact,
          assetId,
          projectId: desktop?.projectId,
          relativePath: desktop?.relativePath,
          sha256: state.wrongReceipt ? "0".repeat(64) : receivedHash,
          size: asset?.bytes?.length || 0,
        });
      }
      if (req.method === "GET" && url.pathname === "/api/sync/projects/9/retirement") {
        state.retirementRequests += 1;
        return json(res, 200, { ...manifest(), project: project() });
      }
      return json(res, 404, { error: `Unhandled ${req.method} ${url.pathname}` });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  servers.push(server);
  return state;
}

function newEngine(root, state, config = makeConfig(root)) {
  const engine = new SyncEngine({
    apiBase: state.baseUrl,
    config,
    keychain: {},
    getDiskUsage: async () => ({}),
  });
  engine.token = "real-http-session";
  engine.user = { id: 1, role: "editor", email: "editor@example.test" };
  engine.projectSync.stabilityMs = 0;
  // Native watchers are not part of these deterministic sweeps and otherwise
  // schedule extra HTTP traffic while assertions deliberately mutate files.
  engine.projectSync.watch = () => {};
  return engine;
}

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "project-sync-http-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("desktop project sync over filesystem and HTTP", () => {
  it("uploads exact nested bytes, survives restart, fences, and retires only the project", async () => {
    const root = tempRoot();
    const state = await uploadServer();
    const config = makeConfig(root);
    const projectDir = path.join(root, "Client-9", "001-0009");
    const unrelated = path.join(root, "Client-9", "unrelated");
    fs.mkdirSync(unrelated, { recursive: true });
    fs.writeFileSync(path.join(unrelated, "keep.txt"), "not project-owned");

    const first = newEngine(root, state, config);
    expect(await first._json("GET", "/api/sync/manifest?version=2", null)).toMatchObject({
      version: 2,
      complete: true,
      accountId: 1,
      projects: [expect.objectContaining({ projectId: 9 })],
      files: [],
    });
    await first.syncOnce();
    const localBytes = Buffer.from("manual nested edit bytes \u0000\u0001", "utf8");
    const relativePath = "sequences/day-01/manual-cut.mp4";
    const localFile = path.join(projectDir, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(localFile), { recursive: true });
    fs.writeFileSync(localFile, localBytes);
    await first.syncOnce();

    expect(state.admissions).toEqual([{
      filename: "manual-cut.mp4",
      mimeType: "video/mp4",
      fileSize: localBytes.length,
      desktopSync: { projectId: 9, relativePath, sha256: sha256(localBytes) },
    }]);
    expect(state.puts).toHaveLength(1);
    expect(state.puts[0].contentLength).toBe(localBytes.length);
    expect(state.puts[0].contentType).toBe("video/mp4");
    expect(sha256(state.puts[0].bytes)).toBe(sha256(localBytes));
    expect(state.confirms).toEqual([100]);
    expect(Object.values(first.projectSync.data.queue)[0].state).toBe("verified");
    first.stop();

    // Recreate both engine and ProjectSync against the persisted config. The
    // approved revision must reuse its durable verified receipt, not re-upload.
    state.status = "approved";
    const restarted = newEngine(root, state, config);
    await restarted.syncOnce();
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(restarted.projectSync.data.projects[9].fencedDirectory).toMatch(
      /^Client-9\/\.retiring-9-/,
    );
    expect(state.puts).toHaveLength(1);

    await restarted.syncOnce();
    expect(restarted.projectSync.snapshot().projects[0].state).toBe("retired");
    expect(fs.existsSync(projectDir)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(path.join(root, "Client-9"))).toBe(true);
    expect(fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8")).toBe(
      "not project-owned",
    );
    expect(fs.readdirSync(path.join(root, "Client-9"))).toEqual(["unrelated"]);
    expect(state.retirementRequests).toBe(4);
    restarted.stop();
  });

  it("retains a file edited during the real PUT and never marks it verified", async () => {
    const root = tempRoot();
    const projectDir = path.join(root, "Client-9", "001-0009");
    const localFile = path.join(projectDir, "changing.mp4");
    let changed = false;
    const state = await uploadServer({
      editDuringPut: () => {
        if (!changed) {
          changed = true;
          fs.appendFileSync(localFile, "-newer-local-version");
        }
      },
    });
    const engine = newEngine(root, state);
    await engine.syncOnce();
    const original = Buffer.alloc(2 * 1024 * 1024, 0x61);
    fs.writeFileSync(localFile, original);

    await engine.syncOnce();

    expect(changed).toBe(true);
    expect(state.puts).toHaveLength(1);
    expect(sha256(state.puts[0].bytes)).toBe(sha256(original));
    expect(fs.readFileSync(localFile).subarray(-20).toString()).toContain(
      "newer-local-version",
    );
    const queued = Object.values(engine.projectSync.data.queue)[0];
    expect(queued.state).toBe("blocked");
    expect(queued.error).toMatch(/changed during (transfer|upload)|unverified/i);
    expect(fs.existsSync(localFile)).toBe(true);
    engine.stop();
  });

  it("retains unsupported bytes and supported bytes when the HTTP receipt is wrong", async () => {
    const root = tempRoot();
    const state = await uploadServer({ wrongReceipt: true });
    const engine = newEngine(root, state);
    await engine.syncOnce();
    const projectDir = path.join(root, "Client-9", "001-0009");
    const supported = path.join(projectDir, "recoverable.mp4");
    const unsupported = path.join(projectDir, "timeline.prproj");
    fs.writeFileSync(supported, "uploaded but bad receipt");
    fs.writeFileSync(unsupported, "unsupported operator project");

    await engine.syncOnce();
    state.status = "approved";
    await engine.syncOnce();

    expect(state.puts).toHaveLength(1);
    expect(sha256(state.puts[0].bytes)).toBe(
      sha256(fs.readFileSync(supported)),
    );
    expect(fs.readFileSync(supported, "utf8")).toBe("uploaded but bad receipt");
    expect(fs.readFileSync(unsupported, "utf8")).toBe(
      "unsupported operator project",
    );
    expect(fs.existsSync(projectDir)).toBe(true);
    expect(engine.projectSync.snapshot().projects[0]).toMatchObject({
      state: "blocked",
    });
    const queue = Object.values(engine.projectSync.data.queue);
    expect(queue.find((item) => item.relativePath === "recoverable.mp4").state).toBe(
      "blocked",
    );
    expect(queue.find((item) => item.relativePath === "timeline.prproj").state).toBe(
      "blocked",
    );
    expect(state.retirementRequests).toBe(0);
    engine.stop();
  });
});