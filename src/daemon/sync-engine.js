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
    this.filesSynced = 0;
    this.filesPending = 0;
    this._timer = null;
    // Task #1758 — last manifest's file list, kept so the local-proxy
    // bridge can map an assetId back to a synced file on disk. Best-effort:
    // entries only carry an assetId once the manifest starts emitting one.
    this.lastFiles = [];
  }

  emitStatus() {
    this.emit("status", {
      state: this.state,
      paused: this.paused,
      currentFile: this.currentFile,
      filesSynced: this.filesSynced,
      filesPending: this.filesPending,
      user: this.user ? { email: this.user.email, name: this.user.name } : null,
    });
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
      this.emitStatus();

      for (const file of files) {
        if (this.paused || this.cancelled) break;
        const dest = path.join(this.config.getSyncFolder(), file.relativePath || file.name);
        if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) continue;

        this.currentFile = file.name;
        this.emitStatus();

        // Task #1759 — the server may hand us a derivative-specific download
        // path (scrub proxy / keyframe sidecar) via `downloadPath`; fall back
        // to the master-asset route otherwise.
        const downloadRoute = file.downloadPath || `/api/sync/download/${file.id}`;
        const urlRes = await this._json("GET", downloadRoute, null);
        if (!urlRes?.url) continue;
        await this._download(urlRes.url, dest, (pct) =>
          this.emit("progress", { file: file.name, pct, bytes: file.size }),
        );
        await this._json("POST", `/api/sync/download/${file.id}/complete`, {});
        downloaded += 1;
        this.filesSynced += 1;
        this.filesPending = Math.max(0, this.filesPending - 1);
        this.emitStatus();
      }

      await this._cleanupRemoved(files);
      this.currentFile = null;
      this.state = this.paused ? "paused" : "idle";
      this.emitStatus();
      return { downloaded };
    } catch (err) {
      this.state = "error";
      this.emitStatus();
      throw err;
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
  // Resolve the BEST local scrub source for an asset, preferring the new
  // all-intra progressive MP4 (`proxy_intra`, every frame an IDR) so the
  // native <video> element seeks to the exact frame instantly with NO
  // keyframe-index sidecar and NO WebCodecs/byte-range demuxing. Falls back
  // to the existing progressive proxy + keyframe-index sidecar when the
  // all-intra file isn't synced yet, and returns null on every "not here"
  // path so the web layer cleanly falls back to the network "Quick preview".
  //
  // Returns { filePath, scrubSource: 'all-intra' | 'progressive', keyframeIndex }
  // where keyframeIndex is null for the all-intra source (none required).
  resolveLocalScrubSource(assetId) {
    try {
      const id = Number(assetId);
      if (!Number.isFinite(id) || id <= 0) return null;

      const root = this.config.getSyncFolder();
      const matches = (this.lastFiles || []).filter(
        (f) => Number(f && (f.assetId ?? f.asset_id)) === id,
      );
      if (matches.length === 0) return null;

      // 1) Prefer the all-intra progressive MP4 — independently seekable, no
      //    sidecar needed. Only when the file is actually on disk; if it is in
      //    the manifest but the download hasn't landed yet we gracefully fall
      //    through to the progressive proxy below (honest, never a hard error).
      const intra = matches.find((f) => f && f.proxyKind === "all-intra");
      if (intra) {
        const intraPath = path.join(root, intra.relativePath || intra.name || "");
        if (intraPath && fs.existsSync(intraPath)) {
          return {
            filePath: intraPath,
            scrubSource: "all-intra",
            keyframeIndex: null,
          };
        }
      }

      // 2) Fall back to the existing progressive proxy + keyframe-index sidecar
      //    (tolerated until the retire task removes the sidecar path).
      const progressive = matches.find(
        (f) => f && (!f.proxyKind || f.proxyKind === "progressive"),
      );
      if (progressive) {
        const proxyPath = path.join(
          root,
          progressive.relativePath || progressive.name || "",
        );
        if (proxyPath && fs.existsSync(proxyPath)) {
          const sidecarPath = this._findKeyframeSidecar(proxyPath, progressive);
          if (sidecarPath && fs.existsSync(sidecarPath)) {
            let keyframeIndex;
            try {
              keyframeIndex = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
            } catch (_) {
              keyframeIndex = null;
            }
            if (keyframeIndex && typeof keyframeIndex === "object") {
              return {
                filePath: proxyPath,
                scrubSource: "progressive",
                keyframeIndex,
              };
            }
          }
        }
      }

      return null;
    } catch (_) {
      return null;
    }
  }

  // The keyframe-index Lambda writes a JSON sidecar beside the proxy. Accept
  // either an explicit manifest hint or the conventional sibling names.
  _findKeyframeSidecar(proxyPath, file) {
    const candidates = [];
    if (file && file.keyframeIndexRelativePath) {
      candidates.push(
        path.join(this.config.getSyncFolder(), file.keyframeIndexRelativePath),
      );
    }
    const ext = path.extname(proxyPath);
    const base = ext ? proxyPath.slice(0, -ext.length) : proxyPath;
    candidates.push(`${proxyPath}.keyframes.json`);
    candidates.push(`${base}.keyframes.json`);
    candidates.push(`${base}.keyframe-index.json`);
    return candidates.find((c) => c && fs.existsSync(c)) || null;
  }

  // ---- Low-level helpers --------------------------------------------------
  _download(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      if (this.cancelled) return reject(new Error("cancelled"));
      const dir = path.dirname(destPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmp = `${destPath}.part`;
      const file = fs.createWriteStream(tmp);
      const proto = url.startsWith("https") ? https : http;

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
          if (total && onProgress) onProgress(Math.round((received / total) * 100));
        });
        res.pipe(file);
        file.on("finish", () =>
          file.close(() => {
            try {
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
