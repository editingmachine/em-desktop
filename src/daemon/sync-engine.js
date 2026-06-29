// Task #1742 — reusable background sync engine for the desktop daemon.
//
// Extracted from sync-cli/index.js. This is the headless "file sync" core:
//   - authenticate against the portal (cookie session) and store the token,
//   - register the device + post heartbeats with disk/sync metrics,
//   - pull the assigned client/project manifest,
//   - download new files (with pause/resume/cancel + progress),
//   - clean up files that were removed server-side,
//   - report status via an event callback the UI/tray can subscribe to.
//
// It is intentionally decoupled from any UI — the Electron main process and the
// tray both drive it through this class.
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { EventEmitter } = require("events");

const DEFAULT_API_BASE =
  process.env.EM_API_URL || "https://editingmachine.app";

class SyncEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.apiBase = opts.apiBase || DEFAULT_API_BASE;
    this.config = opts.config; // daemon/config.js
    this.keychain = opts.keychain; // daemon/keychain.js
    this.getDiskUsage = opts.getDiskUsage; // daemon/disk.js
    this.token = null;
    this.user = null;
    this.state = "idle"; // idle | syncing | paused | error
    this.paused = false;
    this.cancelled = false;
    this.currentFile = null;
    // Task #1938 — the project whose file is currently being downloaded, so the
    // window can mark the active row. Cleared when the sweep goes idle.
    this.currentProject = null;
    this.filesSynced = 0;
    this.filesPending = 0;
    // Task #1938 — per-project breakdown of the LATEST manifest, grouped by the
    // human project name already on each file. Each entry is
    // { projectName, localFiles, pendingFiles, totalFiles }; the live `active`
    // flag is layered on at emit time (see getStatusSnapshot) so a pause can't
    // leave a stale "downloading" marker baked into the array.
    this.projectBreakdown = [];
    this._timer = null;
    // Task #1758 — last manifest's file list, kept so the local-proxy
    // bridge can map an assetId back to a synced file on disk. Best-effort:
    // entries only carry an assetId once the manifest starts emitting one.
    this.lastFiles = [];
    // Task #1920 — trigger-based per-asset sync. Maps an in-flight asset key to
    // its download promise so rapid repeated triggers for the SAME asset are
    // coalesced into one download instead of racing N concurrent fetches.
    this._assetSyncInflight = new Map();
    // Task #1920 — shared single-flight per DESTINATION FILE across BOTH the
    // periodic `syncOnce` sweep and the on-demand `syncAsset` trigger. Whichever
    // path reaches a file first owns its download; the other joins that same
    // promise instead of starting a second fetch to the same `.part` temp file.
    // This is the real "no duplicate/concurrent downloads" guarantee — the
    // per-asset map above only coalesces trigger↔trigger, this covers
    // sweep↔trigger too.
    this._fileDownloadInflight = new Map();
    // Task #2164 — Dropbox-grade download reliability. A single per-file
    // attempt with no integrity check let a transient blip (network drop, 5xx,
    // expired-link 403) or a half-written/corrupt file sit pending until the
    // next ~5-min sweep. We now retry transient failures with exponential
    // backoff (fetching a FRESH presigned URL each attempt) and verify the
    // downloaded byte count against the expected size before accepting a file.
    this._maxDownloadAttempts = Number(opts.maxDownloadAttempts) || 3;
    // Base backoff in ms; the Nth retry waits base * 2^(attempt-1) (+ jitter).
    // Configurable so tests can drive it to ~0 instead of waiting seconds.
    this._downloadRetryBaseMs =
      opts.downloadRetryBaseMs != null ? Number(opts.downloadRetryBaseMs) : 500;
  }

  // Task #2164 — backoff sleep, isolated so tests can stub it to run instantly.
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  // Task #2164 — exponential backoff (with small jitter) for the Nth retry.
  _downloadRetryDelayMs(attempt) {
    const base = this._downloadRetryBaseMs * Math.pow(2, Math.max(0, attempt - 1));
    return base + Math.floor(Math.random() * Math.min(base, 250));
  }

  // Task #2164 — classify a download failure as transient (worth retrying with
  // a fresh URL) vs permanent. Transient: any network/socket error, an HTTP 5xx,
  // a request-timeout (408), rate-limit (429), an expired-link 403, or our own
  // post-download size-mismatch. Permanent: a genuine 404 (object missing on the
  // cloud — stays honestly pending), a 'no-url' response, or a user cancel.
  _isRetryableDownloadError(err) {
    const msg = (err && err.message ? err.message : String(err || "")).toLowerCase();
    if (!msg) return false;
    if (msg.includes("cancelled")) return false;
    if (msg.includes("size-mismatch")) return true;
    const httpMatch = msg.match(/http (\d{3})/);
    if (httpMatch) {
      const code = Number(httpMatch[1]);
      if (code === 403 || code === 408 || code === 429) return true;
      if (code >= 500) return true;
      return false; // 404 and other 4xx are not retryable.
    }
    // Bare network / socket failures have no HTTP code — treat as transient.
    return true;
  }

  // Task #2164 — single source of truth for the "already on disk?" check.
  // When the expected size is known and non-zero we require an exact match.
  // When it is unknown (0/missing) — which would make `actual === 0` never
  // match a real file and re-download it on EVERY sweep forever — we accept any
  // non-empty file that is already on disk as present. The server normally
  // ships a real size now (Task #2164 steps 4/5); this is the defensive guard.
  _isFileLocal(dest, expectedSize) {
    try {
      if (!fs.existsSync(dest)) return false;
      const actual = fs.statSync(dest).size;
      const expected = Number(expectedSize) || 0;
      if (expected > 0) return actual === expected;
      return actual > 0;
    } catch (_) {
      return false;
    }
  }

  // Task #1938 — single source of truth for the status payload the UI/tray
  // consume, so the live "status" event and the on-demand `sync:status` IPC
  // pull (main/index.js) can never drift apart. The per-project `active` flag is
  // computed HERE (not stored on the array) so it always reflects the current
  // state: it is only true while we're actively syncing the project that owns
  // the in-flight file, and clears the moment we pause / go idle.
  getStatusSnapshot() {
    const activeProject = this.currentProject || null;
    const projects = (this.projectBreakdown || []).map((p) => ({
      projectName: p.projectName,
      localFiles: p.localFiles,
      pendingFiles: p.pendingFiles,
      totalFiles: p.totalFiles,
      active: this.state === "syncing" && p.projectName === activeProject,
    }));
    return {
      state: this.state,
      paused: this.paused,
      currentFile: this.currentFile,
      currentProject: activeProject,
      filesSynced: this.filesSynced,
      filesPending: this.filesPending,
      projects,
      user: this.user ? { email: this.user.email, name: this.user.name } : null,
    };
  }

  emitStatus() {
    this.emit("status", this.getStatusSnapshot());
  }

  // Task #1938 — rebuild the per-project breakdown from the LATEST manifest file
  // list (`this.lastFiles`), grouping by the human project name already carried
  // on each file and counting how many of each project's files are already on
  // the local drive at the right size vs still pending download. Best-effort:
  // a failed stat just counts that file as pending. Called whenever the manifest
  // changes or a download lands so the window reflects live progress.
  _recomputeProjectBreakdown() {
    const root = this.config.getSyncFolder();
    const byProject = new Map();
    for (const f of this.lastFiles || []) {
      const projectName = (f && f.projectName) || "General";
      let entry = byProject.get(projectName);
      if (!entry) {
        entry = { projectName, localFiles: 0, pendingFiles: 0, totalFiles: 0 };
        byProject.set(projectName, entry);
      }
      entry.totalFiles += 1;
      const dest = path.join(root, f.relativePath || f.name);
      const onDisk = this._isFileLocal(dest, f.size);
      if (onDisk) entry.localFiles += 1;
      else entry.pendingFiles += 1;
    }
    // Stable alphabetical order so rows don't jump around between updates.
    this.projectBreakdown = Array.from(byProject.values()).sort((a, b) =>
      a.projectName.localeCompare(b.projectName),
    );
  }

  async restoreSession() {
    this.token = await this.keychain.getSecret();
    this.user = this.config.config.get("user") || null;
    return !!this.token;
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  // ---- Auth ---------------------------------------------------------------
  async login(email, password) {
    const syncFolder = this.config.getSyncFolder();
    if (!fs.existsSync(syncFolder)) fs.mkdirSync(syncFolder, { recursive: true });

    const res = await this._json("POST", "/api/sync/auth", {
      email,
      password,
      deviceId: this.config.getDeviceId(),
      deviceName: require("os").hostname(),
      deviceType: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux",
      syncFolder,
    });
    if (!res || !res.success) throw new Error(res?.error || "Login failed");

    this.token = res.authToken;
    this.user = res.user;
    await this.keychain.setSecret(res.authToken);
    this.config.config.set("user", res.user);
    await this.registerDevice();
    this.emitStatus();
    return res.user;
  }

  async logout() {
    this.stop();
    try {
      await this._json("POST", "/api/sync/logout", {});
    } catch (_) {}
    this.token = null;
    this.user = null;
    await this.keychain.clearSecret();
    this.config.config.delete("user");
    this.state = "idle";
    this.emitStatus();
  }

  // ---- Device registry / heartbeat (Task #1742 server endpoints) ----------
  async registerDevice() {
    const os = require("os");
    return this._json("POST", "/api/devices/register", {
      deviceId: this.config.getDeviceId(),
      deviceName: os.hostname(),
      osType: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux",
      osVersion: os.release(),
      appVersion: require("../../package.json").version,
      syncFolder: this.config.getSyncFolder(),
    });
  }

  async heartbeat() {
    if (!this.token) return;
    let disk = { totalBytes: null, freeBytes: null, usedBytes: null };
    try {
      disk = await this.getDiskUsage(this.config.getSyncFolder());
    } catch (_) {}
    try {
      await this._json("POST", "/api/devices/heartbeat", {
        deviceId: this.config.getDeviceId(),
        metrics: {
          diskTotalBytes: disk.totalBytes,
          diskFreeBytes: disk.freeBytes,
          diskUsedBytes: disk.usedBytes,
          syncStatus: this.state,
          filesPending: this.filesPending,
          filesSynced: this.filesSynced,
          currentFile: this.currentFile,
        },
      });
    } catch (err) {
      this.emit("error", err);
    }
  }

  // ---- Sync loop ----------------------------------------------------------
  start() {
    if (this._timer) return;
    const intervalMin = this.config.config.get("syncInterval") || 5;
    this.paused = false;
    this.cancelled = false;
    const tick = async () => {
      await this.syncOnce().catch((e) => this.emit("error", e));
      await this.heartbeat();
    };
    tick();
    this._timer = setInterval(tick, intervalMin * 60 * 1000);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.cancelled = true;
  }

  pause() {
    this.paused = true;
    this.cancelled = true; // abort in-flight download
    this.state = "paused";
    this.emitStatus();
  }

  resume() {
    this.paused = false;
    this.cancelled = false;
    this.state = "idle";
    this.emitStatus();
    this.syncOnce().catch((e) => this.emit("error", e));
  }

  async syncOnce() {
    if (this.paused || !this.token) return { downloaded: 0 };
    this.state = "syncing";
    this.emitStatus();

    let downloaded = 0;
    try {
      const selected = this.config.config.get("selectedClients") || [];
      const manifest = await this._json("GET", "/api/sync/manifest", null);
      const files = (manifest?.files || []).filter((f) =>
        selected.length === 0 ? true : selected.includes(f.clientId),
      );
      this.lastFiles = files;

      this.filesPending = files.length;
      // Task #1938 — seed the per-project breakdown from the fresh manifest
      // before we start downloading so the window shows correct local-vs-pending
      // counts immediately, not only after the first file lands.
      this._recomputeProjectBreakdown();
      this.emitStatus();

      // Aggregate progress across the WHOLE batch. A per-file percentage resets
      // to ~0 at the start of every file, and with several small files per
      // asset (scrub proxy + keyframe sidecar + all-intra MP4) that made the
      // bar flicker between 0 and the real value. Instead we report
      // (bytes done so far / total bytes to download), so the bar climbs once,
      // smoothly, to 100. Only files we will actually fetch (not those already
      // on disk at the right size) count toward the total.
      const needsDownload = (f) => {
        const d = path.join(this.config.getSyncFolder(), f.relativePath || f.name);
        return !this._isFileLocal(d, f.size);
      };
      const totalBytes = files
        .filter(needsDownload)
        .reduce((sum, f) => sum + (Number(f.size) || 0), 0);
      let completedBytes = 0;
      // Monotonic guard for THIS batch: manifest sizes (used for the total) and
      // the live received-byte count can disagree (stale/approximate sizes), so
      // a naive ratio could briefly tick backwards. We never emit a percent
      // lower than the highest already shown, so the bar only ever moves
      // forward within a sync run.
      let lastPct = 0;
      // Per-file failures encountered this sweep. A single bad file (e.g. a
      // missing/expired S3 object that 403s, or a transient network blip) must
      // NEVER halt the whole sweep — every OTHER file still needs to download.
      let failed = 0;

      for (const file of files) {
        if (this.paused || this.cancelled) break;
        const dest = path.join(this.config.getSyncFolder(), file.relativePath || file.name);
        if (this._isFileLocal(dest, file.size)) continue;

        this.currentFile = file.name;
        // Task #1938 — remember which project this in-flight file belongs to so
        // the window can mark exactly one row as actively downloading.
        this.currentProject = file.projectName || "General";
        this.emitStatus();

        const fileBytes = Number(file.size) || 0;
        // Per-file isolation: one file's failure must not abort the sweep.
        // Without this try/catch a single non-200 download (or a failed
        // `.../complete` POST) rejected out of the for-loop, jumped to the
        // outer catch, and left EVERY file after it permanently pending —
        // the sync would wedge behind the first bad file forever. We now log
        // the failure, leave that one file pending (honest count), and keep
        // going so the rest of the batch still syncs.
        try {
          // Task #1759 — the server may hand us a derivative-specific download
          // path (scrub proxy) via `downloadPath`; fall back to the
          // master-asset route otherwise. Task #1920 — routed through the
          // shared single-flight helper so a concurrent on-demand `syncAsset`
          // trigger for the same file never starts a second download.
          const result = await this._downloadFileTracked(file, (filePct, receivedBytes) => {
            // Overall batch percentage, clamped to 100 then held monotonic so a
            // slightly-off content-length can never overshoot or snap backwards.
            // Falls back to the per-file pct only when we have no byte totals.
            const raw =
              totalBytes > 0
                ? Math.min(
                    100,
                    Math.round(((completedBytes + (receivedBytes || 0)) / totalBytes) * 100),
                  )
                : filePct;
            lastPct = Math.max(lastPct, raw);
            this.emit("progress", { file: file.name, pct: lastPct, bytes: file.size });
          });
          // "coalesced" = a trigger fetched this same file while we were
          // sweeping; it's on disk now, so still advance the batch but don't
          // double-count it.
          if (result.status === "downloaded") {
            downloaded += 1;
            this.filesSynced += 1;
          }
          if (result.status === "downloaded" || result.status === "coalesced") {
            completedBytes += fileBytes;
          }
          if (result.status === "no-url") {
            // No presigned URL came back (e.g. the asset has no stored file) —
            // count it as a skipped failure rather than a success.
            failed += 1;
          } else {
            this.filesPending = Math.max(0, this.filesPending - 1);
          }
        } catch (err) {
          failed += 1;
          console.warn(
            `[SYNC] skipping "${file.name}" (asset ${file.id}) — download failed, will retry next sweep:`,
            err && err.message ? err.message : err,
          );
          // Count this file's bytes as "done" for the progress bar so one
          // stuck file can't peg the bar below 100 for the whole sweep.
          completedBytes += fileBytes;
        }
        // Task #1938 — recompute so this project's row moves a file from
        // pending → local the moment the download lands.
        this._recomputeProjectBreakdown();
        this.emitStatus();
      }

      if (failed > 0) {
        console.warn(
          `[SYNC] sweep finished with ${failed} file(s) skipped after errors; the rest synced. They will be retried on the next sweep.`,
        );
      }

      await this._cleanupRemoved(files);
      this.currentFile = null;
      this.currentProject = null;
      this.state = this.paused ? "paused" : "idle";
      // Task #1938 — final recompute after cleanup so removed-server-side files
      // drop out of the breakdown and the all-synced state reads honestly.
      this._recomputeProjectBreakdown();
      this.emitStatus();
      return { downloaded };
    } catch (err) {
      this.state = "error";
      this.emitStatus();
      throw err;
    }
  }

  // ---- Trigger-based per-asset sync (Task #1920) --------------------------
  // Fetch a SINGLE asset's derivatives on demand, the moment a clip needs it
  // on the timeline, instead of waiting for the next slow `syncOnce` sweep.
  // Reuses the existing manifest + per-file download logic — it pulls the same
  // manifest, keeps only this asset's entries, and downloads the ones not yet
  // on disk at the right size.
  //
  // Coalesced: rapid repeated triggers for the same asset return the SAME
  // in-flight promise, so an asset is never downloaded twice at once. The
  // scheduled full sweep is untouched and still runs as the safety net.
  async syncAsset(assetId) {
    const id = Number(assetId);
    if (!Number.isFinite(id) || id <= 0) return { downloaded: 0 };
    if (!this.token || this.paused) return { downloaded: 0 };
    const key = String(id);
    const existing = this._assetSyncInflight.get(key);
    if (existing) return existing;
    const p = this._syncAssetInner(id).finally(() => {
      this._assetSyncInflight.delete(key);
    });
    this._assetSyncInflight.set(key, p);
    return p;
  }

  async _syncAssetInner(id) {
    let downloaded = 0;
    try {
      const selected = this.config.config.get("selectedClients") || [];
      const manifest = await this._json("GET", "/api/sync/manifest", null);
      const allFiles = (manifest?.files || []).filter((f) =>
        selected.length === 0 ? true : selected.includes(f.clientId),
      );
      // Keep lastFiles fresh so resolveLocalScrubSource can map the asset's
      // files to disk as soon as the on-demand download lands.
      this.lastFiles = allFiles;

      const files = allFiles.filter((f) => Number(f && f.id) === id);
      for (const file of files) {
        if (this.paused || this.cancelled) break;
        // Task #1920 — shared single-flight: if the periodic sweep (or an
        // earlier trigger) is already fetching this exact file, join it rather
        // than racing a second download to the same temp file.
        const result = await this._downloadFileTracked(file);
        if (result.status === "downloaded") {
          downloaded += 1;
          this.filesSynced += 1;
        }
      }
      // Task #1938 — refresh the breakdown so a triggered asset's files also
      // move pending → local in the window, not just sweep downloads.
      this._recomputeProjectBreakdown();
      if (downloaded > 0) this.emitStatus();
      return { downloaded };
    } catch (err) {
      this.emit("error", err);
      return { downloaded };
    }
  }

  // Remove local files that no longer exist in the manifest (best-effort).
  async _cleanupRemoved(files) {
    try {
      const wanted = new Set(
        files.map((f) => path.join(this.config.getSyncFolder(), f.relativePath || f.name)),
      );
      const root = this.config.getSyncFolder();
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (!wanted.has(full)) {
            try {
              fs.unlinkSync(full);
            } catch (_) {}
          }
        }
      };
      if (fs.existsSync(root) && this.config.config.get("cleanupRemoved")) walk(root);
    } catch (_) {}
  }

  // ---- Instant local scrub source (Task #1766) ----------------------------
  // Resolve the local scrub source for an asset: the all-intra progressive MP4
  // (`proxy_intra`, every frame an IDR) so the native <video> element seeks to
  // the exact frame instantly with NO keyframe-index sidecar and NO WebCodecs/
  // byte-range demuxing. Returns null on every "not here" path so the web layer
  // cleanly falls back to the network "Quick preview".
  //
  // Returns { filePath, scrubSource: 'all-intra' } or null.
  resolveLocalScrubSource(assetId) {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return null;

      const root = this.config.getSyncFolder();
      const matches = (this.lastFiles || []).filter(
        (f) => Number(f && (f.assetId ?? f.asset_id)) === id,
      );
      if (matches.length === 0) return null;

      // The all-intra progressive MP4 is independently seekable, no sidecar
      // needed. Only when the file is actually on disk; if it is in the
      // manifest but the download hasn't landed yet we return null so the web
      // layer falls back to the network preview (honest, never a hard error).
      const intra = matches.find((f) => f && f.proxyKind === "all-intra");
      if (intra) {
        const intraPath = path.join(root, intra.relativePath || intra.name || "");
        if (intraPath && fs.existsSync(intraPath)) {
          return { filePath: intraPath, scrubSource: "all-intra" };
        }
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  // Download a single manifest file with shared single-flight per destination
  // (Task #1920). Returns one of:
  //   { status: "present" }     — already on disk at the right size, skipped
  //   { status: "downloaded" }  — this call fetched it
  //   { status: "coalesced" }   — another in-flight call (sweep or trigger) is
  //                               already fetching this exact file; we joined it
  //   { status: "no-url" }      — server returned no presigned URL
  // Honours pause/cancel via the underlying `_download`.
  async _downloadFileTracked(file, onProgress) {
    const dest = path.join(
      this.config.getSyncFolder(),
      file.relativePath || file.name,
    );
    if (this._isFileLocal(dest, file.size)) {
      return { status: "present", dest };
    }
    // Single-flight: if this exact destination is already downloading (from the
    // periodic sweep OR a prior trigger), join that download instead of racing
    // a second fetch to the same `.part` temp file.
    const existing = this._fileDownloadInflight.get(dest);
    if (existing) {
      await existing;
      return { status: "coalesced", dest };
    }
    const downloadRoute = file.downloadPath || `/api/sync/download/${file.id}`;
    const expectedSize = Number(file.size) || 0;
    // Task #2164 — bounded retry with exponential backoff. A FRESH presigned URL
    // is requested on every attempt so an expired-link 403 is replaced rather
    // than retried verbatim. Each downloaded file is integrity-checked against
    // its expected size; a truncated/corrupt file is discarded and re-fetched,
    // so it never lands and never counts as "local". Transient failures usually
    // succeed within a couple of attempts without waiting for the next sweep; a
    // genuinely-broken object (404) fails fast and stays honestly pending.
    const p = (async () => {
      let lastErr;
      for (let attempt = 1; attempt <= this._maxDownloadAttempts; attempt++) {
        try {
          const urlRes = await this._json("GET", downloadRoute, null);
          if (!urlRes?.url) return { status: "no-url", dest };
          await this._download(urlRes.url, dest, onProgress, expectedSize);
          // Backstop integrity check (in addition to the in-`_download` guard
          // before promotion): if the file landed at `dest` but at the wrong
          // size, discard it and treat as a retryable failure so it never
          // counts as "local". Only checks a file that actually exists — a
          // transport that resolves without producing a file is handled by the
          // primary in-`_download` guard, not here.
          if (expectedSize > 0 && fs.existsSync(dest)) {
            const actual = fs.statSync(dest).size;
            if (actual !== expectedSize) {
              try {
                fs.unlinkSync(dest);
              } catch (_) {}
              throw new Error(
                `size-mismatch: expected ${expectedSize}, got ${actual}`,
              );
            }
          }
          await this._json("POST", `/api/sync/download/${file.id}/complete`, {});
          return { status: "downloaded", dest };
        } catch (err) {
          lastErr = err;
          // A user pause/cancel is never a transient failure — surface it.
          if (this.cancelled || (err && /cancelled/i.test(err.message || ""))) {
            throw err;
          }
          if (
            !this._isRetryableDownloadError(err) ||
            attempt >= this._maxDownloadAttempts
          ) {
            throw err;
          }
          console.warn(
            `[SYNC] transient download failure for "${file.name}" (attempt ${attempt}/${this._maxDownloadAttempts}); retrying:`,
            err && err.message ? err.message : err,
          );
          await this._sleep(this._downloadRetryDelayMs(attempt));
        }
      }
      throw lastErr;
    })();
    this._fileDownloadInflight.set(dest, p);
    try {
      return await p;
    } finally {
      this._fileDownloadInflight.delete(dest);
    }
  }

  // ---- Low-level helpers --------------------------------------------------
  _download(url, destPath, onProgress, expectedSize = 0) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error("cancelled"));
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${destPath}.part`;
      const file = fs.createWriteStream(tmp);
      const proto = url.startsWith("https") ? https : http;
      const expected = Number(expectedSize) || 0;

      const onResponse = (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          proto.get(res.headers.location, onResponse).on("error", fail);
          return;
        }
        if (res.statusCode !== 200) return fail(new Error(`HTTP ${res.statusCode}`));
        const total = Number(res.headers["content-length"]) || 0;
        let received = 0;
        res.on("data", (chunk) => {
          if (this.cancelled) {
            res.destroy();
            return fail(new Error("cancelled"));
          }
          received += chunk.length;
          // Always report (even without a content-length header) so the
          // batch-level aggregate can advance off received bytes; pass the
          // raw byte count up so the engine can weight overall progress.
          if (onProgress) {
            const pct = total ? Math.round((received / total) * 100) : 0;
            onProgress(pct, received);
          }
        });
        res.pipe(file);
        file.on("finish", () =>
          file.close(() => {
            try {
              // Task #2164 — integrity guard: verify the written byte count
              // against the expected size BEFORE promoting the temp file to its
              // final name. A truncated/corrupt download (network drop, partial
              // body) never lands at `destPath`; we delete the temp and reject
              // with a retryable size-mismatch so the retry loop re-fetches.
              if (expected > 0) {
                const actual = fs.statSync(tmp).size;
                if (actual !== expected) {
                  try {
                    fs.unlinkSync(tmp);
                  } catch (_) {}
                  return reject(
                    new Error(
                      `size-mismatch: expected ${expected}, got ${actual}`,
                    ),
                  );
                }
              }
              fs.renameSync(tmp, destPath);
              resolve();
            } catch (e) {
              fail(e);
            }
          }),
        );
      };

      const fail = (err) => {
        try {
          file.destroy();
          if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
        } catch (_) {}
        reject(err);
      };

      proto.get(url, onResponse).on("error", fail);
    });
  }

  _json(method, route, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.apiBase + route);
      const proto = url.protocol === "https:" ? https : http;
      const payload = body ? JSON.stringify(body) : null;
      const req = proto.request(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            ...this.authHeaders(),
            ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            let json = {};
            try {
              json = text ? JSON.parse(text) : {};
            } catch (_) {}
            if (res.statusCode >= 400) {
              return reject(new Error(json.error || `HTTP ${res.statusCode}`));
            }
            resolve(json);
          });
        },
      );
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}

module.exports = { SyncEngine, DEFAULT_API_BASE };
