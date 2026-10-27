// Explicit cloud-deletion receipts only. Manifest absence is never authority.
const fs = require("fs");
const path = require("path");
const validGeneration = value => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const candidate = remote => ({ id: remote.id, clientId: remote.clientId,
  projectId: remote.projectId, generation: remote.generation });
const matches = (a, b) => ["id", "clientId", "projectId", "generation"].every(k => a?.[k] === b?.[k]);
// Recovery downloads contain operator-originating bytes, not disposable cloud
// originals. Protect both current markers and older/path-only journal entries.
const protectedRecovery = (remote, relative = "") => remote?.localDeletionProtected === true ||
  remote?.desktopRecovery === true || remote?.kind === "desktop_recovery" ||
  /\/desktop-recovery-download(?:\?|$)/.test(remote?.downloadPath || "") ||
  relative.split("/").some(part => part.toLowerCase() === "operator-uploads");

class DeletedDownloads {
  constructor(sync, helpers) {
    this.sync = sync;
    Object.assign(this, helpers);
  }
  entries() { return this.sync.data?.deletedDownloads || {}; }
  blocks(relative) {
    const entry = this.entries()[relative];
    if (protectedRecovery(entry?.remote, relative)) return false;
    return entry?.authorized === true && entry.state !== "completed";
  }
  deleted(file) {
    if (protectedRecovery(file, file.relativePath || file.name)) return false;
    const entry = this.entries()[file.relativePath || file.name];
    return entry?.authorized === true && matches(entry.remote, file);
  }
  snapshot() {
    const entries = Object.entries(this.entries());
    return {
      pending: entries.filter(([, e]) => e.state === "pending").length,
      completed: entries.filter(([, e]) => e.state === "completed").length,
      blocked: entries.filter(([, e]) => e.state === "blocked").length,
      issues: entries.filter(([, e]) => e.state !== "completed" && e.reason)
        .map(([relativePath, e]) => ({ projectId: e.remote?.projectId || 0, relativePath,
          reason: e.reason, remedy: e.protectedRecovery
            ? "Preserve this operator recovery copy outside the sync folder if you need it permanently. Remove it manually only if unwanted; cloud deletion never removes it."
            : "Close playback or other apps and sync again. For modified or legacy files, preserve them outside the sync folder and remove the unwanted copy manually." })),
    };
  }
  async authority(remotes) {
    const s = this.sync;
    s.check();
    const response = await s.engine._json("POST", "/api/sync/deletions/reconcile",
      { candidates: remotes.map(candidate) });
    s.check();
    if (!this.canRetireLocalFiles(s.engine.user) || response?.version !== 1 ||
        response.complete !== true || response.accountId !== s.engine.user.id ||
        !Number.isFinite(Date.parse(response.generatedAt)) ||
        Math.abs(Date.now() - Date.parse(response.generatedAt)) > 60000 ||
        !Array.isArray(response.results) || response.results.length !== remotes.length ||
        response.results.some((r, i) => !matches(r, remotes[i]) || typeof r.deleted !== "boolean"))
      throw new Error("Complete current deletion receipts unavailable; downloads retained. Update the server/desktop and sync again.");
    return response.results;
  }
  async reconcile() {
    const s = this.sync;
    if (!this.canRetireLocalFiles(s.engine.user)) return;
    s.data.deletedDownloads ||= {};
    const selected = JSON.stringify(s.engine.config.config.get("selectedClients") || []);
    const selectionCheck = () => {
      s.check();
      if (selected !== JSON.stringify(s.engine.config.config.get("selectedClients") || []))
        throw new Error("Sync selection changed; downloads retained");
    };
    const downloads = Object.entries(s.data.downloads);
    for (let offset = 0; offset < downloads.length; offset += 100) {
      const batch = downloads.slice(offset, offset + 100);
      const eligible = [];
      for (const [relative, download] of batch) {
        const remote = download.remote;
        const old = this.entries()[relative];
        const listed = s.manifest.files.some(f => f.relativePath === relative);
        if (protectedRecovery(remote, relative)) {
          if (!listed || old) s.data.deletedDownloads[relative] = {
            state: "blocked", remote, authorized: false, protectedRecovery: true,
            reason: "Operator recovery copy retained: operator-originating files are never removed by cloud-deletion cleanup.",
          };
          continue;
        }
        if (old?.state === "completed") continue;
        if (!remote || !validGeneration(remote.generation)) {
          if (!listed) s.data.deletedDownloads[relative] = { ...old, state: "blocked", remote,
            reason: "Legacy download has no exact source identity. File retained; preserve outside sync or remove manually." };
          continue;
        }
        const project = s.manifest.projects.find(p => p.projectId === remote.projectId && p.clientId === remote.clientId);
        const selection = JSON.parse(selected);
        if (!project || selection.length && !selection.includes(remote.clientId)) {
          if (!listed) s.data.deletedDownloads[relative] = { ...old, state: "blocked", remote,
            reason: "Project permission or sync selection unavailable; restore access/selection and sync again." };
          continue;
        }
        eligible.push([relative, download]);
      }
      if (!eligible.length) { s.save(); continue; }
      let receipts;
      try {
        receipts = await this.authority(eligible.map(([, d]) => d.remote));
        selectionCheck();
      } catch (error) {
        for (const [relative, download] of eligible) {
          if (!s.manifest.files.some(f => f.relativePath === relative))
            s.data.deletedDownloads[relative] = { ...this.entries()[relative],
              state: "blocked", remote: download.remote, reason: error.message };
        }
        s.save();
        continue;
      }
      for (let i = 0; i < eligible.length; i++) {
        const [relative, download] = eligible[i];
        if (!receipts[i].deleted) {
          delete s.data.deletedDownloads[relative];
          s.save();
          continue;
        }
        const entry = s.data.deletedDownloads[relative] = { remote: download.remote, state: "pending", authorized: true };
        s.save(); // deletion intent survives process exit before/after unlink
        try {
          selectionCheck();
          if (protectedRecovery(download.remote, relative))
            throw new Error("Operator recovery copy retained; automatic per-file deletion is prohibited");
          const identity = s.data.projects[download.remote.projectId];
          if (!identity || !relative.startsWith(identity.relativeDirectory + "/") ||
              identity.migratingFrom || identity.fencePending)
            throw new Error("Download/project ownership is ambiguous; file retained");
          const actualRelative = identity.fencedDirectory
            ? identity.fencedDirectory + relative.slice(identity.relativeDirectory.length) : relative;
          const abs = this.safePath(s.root, actualRelative);
          // No await after this final receipt and rehash until the actual unlink.
          const [fresh] = await this.authority([download.remote]);
          selectionCheck();
          if (!fresh.deleted) { delete s.data.deletedDownloads[relative]; s.save(); continue; }
          s.engine.emit("local-paths-invalidated");
          if (s.engine._fileDownloadInflight.size || s.readers.get(path.resolve(abs)) > 0)
            throw new Error("Active playback/download; close playback and sync again");
          if (s.data.downloads[relative] !== download)
            throw new Error("Download generation changed; file retained");
          const target = this.safePath(s.root, actualRelative);
          if (fs.existsSync(target)) {
            if (protectedRecovery(download.remote, relative))
              throw new Error("Operator recovery copy retained; automatic per-file deletion is prohibited");
            if (!this.same(download, this.fingerprint(target)))
              throw new Error("Downloaded file was modified or replaced; preserve it outside sync or remove manually");
            selectionCheck();
            if (!this.canRetireLocalFiles(s.engine.user)) throw new Error("Cleanup permission changed; file retained");
            fs.unlinkSync(this.safePath(s.root, actualRelative));
            s.data.reclaimedBytes = (s.data.reclaimedBytes || 0) + download.size;
          }
          entry.state = "completed";
          // Only the exact download record is settled; operator upload records
          // and other local bytes still require verified backup at retirement.
          download.deletionReceipt = candidate(download.remote);
          s.engine.lastFiles = (s.engine.lastFiles || []).filter(f => f.relativePath !== relative);
          s.save();
        } catch (error) {
          entry.state = /Active playback|EBUSY|EPERM|EACCES/.test(error.message) ? "pending" : "blocked";
          entry.reason = error.message;
          s.save();
        }
      }
    }
    s.engine.emitStatus?.();
  }
}
module.exports = { DeletedDownloads };
