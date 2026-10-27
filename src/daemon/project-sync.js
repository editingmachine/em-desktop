// Task #4306. Filesystem state is deliberately outside disposable project folders.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const { LocalMedia } = require("./local-media");
const { DeletedDownloads } = require("./deleted-downloads");
const aliasKey = (name) => name.normalize("NFC").toLowerCase();

function shouldReadmitUpload(error) {
  return /Upload HTTP (403|404)|Uploaded object is missing|re-upload required/i.test(error?.message || "");
}

function mountPaths(text) {
  return text.trim().split("\n").filter(Boolean).map((line) =>
    line.split(" ")[4]?.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8))));
}

function safePath(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") ||
      path.isAbsolute(relative) || relative.split("/").some((p) => !p || p === "." || p === ".." ||
        /[<>:"|?*\x00-\x1f]/.test(p) || /[ .]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))
    throw new Error("Unsafe sync path");
  const base = path.resolve(root);
  const target = path.resolve(base, relative);
  if (!target.startsWith(base + path.sep)) throw new Error("Path escapes sync root");
  if (process.platform === "linux") {
    // st_dev does not detect same-device bind mounts. Never traverse a mount
    // nested below the configured root, including a bind to another directory.
    const mounts = mountPaths(fs.readFileSync("/proc/self/mountinfo", "utf8"));
    if (mounts.some((mount) => mount?.startsWith(base + path.sep) && (target === mount || target.startsWith(mount + path.sep))))
      throw new Error("Mounted/bind directory blocks sync");
  }
  const rootDevice = fs.existsSync(base) ? fs.lstatSync(base).dev : null;
  // lstat every ancestor, including the root: never follow links/junctions.
  let current = path.parse(base).root;
  for (const segment of target.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    const parent = path.dirname(current);
    if (fs.existsSync(parent)) {
      const aliases = fs.readdirSync(parent).filter((name) => aliasKey(name) === aliasKey(segment));
      if (aliases.length > 1 || aliases.length === 1 && aliases[0] !== segment)
        throw new Error("Case-insensitive path conflict");
    }
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error("Symlink/junction blocks sync");
      if (current.startsWith(base + path.sep) && rootDevice !== null && stat.dev !== rootDevice)
        throw new Error("Filesystem device boundary blocks sync");
    } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  return target;
}

function fingerprint(file) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Linked or special file blocks cleanup");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n));
    const after = fs.fstatSync(fd);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("File is still changing");
    return { sha256: hash.digest("hex"), size: after.size, mtimeMs: after.mtimeMs, ino: after.ino };
  } finally { fs.closeSync(fd); }
}
const same = (a, b) => a && b && a.sha256 === b.sha256 && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
const retired = (p) => p.status === "approved" || p.status === "archive" || p.status === "archived" || p.lifecycleState === "archived";
const transient = (name) => name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini";

const canRetireLocalFiles = (user) => !!user && !user.isSubUser &&
  ["admin", "manager", "operator", "partner", "senior_editor", "editor"].includes(user.role);
function validateProject(p, root) {
  if (!p || !Number.isSafeInteger(p.projectId) || p.projectId <= 0 ||
      !Number.isSafeInteger(p.clientId) || p.clientId <= 0 ||
      typeof p.projectCode !== "string" || !/^[a-zA-Z0-9-]+$/.test(p.projectCode) ||
      typeof p.projectName !== "string" ||
      typeof p.revision !== "string" || !p.revision.trim() ||
      !["draft", "editing", "review", "revision", "approved", "archive", "archived"].includes(p.status) ||
      !["active", "parked", "archived"].includes(p.lifecycleState) ||
      typeof p.retired !== "boolean" || p.retired !== retired(p) ||
      p.relativeDirectory !== `Client-${p.clientId}/${p.projectCode}`)
    throw new Error("Invalid canonical project identity or retirement metadata");
  safePath(root, p.relativeDirectory);
}

class ProjectSync {
  constructor(engine) {
    this.engine = engine;
    this.watchers = [];
    this.status = [];
    this.stabilityMs = 2000;
    this.readers = new Map();
    this.localMedia = null;
    this.transfers = new Set();
    this.deletedDownloads = new DeletedDownloads(this, { safePath, fingerprint, same, canRetireLocalFiles });
  }
  cancelTransfers() {
    for (const req of this.transfers) req.destroy(new Error("Sync interrupted; files retained"));
  }
  close() {
    for (const watcher of this.watchers) watcher.close();
    this.watchers = [];
    clearTimeout(this.watchTimer);
  }
  context() {
    return `${this.engine.apiBase}|${this.engine.user?.id}|${path.resolve(this.engine.config.getSyncFolder())}`;
  }
  save() {
    if (this.context() !== this.scope) throw new Error("Account or sync folder changed; retry sync");
    if (this.engine.token !== this.sessionToken) throw new Error("Session changed; files retained");
    this.engine.config.config.set(this.key, this.data);
  }
  check() {
    if (this.context() !== this.scope || this.engine.token !== this.sessionToken ||
        !this.engine.token || this.engine.paused || this.engine.cancelled)
      throw new Error("Sync interrupted; files retained");
  }
  report(projectId, state, message) {
    this.status = this.status.filter((entry) => entry.projectId !== projectId);
    this.status.push({ projectId, state, ...(message ? { message } : {}) });
    this.engine.emitStatus?.();
  }
  snapshot() {
    const queue = Object.values(this.data?.queue || {});
    const identities = Object.values(this.data?.projects || {});
    const active = this.status.filter((p) => p.state === "uploading").length;
    const issues = this.status.filter((p) => p.state === "blocked").map((p) => ({ projectId: p.projectId, reason: p.message }));
    const migrationIssues = issues.filter((p) => /migration|legacy|unclaimed|identity|destination|conflict/i.test(p.reason));
    return {
      deletedDownloads: this.deletedDownloads.snapshot(),
      projects: this.status.map((p) => ["ready", "retired", "blocked"].includes(p.state) ? p : { ...p, state: "ready", message: p.message || p.state }),
      uploads: {
        pending: queue.filter((i) => i.state === "pending").length,
        active,
        completed: queue.filter((i) => i.state === "verified").length,
        failed: queue.filter((i) => i.state === "blocked").length,
        bytesPending: queue.filter((i) => i.state !== "verified").reduce((sum, i) => sum + i.size, 0),
        issues: queue.filter((i) => i.state === "blocked").map((i) => ({ projectId: i.projectId, relativePath: i.relativePath, reason: i.error })),
      },
      cleanup: {
        pendingProjects: (this.manifest?.projects || []).filter((p) => retired(p) && this.data?.projects[p.id]?.retiredRevision !== p.revision).length,
        activeProject: this.status.find((p) => p.state === "verifying")?.projectId?.toString() || null,
        completedProjects: identities.filter((p) => p.retiredRevision).length,
        reclaimedBytes: this.data?.reclaimedBytes || 0,
        issues,
      },
      migration: {
        pending: identities.filter((p) => p.migratingFrom).length,
        completed: identities.filter((p) => p.migratedFrom).length,
        conflicts: migrationIssues.length,
        issues: migrationIssues,
      },
    };
  }
  async mapLegacyDirectory(projectId, relativeDirectory, confirmedProjectCode) {
    const id = Number(projectId);
    if (!Number.isInteger(id) || id <= 0 || typeof confirmedProjectCode !== "string")
      throw new Error("Explicit canonical project confirmation is required");
    const context = this.context();
    const manifest = await this.engine._json("GET", "/api/sync/manifest?version=2", null);
    if (context !== this.context()) throw new Error("Account/root changed during identity confirmation");
    this.load({ ...manifest, projects: manifest.projects?.map((p) => ({ ...p, id: p.projectId })) });
    this.check();
    const project = this.manifest.projects.find((p) => p.id === id);
    if (!project || project.projectCode !== confirmedProjectCode) throw new Error("Project is unauthorized or confirmation does not match");
    if (this.manifest.projects.some((p) => aliasKey(p.relativeDirectory) === aliasKey(relativeDirectory)))
      throw new Error("A canonical numbered project directory cannot be reassigned as a legacy folder");
    if (relativeDirectory.split("/").length !== 2 || relativeDirectory === project.relativeDirectory)
      throw new Error("Select a legacy project directory, not a client/root directory");
    const source = safePath(this.root, relativeDirectory);
    if (!fs.lstatSync(source).isDirectory()) throw new Error("Legacy source is not a directory");
    for (const [otherId, identity] of Object.entries(this.data.projects)) {
      if (Number(otherId) !== id && [identity.relativeDirectory, identity.migratingFrom, identity.fencedDirectory].includes(relativeDirectory))
        throw new Error("Source is already assigned to another project");
    }
    if (Object.entries(this.data.legacyMappings || {}).some(([otherId, directory]) => Number(otherId) !== id && directory === relativeDirectory))
      throw new Error("Legacy source is already assigned to another project");
    this.scan(relativeDirectory);
    const existing = this.data.projects[id];
    if (existing?.fencedDirectory || existing?.migratingFrom) throw new Error("Finish or resolve the pending project operation first");
    const dest = safePath(this.root, project.relativeDirectory);
    if (fs.existsSync(dest)) {
      if (!existing || existing.relativeDirectory !== project.relativeDirectory || fs.readdirSync(dest).length)
        throw new Error("Canonical destination already contains files; resolve conflict without overwriting");
      fs.rmdirSync(dest); // only our positively identified, empty placeholder
    }
    this.data.legacyMappings = { ...this.data.legacyMappings, [id]: relativeDirectory };
    this.data.projects[id] = { ...existing, relativeDirectory: project.relativeDirectory, migratingFrom: relativeDirectory };
    this.save(); // journal before rename; regular reconciliation resumes after restart
    return { projectId: id, projectCode: project.projectCode, source: relativeDirectory, destination: project.relativeDirectory };
  }
  load(manifest) {
    if (manifest.version !== 2 || manifest.complete !== true || !Array.isArray(manifest.projects) ||
        !Array.isArray(manifest.files) || !Number.isSafeInteger(manifest.totalFiles) ||
        manifest.totalFiles < 0 || manifest.totalFiles !== manifest.files.length || !this.engine.user?.id ||
        !Number.isSafeInteger(manifest.accountId) || manifest.accountId !== this.engine.user.id ||
        !Number.isFinite(Date.parse(manifest.generatedAt)) ||
        Math.abs(Date.now() - Date.parse(manifest.generatedAt)) > 10 * 60 * 1000)
      throw new Error("Fresh complete project manifest required; local files retained");
    const root = path.resolve(this.engine.config.getSyncFolder());
    const dirs = new Set();
    const ids = new Set();
    for (const p of manifest.projects) {
      validateProject(p, root);
      const dir = aliasKey(p.relativeDirectory);
      if (dirs.has(dir) || ids.has(p.id)) throw new Error("Ambiguous project directory");
      dirs.add(dir); ids.add(p.id);
    }
    const destinations = new Set();
    for (const file of manifest.files) {
      const project = manifest.projects.find((p) => p.projectId === file?.projectId);
      // Both explicit spellings are accepted during the coordinated server
      // rollout; disagreeing markers/identities are never tolerated.
      const isRecovery = file?.desktopRecovery === true || file?.kind === "desktop_recovery";
      const homeProjectId = file?.homeProjectId ?? file?.recoveryProjectId;
      const expectedDownloadPath = isRecovery
        ? `/api/smart-cloud/assets/${file.id}/desktop-recovery-download?desktopProjectId=${homeProjectId}`
        : `/api/sync/download/${file?.id}${file?.derivative ? "?derivative=proxy_intra" : ""}`;
      if (!file || !project || project.retired || file.clientId !== project.clientId ||
          !Number.isSafeInteger(file.id) || file.id <= 0 || file.assetId !== file.id ||
          !Number.isSafeInteger(file.size) || file.size < 0 ||
          typeof file.name !== "string" || !file.name ||
          typeof file.relativePath !== "string" || !file.relativePath.startsWith(project.relativeDirectory + "/") ||
          (file.derivative !== undefined && file.derivative !== "proxy_intra") ||
          (file.generation !== undefined && (typeof file.generation !== "string" || !/^[a-f0-9-]{36}$/.test(file.generation))) ||
          (file.desktopRecovery !== undefined && typeof file.desktopRecovery !== "boolean") ||
          (file.desktopRecovery === false && file.kind === "desktop_recovery") ||
          (file.homeProjectId !== undefined && file.recoveryProjectId !== undefined && file.homeProjectId !== file.recoveryProjectId) ||
          (file.sha256 !== undefined && (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) ||
          (isRecovery && (!Number.isSafeInteger(homeProjectId) || homeProjectId <= 0 ||
            file.derivative !== undefined || typeof file.sha256 !== "string" ||
            !file.relativePath.startsWith(`${project.relativeDirectory}/operator-uploads/${file.id}/`) ||
            file.downloadPath !== expectedDownloadPath)) ||
          (!isRecovery && (file.homeProjectId !== undefined || file.recoveryProjectId !== undefined)) ||
          (file.downloadPath !== undefined && file.downloadPath !== expectedDownloadPath))
        throw new Error("Malformed project file manifest; cleanup blocked");
      safePath(root, file.relativePath);
      const destination = aliasKey(file.relativePath);
      if (destinations.has(destination)) throw new Error("Duplicate manifest destination; cleanup blocked");
      destinations.add(destination);
    }
    this.scope = this.context();
    this.sessionToken = this.engine.token;
    this.root = root;
    this.key = "projectSync-" + crypto.createHash("sha256").update(this.scope).digest("hex");
    this.data = this.engine.config.config.get(this.key) || { projects: {}, queue: {}, downloads: {}, reclaimedBytes: 0 };
    this.manifest = manifest;
  }
  scan(relativeDirectory) {
    const files = [];
    const visit = (relative) => {
      const abs = safePath(this.root, relative);
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) {
        for (const name of fs.readdirSync(abs).sort()) visit(`${relative}/${name}`);
      } else {
        files.push({ relative, ...fingerprint(abs) });
      }
    };
    visit(relativeDirectory);
    return files;
  }
  async reconcile(manifest) {
    manifest = { ...manifest, projects: manifest.projects?.map((p) => ({ ...p, id: p.projectId ?? p.id })) };
    this.close();
    this.status = [];
    this.load(manifest);
    await this.deletedDownloads.reconcile();
    for (const p of manifest.projects) {
      try {
        this.check();
        if (retired(p) && !canRetireLocalFiles(this.engine.user)) {
          this.report(p.id, "blocked", "Client local originals are never automatically removed. Local files retained.");
          continue;
        }
        this.report(p.id, "scanning");
        let identity = this.data.projects[p.id];
        if (identity && identity.relativeDirectory !== p.relativeDirectory)
          throw new Error("Project directory changed; resolve identity conflict before cleanup");
        if (!identity) {
          // An existing unclaimed numbered directory is not proof of identity.
          const dest = safePath(this.root, p.relativeDirectory);
          // Legacy migration requires a persisted positive identity, never a
          // server title slug (two historical projects may share the same slug).
          const legacy = this.data.legacyMappings?.[p.id];
          if (legacy && legacy !== p.relativeDirectory && fs.existsSync(safePath(this.root, legacy))) {
            const owners = Object.entries(this.data.legacyMappings || {}).filter(([, directory]) => directory === legacy);
            if (owners.length !== 1 || fs.existsSync(dest))
              throw new Error("Ambiguous legacy folder or destination conflict; files retained");
            if (legacy.split("/").length !== 2) throw new Error("Unsafe legacy directory");
            this.scan(legacy); // validates every descendant before moving
            identity = { relativeDirectory: p.relativeDirectory, migratingFrom: legacy };
            this.data.projects[p.id] = identity; this.save();
          } else {
            if (fs.existsSync(dest)) throw new Error("Unclaimed project folder; manual identity resolution required");
            identity = { relativeDirectory: p.relativeDirectory };
            this.data.projects[p.id] = identity; this.save();
          }
        }
        if (identity.migratingFrom) {
          this.report(p.id, "migrating", "Moving trusted project directory to its canonical number");
          const source = safePath(this.root, identity.migratingFrom);
          const dest = safePath(this.root, identity.relativeDirectory);
          if (fs.existsSync(source)) {
            if (fs.existsSync(dest)) throw new Error("Interrupted migration conflicts with destination");
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.renameSync(source, dest);
          } else if (!fs.existsSync(dest)) throw new Error("Migration source missing");
          identity.migratedFrom = identity.migratingFrom;
          delete identity.migratingFrom; this.save();
        }
        if (identity.fencePending) {
          const original = safePath(this.root, identity.relativeDirectory);
          const fenced = safePath(this.root, identity.fencedDirectory);
          if (fs.existsSync(original) && fs.existsSync(fenced)) throw new Error("Interrupted retirement has conflicting directories");
          if (fs.existsSync(original)) fs.renameSync(original, fenced);
          if (!fs.existsSync(fenced)) throw new Error("Interrupted retirement directory missing");
          delete identity.fencePending; this.save();
        }
        if (identity.fencedDirectory && !retired(p)) {
          const original = safePath(this.root, identity.relativeDirectory);
          if (fs.existsSync(original)) throw new Error("Reopened project conflicts with fenced copy; resolve both folders");
          fs.renameSync(safePath(this.root, identity.fencedDirectory), original);
          delete identity.fencedDirectory; this.save();
          this.engine.emit("local-paths-invalidated");
        }
        const directory = identity.fencedDirectory || identity.relativeDirectory;
        const abs = safePath(this.root, directory);
        if (!fs.existsSync(abs)) {
          if (retired(p)) {
            identity.retiredRevision = p.revision;
            this.save();
            this.report(p.id, "retired");
            continue;
          }
          fs.mkdirSync(abs, { recursive: true });
        }
        const files = this.scan(directory);
        const localSuffixes = new Set(files.map((file) => file.relative.slice(directory.length + 1)));
        for (const [key, item] of Object.entries(this.data.queue)) {
          if (item.projectId === p.id && item.state !== "verified" && !localSuffixes.has(item.relativePath)) delete this.data.queue[key];
        }
        this.save();
        const blocked = [];
        for (const file of files) {
          try {
          const suffix = file.relative.slice(directory.length + 1);
          const canonical = `${identity.relativeDirectory}/${suffix}`;
          if (transient(path.basename(suffix))) continue;
          const downloaded = this.data.downloads[canonical];
          if (this.deletedDownloads.blocks(canonical)) {
            blocked.push(`Cloud deletion cleanup retained ${suffix}: ${this.data.deletedDownloads[canonical].reason || "cleanup pending"}`);
            continue; // never resurrect a deleted download through two-way upload
          }
          if (same(downloaded, file)) continue;
          const key = `${p.id}:${suffix}`;
          let item = this.data.queue[key];
          if (!item || !same(item, file)) {
            item = this.data.queue[key] = { ...file, projectId: p.id, relativePath: suffix, observedAt: Date.now(), attempts: 0, state: "pending" };
            this.save();
          }
          if (item.state === "verified") continue;
          if (Date.now() - item.observedAt < this.stabilityMs) throw new Error(`Waiting for stable file: ${suffix}`);
          if (item.retryAt > Date.now()) throw new Error(item.error || `Upload pending: ${suffix}`);
           // Proxy preparation is a separate, best-effort lane. It never
           // changes the authoritative original identity and never blocks the
           // original-first fallback when the packaged converter is absent.
           if (this.engine.proxyFirst?.enabled && !item.proxyReady &&
               [".mp4", ".mov"].includes(path.extname(suffix).toLowerCase())) {
             try {
               if (!this.localMedia) this.localMedia = new LocalMedia(this.engine.resourcesPath || process.resourcesPath || path.dirname(this.root));
               const proxyDir = path.join(this.root, ".em-proxy-cache", String(p.id));
               fs.mkdirSync(proxyDir, { recursive: true });
               const proxy = path.join(proxyDir, `${crypto.createHash("sha256").update(suffix).digest("hex")}.mp4`);
               this.report(p.id, "preparing", `Preparing proxy ${suffix}`);
               const prepared = await this.localMedia.prepare(safePath(this.root, file.relative), proxy);
               item.proxy = prepared;
               item.proxyFile = proxy;
               item.proxyReady = true;
               item.proxyStatus = "prepared";
               this.save();
             } catch (e) {
               item.proxyStatus = "original_only";
               item.proxyError = e.message;
               this.save();
             }
           }
          try {
            this.check();
            this.report(p.id, "uploading", `Uploading ${suffix}`);
            // Admit the asset first without transferring the large original.
            // This gives the proxy lane a stable asset identity and keeps the
            // original transfer resumable in the second lane.
            if (item.proxyReady && !item.assetId) {
              await this.upload(p, item, safePath(this.root, file.relative), { deferTransfer: true });
            }
            if (item.proxyReady && item.proxyStatus === "prepared" && this.engine.proxyFirst?.enabled) {
              this.report(p.id, "uploading", `Uploading proxy ${suffix}`);
              await this.uploadProxy(p, item);
              item.proxyStatus = "verified";
              this.save();
            }
            await this.upload(p, item, safePath(this.root, file.relative));
            if (!same(item, fingerprint(safePath(this.root, file.relative))))
              throw new Error("File changed during upload; latest version is not backed up");
            item.state = "verified"; delete item.error; this.save();
          } catch (e) {
            if (shouldReadmitUpload(e)) {
              delete item.assetId; delete item.admission; delete item.parts; delete item.transferred;
              delete item.proxyAdmission; delete item.proxyStatus;
            }
            item.state = "blocked"; item.error = `${suffix}: ${e.message}. Restore archived projects or resolve upload access/type/scanning before cleanup.`;
            item.attempts++; item.retryAt = Date.now() + Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 8));
            this.save(); throw new Error(item.error);
          }
          } catch (e) { blocked.push(e.message); }
        }
        if (blocked.length) throw new Error(blocked.join("; "));
        if (retired(p)) {
          this.report(p.id, "verifying", "Verifying every local byte version before cleanup");
          this.engine._projectMutation = true;
          this.engine.emit("local-paths-invalidated");
          try { await this.retire(p, identity, files); }
          finally { this.engine._projectMutation = false; }
        }
        this.report(p.id, retired(p) ? "retired" : "ready");
      } catch (e) {
        this.report(p.id, "blocked", e.message);
      }
    }
    // Pre-upgrade folders carry no trustworthy project id. Surface them rather
    // than deriving ownership from a title/number or sweeping their contents.
    const claimed = new Set(Object.values(this.data.projects).flatMap((p) =>
      [p.relativeDirectory, p.fencedDirectory, p.migratingFrom].filter(Boolean)));
    if (fs.existsSync(this.root)) {
      for (const client of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!client.isDirectory() || client.isSymbolicLink()) continue;
        try {
          const parent = safePath(this.root, client.name);
          for (const folder of fs.readdirSync(parent, { withFileTypes: true })) {
            const relative = `${client.name}/${folder.name}`;
            if (folder.isDirectory() && !claimed.has(relative)) {
              this.status.push({ projectId: 0, state: "blocked", message: `Unclaimed legacy directory ${relative}: positively identify its project before migration or cleanup. Files retained.` });
            }
          }
        } catch (e) { this.status.push({ projectId: 0, state: "blocked", message: e.message }); }
      }
    }
    this.watch();
  }
  watch() {
    const visit = (relative) => {
      const abs = safePath(this.root, relative);
      if (!fs.existsSync(abs) || !fs.lstatSync(abs).isDirectory()) return;
      this.watchers.push(fs.watch(abs, () => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.engine.syncOnce().catch((e) => this.engine.emit("error", e)), this.stabilityMs + 100);
      }));
      for (const name of fs.readdirSync(abs)) {
        const child = `${relative}/${name}`;
        const stat = fs.lstatSync(safePath(this.root, child));
        if (stat.isDirectory()) visit(child);
      }
    };
    for (const identity of Object.values(this.data.projects)) {
      try { visit(identity.fencedDirectory || identity.relativeDirectory); } catch (_) { /* already blocked by reconciliation */ }
    }
  }
  async receipt(p, item) {
    this.check();
    const receipt = await this.engine._json("GET", `/api/smart-cloud/assets/${item.assetId}/desktop-recoverability?desktopProjectId=${p.id}`, null);
    this.check();
    if (receipt.recoverable !== true || receipt.assetId !== item.assetId || receipt.projectId !== p.id ||
        receipt.relativePath !== item.relativePath || receipt.sha256 !== item.sha256 || receipt.size !== item.size)
      throw new Error("Cloud copy is unverified or quarantined");
  }
  async upload(p, item, file, options = {}) {
    this.check();
    const types = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
    const mimeType = types[path.extname(item.relativePath).toLowerCase()];
    if (!mimeType) throw new Error("Unsupported file type; preserve externally or move to an authorized recovery destination");
    if (!item.size) throw new Error("Empty file has no recoverable upload; retain until resolved");
    if (!item.assetId) {
      const admission = await this.engine._json("POST", "/api/smart-cloud/assets/presigned-upload", {
        filename: path.basename(item.relativePath), mimeType, fileSize: item.size,
        desktopSync: { projectId: p.id, relativePath: item.relativePath, sha256: item.sha256 },
      });
      this.check();
      item.assetId = admission.assetId;
      item.admission = admission;
      this.save();
    }
    const admission = item.admission;
    if (admission.alreadyUploaded) {
      await this.receipt(p, item);
      return;
    }
    if (options.deferTransfer) return;
    if (!item.transferred) {
      const put = (url, start, end) => new Promise((resolve, reject) => {
        this.check();
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1") return reject(new Error("Insecure upload destination"));
        const req = (parsed.protocol === "https:" ? https : http).request(parsed, {
          method: "PUT", headers: { "Content-Length": end - start + 1, "Content-Type": mimeType },
        }, (res) => {
          res.resume();
          res.on("error", reject);
          res.on("end", () => res.statusCode >= 200 && res.statusCode < 300
            ? resolve(res.headers.etag) : reject(new Error(`Upload HTTP ${res.statusCode}`)));
        });
        this.transfers.add(req);
        const checkScope = setInterval(() => {
          try { this.check(); } catch (error) { req.destroy(error); }
        }, 100);
        req.once("close", () => {
          clearInterval(checkScope);
          this.transfers.delete(req);
        });
        const stream = fs.createReadStream(file, { start, end });
        req.on("error", (e) => { stream.destroy(); reject(e); });
        stream.on("error", (e) => { req.destroy(); reject(e); });
        req.setTimeout(120000, () => req.destroy(new Error("Upload timed out")));
        stream.pipe(req);
      });
      if (admission.uploadUrl) {
        await put(admission.uploadUrl, 0, item.size - 1);
      } else if (Array.isArray(admission.partUrls) && admission.partSize > 0) {
        // A crash can occur after S3 accepts a part but before the local journal
        // is saved. Conversely local parts can outlive an aborted server upload.
        // The server's current listing, including gaps, is authoritative.
        const remote = await this.engine._json("GET",
          `/api/smart-cloud/assets/${item.assetId}/multipart-parts?desktopProjectId=${p.id}`, null);
        this.check();
        if (remote.assetId !== item.assetId || remote.projectId !== p.id ||
            remote.sha256 !== item.sha256 || remote.size !== item.size ||
            remote.uploadId !== admission.uploadId || remote.partSize !== admission.partSize ||
            remote.numberOfParts !== Math.ceil(item.size / admission.partSize) ||
            !Array.isArray(remote.parts))
          throw new Error("Multipart source identity changed; local original retained");
        const seen = new Set();
        for (const part of remote.parts) {
          if (!Number.isSafeInteger(part.PartNumber) || part.PartNumber < 1 ||
              part.PartNumber > remote.numberOfParts || seen.has(part.PartNumber) ||
              typeof part.ETag !== "string" || !part.ETag)
            throw new Error("Invalid server multipart listing; local original retained");
          seen.add(part.PartNumber);
        }
        item.parts = remote.parts;
        this.save();
        for (let i = 0; i < remote.numberOfParts; i++) {
          if (seen.has(i + 1)) continue;
          this.check();
          const fresh = await this.engine._json("POST",
            `/api/smart-cloud/assets/${item.assetId}/multipart-part-url?desktopProjectId=${p.id}`, { partNumber: i + 1 });
          this.check();
          if (fresh.partNumber !== i + 1 || typeof fresh.uploadUrl !== "string")
            throw new Error("Invalid refreshed multipart admission");
          const etag = await put(fresh.uploadUrl, i * admission.partSize, Math.min(item.size, (i + 1) * admission.partSize) - 1);
          if (typeof etag !== "string" || !etag) throw new Error("Upload response omitted part ETag; reconcile before retry");
          item.parts.push({ PartNumber: i + 1, ETag: etag }); this.save();
        }
        item.parts.sort((a, b) => a.PartNumber - b.PartNumber);
      } else throw new Error("Upload admission returned no transfer URL");
      item.transferred = true; this.save();
    }
    if (!same(item, fingerprint(file))) throw new Error("File changed during transfer");
    this.check();
    const multipart = !!admission.uploadId;
    await this.engine._json("POST", `/api/smart-cloud/assets/${item.assetId}/${multipart ? "complete-multipart" : "confirm-upload"}?desktopProjectId=${p.id}`,
      multipart ? { uploadId: admission.uploadId, parts: item.parts } : {});
    await this.receipt(p, item);
  }
  async uploadProxy(p, item) {
    this.check();
    const proxy = item.proxy;
    if (!proxy || !item.proxyFile) throw new Error("Prepared proxy is unavailable; original retained");
    if (!item.proxyAdmission) {
      item.proxyAdmission = await this.engine._json(
        "POST",
        `/api/smart-cloud/assets/${item.assetId}/desktop-proxy-admission?desktopProjectId=${p.id}`,
        { proxySha256: proxy.proxySha256, proxySize: proxy.proxySize, metadata: proxy.media },
      );
      this.save();
    }
    const parsed = new URL(item.proxyAdmission.uploadUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1")
      throw new Error("Insecure proxy upload destination");
    await new Promise((resolve, reject) => {
      const transport = parsed.protocol === "https:" ? https : http;
      const req = transport.request(parsed, {
        method: "PUT",
        headers: { "Content-Length": proxy.proxySize, "Content-Type": "video/mp4" },
      }, (res) => {
        res.resume();
        res.on("end", () => res.statusCode >= 200 && res.statusCode < 300
          ? resolve() : reject(new Error(`Proxy upload HTTP ${res.statusCode}`)));
      });
      const stream = fs.createReadStream(item.proxyFile);
      this.transfers.add(req);
      const checkScope = setInterval(() => {
        try { this.check(); } catch (error) { req.destroy(error); }
      }, 100);
      req.once("close", () => {
        clearInterval(checkScope);
        this.transfers.delete(req);
      });
      req.on("error", (error) => { stream.destroy(); reject(error); });
      stream.on("error", (error) => { req.destroy(error); reject(error); });
      req.setTimeout(120000, () => req.destroy(new Error("Proxy upload timed out")));
      stream.pipe(req);
    });
    await this.engine._json(
      "POST",
      `/api/smart-cloud/assets/${item.assetId}/desktop-proxy-complete?desktopProjectId=${p.id}`,
      { proxySha256: proxy.proxySha256, proxySize: proxy.proxySize },
    );
  }
  async retire(p, identity, initial) {
    this.check();
    if (!canRetireLocalFiles(this.engine.user))
      throw new Error("Client local originals are never automatically removed");
    const fresh = await this.engine._json("GET", `/api/sync/projects/${p.id}/retirement`, null);
    if (fresh.version !== 2 || fresh.complete !== true || fresh.accountId !== this.manifest.accountId ||
        !Number.isFinite(Date.parse(fresh.generatedAt)) || Math.abs(Date.now() - Date.parse(fresh.generatedAt)) > 60000)
      throw new Error("Cannot reauthorize project cleanup");
    const current = fresh.project;
    validateProject(current, this.root);
    if (!current || current.projectId !== p.id || !retired(current) || current.revision !== p.revision || current.relativeDirectory !== p.relativeDirectory)
      throw new Error("Project changed or access lost; cleanup cancelled");
    this.check();
    if ([...this.readers.values()].some((n) => n > 0)) throw new Error("Local playback is active; cleanup deferred");
    if (this.engine._fileDownloadInflight.size) throw new Error("Download in progress; cleanup deferred");
    for (const file of initial) {
      const directory = identity.fencedDirectory || identity.relativeDirectory;
      const suffix = file.relative.slice(directory.length + 1);
      if (transient(path.basename(suffix))) continue;
      const canonical = `${identity.relativeDirectory}/${suffix}`;
      if (same(this.data.downloads[canonical], file)) {
        // Download bytes need a currently authorized cloud counterpart too.
        const remote = this.data.downloads[canonical]?.remote;
        if (!remote) throw new Error("Downloaded file no longer has authoritative cloud coverage");
        const query = new URLSearchParams({ sha256: file.sha256, size: String(file.size), projectId: String(p.id) });
        if (remote.derivative) query.set("derivative", remote.derivative);
        const result = await this.engine._json("GET", `/api/sync/download/${remote.id}/coverage?${query}`, null);
        if (result.recoverable !== true || result.assetId !== remote.id || result.projectId !== p.id ||
            result.sha256 !== file.sha256 || result.size !== file.size ||
            (result.derivative || null) !== (remote.derivative || null))
          throw new Error("Cloud download coverage unavailable or does not match local bytes");
      } else {
        const item = this.data.queue[`${p.id}:${suffix}`];
        if (!item || item.state !== "verified" || !same(item, file)) throw new Error("Latest bytes lack cloud coverage");
        await this.receipt(p, item);
      }
    }
    const final = await this.engine._json("GET", `/api/sync/projects/${p.id}/retirement`, null);
    const finalProject = final.project;
    validateProject(finalProject, this.root);
    if (final.version !== 2 || final.complete !== true || final.accountId !== this.manifest.accountId ||
        !Number.isFinite(Date.parse(final.generatedAt)) || Math.abs(Date.now() - Date.parse(final.generatedAt)) > 60000 ||
        !finalProject || finalProject.projectId !== p.id || finalProject.revision !== p.revision ||
        finalProject.relativeDirectory !== p.relativeDirectory || !retired(finalProject))
      throw new Error("Project changed during verification; cleanup cancelled");
    this.check();
    if ([...this.readers.values()].some((n) => n > 0) || this.engine._fileDownloadInflight.size)
      throw new Error("Local read/download lease blocks cleanup");
    let dir = identity.fencedDirectory || identity.relativeDirectory;
    if (JSON.stringify(this.scan(dir)) !== JSON.stringify(initial)) throw new Error("Late local write; cleanup deferred");
    // Rename is the namespace fence. Persist intent before moving for crash recovery.
    if (!identity.fencedDirectory) {
      const fenced = `${path.posix.dirname(dir)}/.retiring-${p.id}-${crypto.randomUUID()}`;
      identity.fencedDirectory = fenced; identity.fencePending = true; this.save();
      this.engine.emit("local-paths-invalidated");
      try { fs.renameSync(safePath(this.root, dir), safePath(this.root, fenced)); }
      catch (e) { delete identity.fencedDirectory; delete identity.fencePending; this.save(); throw e; }
      delete identity.fencePending; this.save();
      dir = fenced;
      // Allow open writers to settle; next reconciliation hashes the fenced bytes.
      throw new Error("Project fenced for cleanup; waiting for final stability check");
    }
    // Fail closed on an externally recreated path rather than touching either copy.
    if (fs.existsSync(safePath(this.root, identity.relativeDirectory)))
      throw new Error("Project folder recreated during retirement; resolve both copies");
    // Do NOT recursively rm: revalidate each file and directory without following links.
    for (const file of initial) {
      this.check();
      const abs = safePath(this.root, file.relative);
      if (!same(file, fingerprint(abs))) throw new Error("Late write in fenced folder");
    }
    const remove = (relative) => {
      const abs = safePath(this.root, relative);
      for (const name of fs.readdirSync(abs)) {
        const child = `${relative}/${name}`;
        const target = safePath(this.root, child);
        if (fs.lstatSync(target).isDirectory()) remove(child);
        else {
          this.check();
          if (!canRetireLocalFiles(this.engine.user)) throw new Error("Cleanup permission changed; files retained");
          const expected = initial.find((f) => f.relative === child);
          if (!expected || !same(expected, fingerprint(target))) throw new Error("Concurrent write; remaining files retained");
          fs.unlinkSync(target);
        }
      }
      fs.rmdirSync(abs);
    };
    remove(dir);
    this.data.reclaimedBytes = (this.data.reclaimedBytes || 0) + initial.reduce((sum, f) => sum + f.size, 0);
    delete identity.fencedDirectory;
    identity.retiredRevision = p.revision;
    this.save();
  }
  recordDownload(relative, remote) {
    if (!this.data) return;
    this.check();
    this.data.downloads[relative] = { ...fingerprint(safePath(this.root, relative)), remote };
    if (this.data.deletedDownloads) delete this.data.deletedDownloads[relative];
    this.save();
  }
}
module.exports = { ProjectSync, safePath, fingerprint, retired, mountPaths, shouldReadmitUpload };
