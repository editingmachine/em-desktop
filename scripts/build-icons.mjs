// Regenerates the desktop app icons from a single drawn master so the
// electron-builder Windows (.ico), macOS (.icns) and Linux (.png) builds all
// have the icon files their config references.
//
//   node scripts/build-icons.mjs
//
// Requires ImageMagick (`magick`) on PATH. These are intentionally simple
// brand-red placeholders — replace the master draw step with real artwork
// before a public release.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const assets = join(dirname(fileURLToPath(import.meta.url)), "..", "assets");
const png = join(assets, "icon.png");
const ico = join(assets, "icon.ico");
const icns = join(assets, "icon.icns");
const tmp = mkdtempSync(join(tmpdir(), "em-icons-"));
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });

// 1024x1024 master: brand-red rounded square + white play triangle.
sh(
  `magick -size 1024x1024 xc:none -fill "#E11D2A" ` +
    `-draw "roundrectangle 0,0,1023,1023,180,180" ` +
    `-fill white -draw "polygon 384,320 384,704 760,512" "${png}"`,
);

// Windows multi-resolution .ico.
sh(`magick "${png}" -define icon:auto-resize=256,128,64,48,32,16 "${ico}"`);

// macOS .icns — PNG-packed entries (read by modern macOS + electron-builder).
const ICNS_TYPES = [
  ["ic07", 128],
  ["ic08", 256],
  ["ic09", 512],
  ["ic10", 1024],
  ["ic11", 32],
  ["ic12", 64],
  ["ic13", 256],
  ["ic14", 512],
];
const chunks = [];
for (const [type, size] of ICNS_TYPES) {
  const p = join(tmp, `${type}.png`);
  sh(`magick "${png}" -resize ${size}x${size} "${p}"`);
  const data = readFileSync(p);
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32BE(data.length + 8, 4);
  chunks.push(header, data);
}
const body = Buffer.concat(chunks);
const fileHeader = Buffer.alloc(8);
fileHeader.write("icns", 0, "ascii");
fileHeader.writeUInt32BE(body.length + 8, 4);
writeFileSync(icns, Buffer.concat([fileHeader, body]));
rmSync(tmp, { recursive: true, force: true });

console.log(`Wrote:\n  ${png}\n  ${ico}\n  ${icns}`);
