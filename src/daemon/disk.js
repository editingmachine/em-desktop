// Task #1742 — cross-platform disk usage probe for the sync folder's volume.
const { execFile } = require("child_process");
const os = require("os");

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout);
    });
  });
}

// Returns { totalBytes, freeBytes, usedBytes } for the volume containing `folder`.
async function getDiskUsage(folder) {
  try {
    if (process.platform === "win32") {
      // PowerShell: get the drive of the folder.
      const drive = (folder || os.homedir()).slice(0, 2);
      const out = await run("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-PSDrive ${drive[0]} | Select-Object Used,Free | ConvertTo-Json)`,
      ]);
      if (out) {
        const parsed = JSON.parse(out);
        const used = Number(parsed.Used) || 0;
        const free = Number(parsed.Free) || 0;
        return { totalBytes: used + free, freeBytes: free, usedBytes: used };
      }
    } else {
      // df -k -P <folder> → 1024-byte blocks
      const out = await run("df", ["-k", "-P", folder || os.homedir()]);
      if (out) {
        const lines = out.trim().split("\n");
        const cols = lines[lines.length - 1].split(/\s+/);
        const total = Number(cols[1]) * 1024;
        const used = Number(cols[2]) * 1024;
        const free = Number(cols[3]) * 1024;
        if (total > 0) return { totalBytes: total, freeBytes: free, usedBytes: used };
      }
    }
  } catch (_) {
    /* fall through */
  }
  return { totalBytes: null, freeBytes: null, usedBytes: null };
}

module.exports = { getDiskUsage };
