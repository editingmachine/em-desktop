// Task 4308: fail-closed local preparation. No PATH or downloaded executable
// fallback: the signed application must carry its reviewed runtime manifest.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

async function digest(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifiedTools(resources, platform = process.platform, arch = process.arch) {
  if (!["win32", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch))
    throw new Error("Local media preparation is not released for this platform. Use original-first upload.");
  // electron-builder copies buildResources/assets to <resources>/assets.
  // Keep the direct path only for un-packaged test/dev resource roots.
  const packagedRoot = path.join(resources, "assets", "native-media", `${platform}-${arch}`);
  const devRoot = path.join(resources, "native-media", `${platform}-${arch}`);
  const root = fs.existsSync(packagedRoot) ? packagedRoot : devRoot;
  let manifest;
  try { manifest = JSON.parse(await fs.promises.readFile(path.join(root, "manifest.json"), "utf8")); }
  catch (_) { throw new Error("Reviewed packaged media runtime is missing. Use original-first upload."); }
  if (manifest.version !== 1 || manifest.platform !== platform || manifest.arch !== arch)
    throw new Error("Packaged media runtime identity is invalid");
  const result = {};
  for (const name of ["ffprobe", "ffmpeg"]) {
    const spec = manifest[name];
    const filename = `${name}${platform === "win32" ? ".exe" : ""}`;
    if (!spec || spec.filename !== filename || !/^[a-f0-9]{64}$/.test(spec.sha256) ||
        typeof spec.version !== "string" || !spec.version.trim() ||
        typeof spec.sourceUrl !== "string" || !spec.sourceUrl.startsWith("https://") ||
        !["LGPL-2.1-or-later", "LGPL-3.0-or-later", "GPL-2.0-or-later", "GPL-3.0-or-later"].includes(spec.license))
      throw new Error("Packaged media runtime has no reviewed version, digest or license");
    const file = path.join(root, filename);
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await digest(file) !== spec.sha256)
      throw new Error("Packaged media runtime checksum mismatch");
    result[name] = file;
  }
  return result;
}

function run(executable, args, { signal, maxBytes = 2 * 1024 * 1024, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Preparation cancelled; source retained"));
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", bytes = 0, failure;
    const stop = (message) => { failure = new Error(message); child.kill("SIGKILL"); };
    const cancel = () => stop("Preparation cancelled; source retained");
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("Preparation timed out; source retained"), timeoutMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) stop("Media probe output exceeded safety limit");
      else stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); };
    child.on("error", (error) => { cleanup(); reject(error); });
    child.on("close", (code) => {
      cleanup();
      if (failure || code !== 0) reject(failure || new Error(`Media preparation failed (${code}): ${stderr}`));
      else resolve(stdout);
    });
  });
}

function formatPolicy(probe) {
  const video = probe?.streams?.filter((s) => s.codec_type === "video");
  const audio = probe?.streams?.filter((s) => s.codec_type === "audio") || [];
  if (video?.length !== 1 || audio.length > 1) throw new Error("Exactly one video and at most one audio stream are supported");
  const v = video[0];
  if (!["h264", "hevc"].includes(v.codec_name) || !["yuv420p", "yuvj420p"].includes(v.pix_fmt))
    throw new Error("Unsupported codec/profile; use original-first upload");
  if (v.color_transfer !== "bt709" || v.color_primaries !== "bt709" ||
      v.color_space !== "bt709" || (v.side_data_list || []).some((s) => /dovi|mastering|content light/i.test(s.side_data_type)))
    throw new Error("HDR or unknown color metadata is not supported; use original-first upload");
  const duration = Number(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 4 * 60 * 60 ||
      !Number.isInteger(v.width) || !Number.isInteger(v.height) ||
      v.width <= 0 || v.height <= 0 || v.width > 8192 || v.height > 8192)
    throw new Error("Media exceeds preparation bounds");
  // Until frame-map validation is integrated, never silently CFR-normalize a
  // phone VFR source and imply that its edit coordinates survived.
  if (!v.avg_frame_rate || v.avg_frame_rate !== v.r_frame_rate)
    throw new Error("Variable-frame-rate footage needs original-first upload until timing validation is released");
  return { duration, width: v.width, height: v.height, frameRate: v.avg_frame_rate, audio: audio.length === 1 };
}

class LocalMedia {
  constructor(resources) {
    this.resources = resources;
    this.busy = false;
  }
  async prepare(source, destination, { signal } = {}) {
    if (this.busy) throw new Error("One local preparation is already running");
    this.busy = true;
    let created = false;
    try {
      if (![".mp4", ".mov"].includes(path.extname(source).toLowerCase()))
        throw new Error("Only MP4/MOV sources are supported");
      const tools = await verifiedTools(this.resources);
      const before = await fs.promises.lstat(source);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        throw new Error("Linked or non-file source rejected");
      const sourceSha256 = await digest(source);
      const probe = JSON.parse(await run(tools.ffprobe, [
        "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", source,
      ], { signal, timeoutMs: 60000 }));
      const media = formatPolicy(probe);
      // Hard temporary-output ceiling (not merely a predicted bitrate).
      const maxOutputBytes = Math.ceil(media.duration * 750000 + 16 * 1024 * 1024);
      const disk = await fs.promises.statfs(path.dirname(destination));
      if (Number(disk.bavail) * Number(disk.bsize) < maxOutputBytes + 512 * 1024 * 1024)
        throw new Error("Insufficient temporary disk space; retain source and free space");
      // Reserve with exclusive creation. Never overwrite another operation's output.
      const handle = await fs.promises.open(destination, "wx", 0o600);
      await handle.close();
      created = true;
      await run(tools.ffmpeg, [
        "-nostdin", "-v", "error", "-y", "-protocol_whitelist", "file",
        "-threads", "2", "-i", source, "-map", "0:v:0", "-map", "0:a:0?",
        "-vf", "scale=854:480:force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-g", "1", "-bf", "0",
        "-crf", "23", "-pix_fmt", "yuv420p", "-fps_mode", "passthrough",
        "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart",
        "-fs", String(maxOutputBytes), "-f", "mp4", destination,
      ], { signal });
      const after = await fs.promises.lstat(source);
      if (signal?.aborted || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
          after.ino !== before.ino || sourceSha256 !== await digest(source))
        throw new Error("Source changed during preparation; prepared output discarded");
      const outputProbe = JSON.parse(await run(tools.ffprobe, [
        "-v", "error", "-protocol_whitelist", "file", "-show_format", "-of", "json", destination,
      ], { signal, timeoutMs: 60000 }));
      if (Math.abs(Number(outputProbe.format?.duration) - media.duration) > 0.1 ||
          !Number.isFinite(Number(outputProbe.format?.duration)))
        throw new Error("Prepared output is truncated or timing differs; original-first upload required");
      return { sourceSha256, sourceSize: before.size, proxySha256: await digest(destination),
        proxySize: (await fs.promises.stat(destination)).size, media,
        // A local conversion is explicitly NOT a server readiness receipt.
        readyToEdit: false, originalVerified: false };
    } catch (error) {
      if (created) await fs.promises.unlink(destination).catch(() => {});
      throw error;
    } finally { this.busy = false; }
  }
}
module.exports = { LocalMedia, verifiedTools, formatPolicy };