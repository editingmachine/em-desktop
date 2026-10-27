import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { verifiedTools, formatPolicy, LocalMedia } from "./local-media";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const ordinary = () => ({
  streams: [{ codec_type: "video", codec_name: "h264", pix_fmt: "yuv420p",
    color_transfer: "bt709", color_primaries: "bt709", color_space: "bt709",
    width: 3840, height: 2160, avg_frame_rate: "30/1", r_frame_rate: "30/1" },
    { codec_type: "audio", codec_name: "aac" }],
  format: { duration: "60" },
});
describe("bounded local media preparation", () => {
  it("accepts explicit SDR H.264 and HEVC metadata without claiming server readiness", () => {
    for (const codec of ["h264", "hevc"]) {
      const probe = ordinary();
      probe.streams[0].codec_name = codec;
      expect(formatPolicy(probe)).toMatchObject({ duration: 60, width: 3840, audio: true });
    }
  });
  it.each(["smpte2084", "arib-std-b67", undefined])("rejects HDR/unknown transfer %s", (transfer) => {
    const probe = ordinary();
    probe.streams[0].color_transfer = transfer;
    expect(() => formatPolicy(probe)).toThrow("HDR");
  });
  it("does not pretend VFR timing was normalized safely", () => {
    const probe = ordinary();
    probe.streams[0].avg_frame_rate = "2997/100";
    expect(() => formatPolicy(probe)).toThrow("Variable-frame-rate");
  });
  it("rejects multiple picture/audio tracks and unbounded inputs", () => {
    const probe = ordinary();
    probe.streams.push({ ...probe.streams[1] });
    expect(() => formatPolicy(probe)).toThrow("at most one");
    probe.streams.pop();
    probe.format.duration = "999999";
    expect(() => formatPolicy(probe)).toThrow("bounds");
  });
  it("requires packaged platform-specific tools; never uses PATH", async () => {
    await expect(verifiedTools("/does-not-exist", "linux", "x64")).rejects.toThrow("not released");
    await expect(verifiedTools("/does-not-exist", "win32", "x64")).rejects.toThrow("missing");
  });
  it("checks both exact packaged digests and executable names", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-runtime-"));
    roots.push(root);
    const dir = path.join(root, "native-media", "darwin-arm64");
    fs.mkdirSync(dir, { recursive: true });
    const manifest = { version: 1, platform: "darwin", arch: "arm64" };
    for (const name of ["ffmpeg", "ffprobe"]) {
      // Bytes are test-only; this test does NOT execute or validate a media binary.
      const bytes = Buffer.from(`test artifact ${name}`);
      fs.writeFileSync(path.join(dir, name), bytes);
      manifest[name] = { filename: name, version: "test-only", license: "LGPL-2.1-or-later",
        sourceUrl: "https://example.invalid/test", sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    }
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    expect(await verifiedTools(root, "darwin", "arm64")).toEqual({
      ffmpeg: path.join(dir, "ffmpeg"), ffprobe: path.join(dir, "ffprobe"),
    });
    fs.appendFileSync(path.join(dir, "ffmpeg"), "tampered");
    await expect(verifiedTools(root, "darwin", "arm64")).rejects.toThrow("checksum");
    manifest.ffmpeg.filename = "../ffmpeg";
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    await expect(verifiedTools(root, "darwin", "arm64")).rejects.toThrow("reviewed");
  });
  it("fails before conversion without a released runtime and retains source bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "media-source-"));
    roots.push(root);
    const source = path.join(root, "phone.mp4");
    fs.writeFileSync(source, "test source");
    const media = new LocalMedia(root);
    await expect(media.prepare(source, path.join(root, "proxy.mp4"))).rejects.toThrow();
    expect(fs.readFileSync(source, "utf8")).toBe("test source");
    expect(fs.existsSync(path.join(root, "proxy.mp4"))).toBe(false);
    expect(media.busy).toBe(false);
  });
});