// Pure HTTP Range helpers for the `em-proxy://` protocol handler.
//
// Kept dependency-free (no electron, no fs) so it can be unit-tested outside
// the Electron runtime. The handler in index.js does the actual file IO; this
// module only does the math + content-type mapping.

const path = require("path");

function contentTypeForPath(p) {
  switch (path.extname(String(p || "")).toLowerCase()) {
    case ".mp4":
    case ".m4v":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    case ".webm":
      return "video/webm";
    case ".mkv":
      return "video/x-matroska";
    case ".m4a":
      return "audio/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".aac":
      return "audio/aac";
    case ".wav":
      return "audio/wav";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/**
 * Parse a single-range `Range` header against a known total byte size.
 *
 * Returns one of:
 *   { kind: "full" }                — no / empty / multi-range: serve whole file (200)
 *   { kind: "range", start, end }   — inclusive byte range to serve (206)
 *   { kind: "unsatisfiable" }       — range can't be met (416)
 *
 * `start`/`end` are inclusive and clamped to [0, total-1].
 */
function parseRange(total, rangeHeader) {
  const size = Number(total);
  if (!Number.isFinite(size) || size <= 0) {
    // Empty file: a byte range is unsatisfiable; no range = full (empty) body.
    return rangeHeader && /^bytes=/.test(String(rangeHeader).trim())
      ? { kind: "unsatisfiable" }
      : { kind: "full" };
  }
  if (!rangeHeader || typeof rangeHeader !== "string") return { kind: "full" };
  // Only a single byte range is supported; anything else falls back to full.
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return { kind: "full" };

  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";
  if (!hasStart && !hasEnd) return { kind: "full" }; // "bytes=-" is malformed

  let start;
  let end;
  if (!hasStart) {
    // Suffix range: the final N bytes.
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      return { kind: "unsatisfiable" };
    }
    if (end > size - 1) end = size - 1;
  }

  if (start < 0 || start > end || start >= size) return { kind: "unsatisfiable" };
  return { kind: "range", start, end };
}

module.exports = { parseRange, contentTypeForPath };
