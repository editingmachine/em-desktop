// Task #1755 — desktop app orange re-brand icon generator.
//
// Regenerates every packaged/runtime icon from the Editing Machine logo mark in
// the brand-orange Team palette (#F97316). Run with:  node scripts/generate-icons.cjs
//
//   * App icon  -> assets/icon.png (1024), assets/icon.ico, assets/icon.icns
//   * Tray icons-> assets/tray-<state>.png (16) + @2x (32) for each sync state,
//                  the orange mark with a small colored status dot.
//
// The white logo mark (transparent bg) is recolored to orange; the dark rounded
// tile gives the dock/taskbar icon a finished, branded look. ICNS is packed by
// hand (PNG-typed entries) since ImageMagick lacks an ICNS encoder here.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..");
const ASSETS = path.join(ROOT, "assets");
const TMP = path.join(ROOT, "scripts", ".icon-tmp");
const ATTACHED = path.join(ROOT, "..", "attached_assets");
const WHITE_MARK = path.join(ATTACHED, "editing-machine-logo-mark-white-rgb-900px-w-72ppi.png");
const WHITE_LOGOTYPE = path.join(ATTACHED, "editing-machine-logo-white-rgb-900px-w-72ppi.png");
const RENDERER_ASSETS = path.join(ROOT, "src", "renderer", "assets");

const ORANGE = { r: 0xf9, g: 0x73, b: 0x16 }; // #F97316 brand orange (Team palette)
const TILE_BG = "#15181d"; // deep charcoal — matches the app shell background

// Functional sync-state dot colors (orange is brand, NOT a status color).
const DOTS = {
  idle: "#9aa0a6", // neutral grey — connected, nothing to do yet
  synced: "#22c55e", // green — up to date
  syncing: "#3b82f6", // blue — actively transferring
  paused: "#f59e0b", // amber — paused by user
  error: "#ef4444", // red — sync failed (functional status, not brand)
  offline: "#6b7280", // dim grey — signed out / unreachable
};

if (!fs.existsSync(TMP)) fs.mkdirSync(TMP, { recursive: true });

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

// Recolor a white (transparent-bg) logo asset to a solid color.
// (sharp's .tint() preserves luminance, so pure white can't become orange — we
// instead fill the shape with a solid color masked by the asset's alpha channel.)
async function recolorWhite(srcPath, color, { trim = true } = {}) {
  const rgb = typeof color === "string" ? hexToRgb(color) : color;
  const meta = await sharp(srcPath).metadata();
  const alpha = await sharp(srcPath).ensureAlpha().extractChannel(3).toColourspace("b-w").toBuffer();
  const colored = sharp({
    create: { width: meta.width, height: meta.height, channels: 3, background: rgb },
  })
    .joinChannel(alpha)
    .png();
  const buf = await colored.toBuffer();
  return trim ? sharp(buf).trim().png().toBuffer() : buf;
}

function tintedMark(color) {
  return recolorWhite(WHITE_MARK, color);
}

function roundedTileSvg(size) {
  const r = Math.round(size * 0.225);
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="${TILE_BG}"/>` +
      `</svg>`,
  );
}

// ---- App icon -------------------------------------------------------------
async function buildAppPng(size) {
  const mark = await sharp(await tintedMark(ORANGE))
    .resize({
      width: Math.round(size * 0.6),
      height: Math.round(size * 0.6),
      fit: "inside",
    })
    .toBuffer();
  return sharp(roundedTileSvg(size))
    .composite([{ input: mark, gravity: "center" }])
    .png()
    .toBuffer();
}

// ---- Tray icon ------------------------------------------------------------
async function buildTrayPng(state, size) {
  const C = 256; // render large, then downscale for crisp small icons
  const offline = state === "offline";
  const markColor = offline ? DOTS.offline : ORANGE; // grey mark when offline
  const markPx = Math.round(C * 0.7);
  const mark = await sharp(await tintedMark(markColor))
    .resize({ width: markPx, height: markPx, fit: "inside" })
    .png()
    .toBuffer();

  const dot = DOTS[state] || DOTS.idle;
  const cx = C * 0.74;
  const cy = C * 0.74;
  const rr = C * 0.24;
  const badge = Buffer.from(
    `<svg width="${C}" height="${C}" xmlns="http://www.w3.org/2000/svg">` +
      // separator ring so the dot stays legible over the mark on any menubar
      `<circle cx="${cx}" cy="${cy}" r="${rr + 9}" fill="${TILE_BG}"/>` +
      `<circle cx="${cx}" cy="${cy}" r="${rr}" fill="${dot}"/>` +
      `</svg>`,
  );

  const badgePng = await sharp(badge).png().toBuffer();
  // Composite at full size first — sharp applies resize BEFORE composite in a
  // single pipeline, so downscaling must happen in a separate pass.
  const composed = await sharp({
    create: { width: C, height: C, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      { input: mark, gravity: "northwest" },
      { input: badgePng, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
  return sharp(composed).resize({ width: size, height: size, fit: "inside" }).png().toBuffer();
}

// ---- ICNS packer (PNG-typed entries) --------------------------------------
async function buildIcns(srcPng) {
  // OSType -> pixel size for PNG-encoded icon entries macOS understands.
  const TYPES = [
    ["icp4", 16],
    ["icp5", 32],
    ["icp6", 64],
    ["ic07", 128],
    ["ic08", 256],
    ["ic09", 512],
    ["ic10", 1024],
    ["ic11", 32], // 16@2x
    ["ic12", 64], // 32@2x
    ["ic13", 256], // 128@2x
    ["ic14", 512], // 256@2x
  ];
  const entries = [];
  for (const [type, px] of TYPES) {
    const png = await sharp(srcPng).resize(px, px, { fit: "inside" }).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(type, 0, "ascii");
    header.writeUInt32BE(png.length + 8, 4);
    entries.push(Buffer.concat([header, png]));
  }
  const body = Buffer.concat(entries);
  const fileHeader = Buffer.alloc(8);
  fileHeader.write("icns", 0, "ascii");
  fileHeader.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([fileHeader, body]);
}

async function main() {
  // App PNG (1024) + intermediate sizes for ICO.
  const png1024 = await buildAppPng(1024);
  fs.writeFileSync(path.join(ASSETS, "icon.png"), png1024);

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoFiles = [];
  for (const s of icoSizes) {
    const f = path.join(TMP, `app-${s}.png`);
    fs.writeFileSync(f, await buildAppPng(s));
    icoFiles.push(f);
  }
  execFileSync("magick", [...icoFiles, path.join(ASSETS, "icon.ico")]);

  fs.writeFileSync(path.join(ASSETS, "icon.icns"), await buildIcns(png1024));

  // Tray icons: base 16px + @2x 32px per state.
  for (const state of Object.keys(DOTS)) {
    fs.writeFileSync(path.join(ASSETS, `tray-${state}.png`), await buildTrayPng(state, 16));
    fs.writeFileSync(path.join(ASSETS, `tray-${state}@2x.png`), await buildTrayPng(state, 32));
  }

  // Renderer header logo (orange logotype) + standalone orange mark, bundled by Vite.
  if (!fs.existsSync(RENDERER_ASSETS)) fs.mkdirSync(RENDERER_ASSETS, { recursive: true });
  fs.writeFileSync(path.join(RENDERER_ASSETS, "logo-orange.png"), await recolorWhite(WHITE_LOGOTYPE, ORANGE));
  fs.writeFileSync(path.join(RENDERER_ASSETS, "mark-orange.png"), await tintedMark(ORANGE));

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("Icons regenerated:", fs.readdirSync(ASSETS).sort().join(", "));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
