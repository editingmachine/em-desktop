// One exporter for the admin publisher and the documented manual release path.
// Runs without node_modules; only the resulting checkout is used for installation.
const fs = require('node:fs');
const path = require('node:path');
const { validateReleaseInputs } = require('./validate-release-inputs.cjs');

const INCLUDE_DIRS = ['src', 'assets', 'build', 'scripts', '.github', 'vendor'];
const INCLUDE_FILES = [
  'package.json', 'package-lock.json', 'electron-builder.yml', 'tsconfig.json',
  'vite.config.ts', 'README.md', '.gitignore',
];
const EXCLUDE_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

function collectDesktopAppFiles(rootDir) {
  const files = [];
  const add = (abs, repoPath) => files.push({
    repoPath, contentBase64: fs.readFileSync(abs).toString('base64'),
  });
  const walk = (absDir, prefix) => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) add(abs, rel);
      // Never follow symlinks, including local archives outside the checkout.
    }
  };
  for (const dir of INCLUDE_DIRS) {
    const abs = path.join(rootDir, dir);
    if (fs.existsSync(abs) && fs.lstatSync(abs).isDirectory()) walk(abs, dir);
  }
  for (const name of INCLUDE_FILES) {
    const abs = path.join(rootDir, name);
    if (fs.existsSync(abs) && fs.lstatSync(abs).isFile()) add(abs, name);
  }
  // The known workspace mirrors use the exact public npm tarball paths.
  // Preserve all locked versions, dependencies and integrity hashes.
  const portable = files.map(file => {
    if (file.repoPath !== 'package-lock.json') return file;
    const lock = JSON.parse(Buffer.from(file.contentBase64, 'base64').toString('utf8'));
    for (const entry of Object.values(lock.packages || {})) {
      if (entry.resolved) entry.resolved = entry.resolved.replace(
        /^https?:\/\/package-firewall\.replit\.(?:local|internal)\/npm\//,
        'https://registry.npmjs.org/',
      );
    }
    return { ...file, contentBase64: Buffer.from(JSON.stringify(lock, null, 2) + '\n').toString('base64') };
  });
  validateReleaseInputs(portable);
  return portable;
}

module.exports = { collectDesktopAppFiles };

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/export-release-source.cjs <new-output-directory>');
    const dest = path.resolve(process.argv[2]);
    if (dest === root || dest.startsWith(root + path.sep)) {
      throw new Error('Export outside the desktop source directory');
    }
    // Do not overwrite an owner's checkout or recursively delete existing files.
    if (fs.existsSync(dest)) throw new Error('Output directory already exists; choose a new empty destination');
    const files = collectDesktopAppFiles(root); // validate before writing anything
    fs.mkdirSync(dest, { recursive: true });
    for (const file of files) {
      const abs = path.join(dest, file.repoPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, Buffer.from(file.contentBase64, 'base64'));
    }
    console.log(`Exported ${files.length} validated desktop source files to ${dest}. No GitHub changes made.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
