// Shared by the release publisher (in-memory bytes) and standalone native CI.
// No installed dependencies: this must run BEFORE npm ci.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function validateReleaseInputs(files) {
  const fail = (message) => {
    throw new Error(`Desktop release inputs: ${message}. Repair the source bundle before publishing.`);
  };
  const bytes = new Map();
  for (const file of files) {
    if (file.repoPath.includes('\\') || path.posix.isAbsolute(file.repoPath) ||
        path.posix.normalize(file.repoPath) !== file.repoPath || file.repoPath.startsWith('../')) {
      fail(`unsafe bundle path ${file.repoPath}`);
    }
    if (bytes.has(file.repoPath)) fail(`duplicate bundle path ${file.repoPath}`);
    bytes.set(file.repoPath, Buffer.from(file.contentBase64, 'base64'));
  }
  const json = (name) => {
    if (!bytes.has(name)) fail(`missing ${name}`);
    try { return JSON.parse(bytes.get(name).toString('utf8')); }
    catch { fail(`invalid JSON in ${name}`); }
  };
  const pkg = json('package.json');
  const lock = json('package-lock.json');
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) fail('a v3 package-lock.json is required');
  if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) {
    fail('package.json and package-lock.json versions differ');
  }
  const localPaths = new Set();
  function localPath(spec, label) {
    const rel = spec.slice(5).replace(/^\.\//, '');
    if (!rel || /[\\%?#:]/.test(rel) || path.posix.isAbsolute(rel) ||
        path.posix.normalize(rel) !== rel || rel.startsWith('../') ||
        !rel.endsWith('.tgz')) {
      fail(`${label} references a non-portable archive ${spec}; use file:vendor/<archive>.tgz inside the checkout`);
    }
    if (!bytes.has(rel)) fail(`${label} requires missing archive ${rel}`);
    localPaths.add(rel);
    return rel;
  }
  // Recursively includes nested overrides, optional dependencies and lock metadata.
  function scan(value, label) {
    if (typeof value === 'string') {
      if (value.startsWith('file:')) localPath(value, label);
      if (/^(link:|workspace:|\.{1,2}\/|\/|[A-Za-z]:\\)/.test(value)) {
        fail(`${label} contains unsupported local reference ${value}`);
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) scan(child, `${label}.${key}`);
    }
  }
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const manifest = pkg[section] ?? {};
    const locked = lock.packages[''][section] ?? {};
    const isMap = value => value && typeof value === 'object' && !Array.isArray(value) &&
      Object.values(value).every(spec => typeof spec === 'string');
    if (!isMap(manifest) || !isMap(locked) ||
        Object.keys(manifest).length !== Object.keys(locked).length ||
        Object.entries(manifest).some(([name, spec]) =>
          !Object.hasOwn(locked, name) || locked[name] !== spec)) {
      fail(`${section} differ between manifest and lockfile`);
    }
    scan(pkg[section], section);
  }
  scan(pkg.overrides, 'overrides');
  if (pkg.overrides?.['sprintf-js'] !== '$sprintf-js' ||
      !pkg.dependencies?.['sprintf-js']?.startsWith('file:')) {
    fail('the hardened sprintf-js direct dependency and $sprintf-js override are required');
  }
  const sprintf = lock.packages['node_modules/sprintf-js'];
  if (!sprintf || sprintf.resolved !== pkg.dependencies['sprintf-js'] ||
      sprintf.name !== '@editingmachine/bounded-sprintf') {
    fail('sprintf-js lock entry does not select the maintained fork');
  }
  const lockedArchives = new Set();
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.link) fail(`${name} is a local link, not a portable archive`);
    if (entry.resolved && /^https?:\/\/package-firewall\.replit\.(?:local|internal)(?:\/|$)/.test(entry.resolved)) {
      fail(`${name} uses a workspace-only registry URL; generate standalone source with scripts/export-release-source.cjs`);
    }
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'resolved']) {
      scan(entry[section], `lock.packages.${name}.${section}`);
    }
    if (name.endsWith('/node_modules/sprintf-js') &&
        entry.resolved !== pkg.dependencies['sprintf-js']) {
      fail(`${name} bypasses the hardened sprintf-js override`);
    }
    if (!entry.resolved?.startsWith('file:')) continue;
    const rel = localPath(entry.resolved, name);
    const integrity = `sha512-${createHash('sha512').update(bytes.get(rel)).digest('base64')}`;
    if (entry.integrity !== integrity) fail(`${rel} bytes do not match lockfile integrity for ${name}`);
    lockedArchives.add(rel);
  }
  for (const rel of localPaths) {
    if (!lockedArchives.has(rel)) fail(`${rel} has no integrity-pinned lock entry`);
  }
}

module.exports = { validateReleaseInputs };

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, '..');
    const files = [];
    const walk = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', '.git', 'dist'].includes(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) files.push({
          repoPath: rel,
          contentBase64: fs.readFileSync(path.join(dir, entry.name)).toString('base64'),
        });
      }
    };
    walk(root);
    validateReleaseInputs(files);
    console.log('Desktop release inputs verified (portable archives and lockfile integrity).');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
