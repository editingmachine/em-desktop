import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ProjectSync, fingerprint } from "./project-sync";

const roots = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const generation = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-downloads-"));
  roots.push(root);
  const store = new Map();
  const engine = { user: { id: 1, role: "editor" }, token: "token", apiBase: "https://example.invalid",
    config: { getSyncFolder: () => root, config: { get: k => structuredClone(store.get(k)), set: (k,v) => store.set(k, structuredClone(v)) } },
    _fileDownloadInflight: new Map(), emit: vi.fn(), emitStatus: vi.fn() };
  let deleted = true;
  engine._json = vi.fn(async (_method, _route, body) => ({
    version: 1, complete: true, accountId: 1, generatedAt: new Date().toISOString(),
    results: body.candidates.map(c => ({ ...c, deleted })),
  }));
  const sync = new ProjectSync(engine);
  sync.watch = () => {};
  const project = { projectId: 9, clientId: 1, projectCode: "001-0009", projectName: "Project",
    relativeDirectory: "Client-1/001-0009", status: "editing", lifecycleState: "active", retired: false, revision: "r1" };
  const manifest = { version: 2, complete: true, accountId: 1, generatedAt: new Date().toISOString(),
    projects: [project], files: [], totalFiles: 0 };
  sync.load(manifest);
  sync.data.projects[9] = { relativeDirectory: project.relativeDirectory };
  const add = (suffix = "source.mp4", overrides = {}) => {
    const relative = `${project.relativeDirectory}/${suffix}`;
    const abs = path.join(root, relative);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "original");
    const remote = { id: 40, assetId: 40, projectId: 9, clientId: 1, generation, relativePath: relative, ...overrides };
    sync.recordDownload(relative, remote);
    return { relative, abs, remote };
  };
  return { root, sync, engine, manifest, project, store, add, setDeleted: value => { deleted = value; } };
}

describe("explicit deletion receipts and real local files", () => {
  it("removes originals and proxies across shared project copies, but not another asset or manual file", async () => {
    const f = fixture();
    const a = f.add(), b = f.add(".proxies/source.mp4", { derivative: "proxy_intra" });
    const other = f.add("other.mp4", { id: 41 });
    const secondProject = { ...f.project, projectId: 10, projectCode: "001-0010", relativeDirectory: "Client-1/001-0010" };
    f.sync.manifest.projects.push(secondProject);
    f.sync.data.projects[10] = { relativeDirectory: secondProject.relativeDirectory };
    const shared = `${secondProject.relativeDirectory}/shared.mp4`;
    fs.mkdirSync(path.dirname(path.join(f.root, shared)), { recursive: true });
    fs.writeFileSync(path.join(f.root, shared), "original");
    f.sync.recordDownload(shared, { ...a.remote, projectId: 10, relativePath: shared });
    const manual = path.join(f.root, f.project.relativeDirectory, "manual.mp4");
    fs.writeFileSync(manual, "manual");
    f.engine._json.mockImplementation(async (_m, _r, body) => ({ version: 1, complete: true, accountId: 1,
      generatedAt: new Date().toISOString(), results: body.candidates.map(c => ({ ...c, deleted: c.id === 40 })) }));
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(false);
    expect(fs.existsSync(b.abs)).toBe(false);
    expect(fs.existsSync(path.join(f.root, shared))).toBe(false);
    expect(fs.readFileSync(other.abs, "utf8")).toBe("original");
    expect(fs.readFileSync(manual, "utf8")).toBe("manual");
    expect(f.sync.deletedDownloads.snapshot().completed).toBe(3);
    expect(f.engine.emit).toHaveBeenCalledWith("local-paths-invalidated");
    await f.sync.deletedDownloads.reconcile();
    expect(f.sync.data.reclaimedBytes).toBe(24);
  });

  it("never treats manifest absence, failed deletion, or project detachment as deletion", async () => {
    const f = fixture(); const a = f.add(); f.setDeleted(false);
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.sync.deletedDownloads.snapshot().completed).toBe(0);
  });
  it.each(["client", "sub-client", undefined])("protects client originals for %s", async role => {
    const f = fixture(); const a = f.add(); f.engine.user.role = role;
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.engine._json).not.toHaveBeenCalled();
  });
  it("retains modified bytes and prevents two-way upload resurrection and retirement", async () => {
    const f = fixture(); const a = f.add(); fs.writeFileSync(a.abs, "modified");
    f.sync.stabilityMs = 0;
    await f.sync.reconcile(f.manifest);
    expect(fs.readFileSync(a.abs, "utf8")).toBe("modified");
    expect(f.sync.deletedDownloads.snapshot().blocked).toBe(1);
    expect(f.sync.data.queue).toEqual({});
    expect(f.sync.status[0].state).toBe("blocked");
    expect(f.engine._json.mock.calls.every(([, route]) => route === "/api/sync/deletions/reconcile")).toBe(true);
  });
  it("does not claim a legacy download without generation evidence", async () => {
    const f = fixture(); const a = f.add("legacy.mp4", { generation: undefined });
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.engine._json).not.toHaveBeenCalled();
    expect(f.sync.deletedDownloads.snapshot().issues[0].reason).toMatch(/Legacy/);
  });
  it.each([
    { kind: "desktop_recovery" },
    { desktopRecovery: true },
    { localDeletionProtected: true },
    { downloadPath: "/api/smart-cloud/assets/40/desktop-recovery-download?desktopProjectId=9" },
    { pathOnly: true },
  ])("protects operator recovery provenance %j even when a legacy journal has a generation", async marker => {
    const f = fixture();
    const { pathOnly, ...remote } = marker;
    const a = f.add(pathOnly ? "operator-uploads/40/source.mp4" : "source.mp4", remote);
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.engine._json).not.toHaveBeenCalled(); // even a positive tombstone must not authorize these bytes
    expect(f.sync.deletedDownloads.snapshot().issues[0].reason).toMatch(/Operator recovery copy retained/);
    expect(f.sync.deletedDownloads.deleted(a.remote)).toBe(false);
    expect(f.sync.data.downloads[a.relative].deletionReceipt).toBeUndefined();
  });
  it.each(["partial", "wrong-account", "stale", "malformed", "network"])("retains downloads on %s authority", async failure => {
    const f = fixture(); const a = f.add();
    const original = f.engine._json.getMockImplementation();
    f.engine._json.mockImplementation(async (...args) => {
      if (failure === "network") throw new Error("offline");
      const r = await original(...args);
      if (failure === "partial") r.results = [];
      if (failure === "wrong-account") r.accountId = 2;
      if (failure === "stale") r.generatedAt = "2000-01-01";
      if (failure === "malformed") r.results[0].generation = "other-generation";
      return r;
    });
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.sync.deletedDownloads.snapshot().blocked).toBe(1);
  });
  it.each(["account", "session", "selection", "root", "pause"])("fences a %s change during a receipt request", async change => {
    const f = fixture(); const a = f.add();
    const original = f.engine._json.getMockImplementation();
    f.engine._json.mockImplementation(async (...args) => {
      const r = await original(...args);
      if (change === "account") f.engine.user.id = 2;
      if (change === "session") f.engine.token = "new-session";
      if (change === "selection") f.engine.config.config.set("selectedClients", [2]);
      if (change === "root") f.engine.config.getSyncFolder = () => f.root + "-different";
      if (change === "pause") f.engine.paused = true;
      return r;
    });
    await f.sync.deletedDownloads.reconcile().catch(() => {});
    expect(fs.existsSync(a.abs)).toBe(true);
  });
  it("does not delete after restore/replacement wins the last recheck", async () => {
    const f = fixture(); const a = f.add();
    const original = f.engine._json.getMockImplementation();
    let calls = 0;
    f.engine._json.mockImplementation(async (...args) => {
      if (++calls === 2) f.setDeleted(false);
      return original(...args);
    });
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.sync.deletedDownloads.blocks(a.relative)).toBeFalsy();
  });
  it.each(["reader", "download", "lock"])("defers a %s and retries idempotently", async kind => {
    const f = fixture(); const a = f.add();
    let unlink;
    if (kind === "reader") f.sync.readers.set(a.abs, 1);
    if (kind === "download") f.engine._fileDownloadInflight.set(a.abs, Promise.resolve());
    if (kind === "lock") unlink = vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => { throw Object.assign(new Error("EBUSY locked"), { code: "EBUSY" }); });
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.sync.deletedDownloads.snapshot().pending).toBe(1);
    f.sync.readers.clear(); f.engine._fileDownloadInflight.clear(); unlink?.mockRestore();
    await f.sync.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(false);
  });
  it.each(["symlink", "hardlink", "traversal", "unclaimed", "inode"])("retains unsafe %s copies", async kind => {
    const f = fixture(); const a = f.add();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "deleted-external-")); roots.push(outside);
    const target = path.join(outside, "keep.mp4"); fs.writeFileSync(target, "original");
    if (kind === "symlink") { fs.unlinkSync(a.abs); fs.symlinkSync(target, a.abs); }
    if (kind === "hardlink") { fs.unlinkSync(a.abs); fs.linkSync(target, a.abs); }
    if (kind === "traversal") { f.sync.data.downloads["../keep.mp4"] = f.sync.data.downloads[a.relative]; delete f.sync.data.downloads[a.relative]; }
    if (kind === "unclaimed") delete f.sync.data.projects[9];
    if (kind === "inode") { fs.renameSync(a.abs, a.abs + ".keep"); fs.writeFileSync(a.abs, "original"); }
    await f.sync.deletedDownloads.reconcile();
    expect(fs.readFileSync(target, "utf8")).toBe("original");
    expect(fs.existsSync(a.abs)).toBe(true);
    expect(f.sync.deletedDownloads.snapshot().blocked).toBe(1);
  });
  it("catches up after offline failure, pause and process restart using the durable download journal", async () => {
    const f = fixture(); const a = f.add();
    f.engine._json.mockRejectedValueOnce(new Error("offline"));
    await f.sync.deletedDownloads.reconcile();
    f.engine.paused = true;
    await f.sync.deletedDownloads.reconcile().catch(() => {});
    expect(fs.existsSync(a.abs)).toBe(true);
    f.engine.paused = false;
    const restarted = new ProjectSync(f.engine); restarted.watch = () => {};
    restarted.load(f.manifest);
    await restarted.deletedDownloads.reconcile();
    expect(fs.existsSync(a.abs)).toBe(false);
    expect(restarted.deletedDownloads.snapshot().completed).toBe(1);
  });
  it("resumes an unlink interrupted before the completion receipt was saved", async () => {
    const f = fixture(); const a = f.add();
    const setter = f.engine.config.config.set;
    f.engine.config.config.set = (key, value) => {
      if (value.deletedDownloads?.[a.relative]?.state === "completed") throw new Error("simulated process exit");
      setter(key, value);
    };
    await f.sync.deletedDownloads.reconcile().catch(() => {});
    expect(fs.existsSync(a.abs)).toBe(false);
    f.engine.config.config.set = setter;
    const restarted = new ProjectSync(f.engine); restarted.load(f.manifest);
    await restarted.deletedDownloads.reconcile();
    expect(restarted.deletedDownloads.snapshot().completed).toBe(1);
  });
  it("does not count intentionally removed downloads as impossible cloud backups during folder retirement", async () => {
    const f = fixture(); const a = f.add();
    await f.sync.deletedDownloads.reconcile();
    expect(f.sync.data.downloads[a.relative].deletionReceipt).toBeTruthy();
    f.project.status = "approved"; f.project.retired = true;
    f.engine._json.mockImplementation(async () => ({ ...f.manifest, project: f.project }));
    await f.sync.reconcile(f.manifest); // fence namespace
    await f.sync.reconcile(f.manifest); // retire empty proven folder
    expect(fs.existsSync(path.join(f.root, f.project.relativeDirectory))).toBe(false);
    expect(f.sync.data.projects[9].retiredRevision).toBe("r1");
  });
});
