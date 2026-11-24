# Editing Machine Sync — Desktop Shell

A standalone Electron desktop app that:

1. **Logs an editor in** with their existing portal credentials and opens the
   existing web portal in a desktop window (no re-built editor UI).
2. Runs a **background file-sync daemon** (extracted from `sync-cli`) that keeps
   Smart Cloud footage mirrored to a local folder.
3. Lives in the **system tray** with a red/amber/green status indicator, and
   reports a heartbeat to the server so admins can monitor the device fleet from
   `/admin/health`.

This package is intentionally decoupled from the main repo build — it has its own
`package.json` and is published as a desktop installer, not bundled with the web app.

## Layout

```
desktop-app/
  src/
    main/            Electron main process
      index.js         window + tray + IPC + portal loader
      auto-launch.js   start-on-login toggle
      updater.js       electron-updater wiring
    preload/
      index.js         contextBridge → window.emSync
    daemon/            background sync (no Electron deps)
      config.js        conf-backed settings + sync folder
      keychain.js      keytar credential storage (graceful fallback)
      disk.js          cross-platform disk usage
      sync-engine.js   SyncEngine (extracted from sync-cli/index.js)
    renderer/          React + TypeScript + Vite control panel
      pages/           Login / Dashboard / Settings
  assets/            tray + app icons
  build/             mac entitlements
  electron-builder.yml
  vite.config.ts
  package.json
  package-lock.json
  vendor/            pinned hardened dependency archive (inside this checkout)
```

## Develop

```bash
cd desktop-app
npm ci
npm run dev        # Vite renderer (5173) + Electron with NODE_ENV=development
```

The control panel loads from `http://localhost:5173` in dev and from the bundled
`src/renderer/dist` in production.

Point the shell at a server with `EM_PORTAL_URL` (defaults to the production
portal URL baked into `daemon/sync-engine.js`):

```bash
EM_PORTAL_URL=http://localhost:5000 npm run dev
```

## Build installers

### The easy way — automated builds (recommended)

A GitHub Actions pipeline (`.github/workflows/release.yml`) builds the macOS,
Windows, and Linux installers automatically, each on its own native machine
(a signed macOS `.dmg` and a Windows `.exe` cannot be built from a Linux box).

1. Use the admin Release Manager, or generate the **standalone export** below
   before copying source to its own GitHub repository. **Do not push the raw
   workspace `desktop-app` folder:** its development lockfile uses workspace-only
   registry URLs. Both export paths use the same exporter, include `vendor/`
   and `package-lock.json`, and map known workspace registry mirror URLs to
   public npm URLs without changing dependency versions or integrity hashes.
2. In that repo: **Actions → "Build desktop installers" → Run workflow**
   (or push a tag like `v1.0.1`).
3. When it finishes, download the installers from the run's **Artifacts**
   (`macos-installer`, `windows-installer`, `linux-installer`).

Code-signing is optional and switched on by adding repo **Secrets** (see below).
Without signing the installers still work but show a first-open security warning.

### The manual way — build on your own machine

From the parent workspace, generate a new destination outside the source tree
(the exporter refuses to overwrite existing directories):

```bash
node desktop-app/scripts/export-release-source.cjs /tmp/em-desktop-release
cd /tmp/em-desktop-release
npm run verify:release-inputs
npm ci
```

Only this validated output is the standalone source to copy to a separate
checkout/repository or native build machine. The export command itself never
pushes commits, tags or releases. After export and installation:

```bash
npm run build            # current platform
npm run build:win        # Windows NSIS   (run on Windows)
npm run build:mac        # macOS dmg + zip (run on a Mac)
npm run build:linux      # AppImage       (run on Linux)
```

### Recovering the failed v1.0.10 dependency install

The failed run is
<https://github.com/editingmachine/em-desktop/actions/runs/40497673292>.
All three native jobs stopped at **Install dependencies**, leaving renderer
build, packaging and upload skipped. The tagged manifest referenced
`file:../vendor/editingmachine-bounded-sprintf-1.0.0.tgz`, outside the standalone
checkout, while the tagged source had neither the archive nor a lockfile.
An isolated install using that actual tagged manifest reproduced **ENOENT**
for the archive and **exit 254**, matching the Mac/Linux annotations.
Original job-log downloads required repository-admin authentication and were
not accessed; the precise Windows error text remains unverified. Node action
deprecation warnings are separate from this demonstrated install blocker.

The repaired source carries the exact maintained archive under `vendor/`,
retains the `$sprintf-js` override, and exports the lockfile. CI validates
portable local references, SHA-512 archive integrity and the absence of
workspace-only registry URLs, then runs `npm ci`.
Dependency maps are compared by exact names and specification values, not JSON
property order; reordering identical entries is not a dependency change.
Version overrides update `package.json`, the lockfile version and its root
package version together.

The recovery investigation found the latest published installer release was
**v1.0.9**, while the failed **v1.0.10 tag already existed** and repository
`main` still referenced the external archive. The workspace source version
was **1.0.3**. Preview and publish now use the same baseline: the highest of
the local version, non-draft release versions and existing stable version tags,
including tags whose builds failed. Both remote lists are paginated, and
unavailable or malformed discovery results block version selection rather than
guessing. With that observed state, the next patch is **1.0.11**, even though
there is no published v1.0.10 installer release.

**Owner recovery steps (not performed by this repair):**

1. Merge this repair and ensure the actual runtime serving the admin Release
   Manager contains the repaired desktop source, vendor archive, lockfile and
    publisher code. Deploy/restart that publisher runtime through the normal
    owner-approved process; merging source alone does not update a running
    publisher. An older publisher can still export the broken bundle or reuse
    the failed tag version. Check its read-only preview after it is updated.
2. Obtain explicit owner authorization for a **fresh release**, then use the
    Release Manager's **patch** publish once. Confirm the displayed next version
    first: it is v1.0.11 for the observed state above, or later if another tag
    has since been created. This spends a new version and pushes a commit and
    tag. A GitHub discovery error must be resolved before publishing.
    Do not rerun or retag unchanged v1.0.10: rerunning checks out the same broken
    tagged source. Repeatedly clicking Publish is not a repair and can spend
    further versions or race another request. After an uncertain result, inspect
    repository tags, commits and workflow status before authorizing a retry.
3. Check **all three native jobs**, not just the workflow's overall status:
   validation, clean dependency install, renderer build, installer build and
   upload must succeed on macOS, Windows and Linux.
4. Verify the fresh GitHub Release actually contains the macOS DMG and updater
   ZIP, Windows installer EXE, Linux AppImage, and the corresponding updater
   metadata (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) plus any referenced
   blockmaps. Workflow artifacts alone are not proof of release uploads. Check
   nonzero sizes and that metadata points to assets of this exact version.
5. Download and launch the native installers and verify update discovery,
   download, restart and reported version on each target platform.

No tag, release or installer has been published as part of this repair.
Linux-only dependency/renderer checks are **not** Mac/Windows installer or
installed-app validation. The integration check skips Electron's native binary
download; it does not skip npm package install scripts, or claim packaging
success.

From the parent workspace, reproduce the isolated Linux regression gate with:

```bash
DESKTOP_RELEASE_ISOLATED=1 npx vitest run \
  server/admin-desktop-release.test.ts \
  server/admin-desktop-release.preflight.test.ts \
  server/desktop-release-isolated.test.ts --pool=threads --no-file-parallelism
```

This materializes the **generated admin export**, with its publishing version
overrides, and invokes the **manual export command**, into fresh temporary
directories outside the workspace. It runs
preflight, a clean full `npm ci`, renderer compilation, and a separate
`npm ci --omit=dev`, plus a full clean install/build of the manual export.
All installations check actual installed fork source
and license against maintained source, compatibility, extreme precision and
width behavior, and resolution from runtime-consumer locations. The current
locked desktop graph has no transitive sprintf-js dependency; nested copies
are nevertheless checked and a bypassed transitive lock entry is rejected.

Verification on **2026-11-03**, Linux, Node **22.23.4**, npm **10.9.9**:
the three-file isolated gate passed, including the admin-export
full and production-only clean installations, the manual-export clean
installation, and both full-install renderer builds. A focused strict TypeScript check of
`server/lib/github-release-client.ts` also passed. These are source/install
checks only; native packaging, release uploads and installed updates remain
unverified until the separately authorized release steps above.
Focused regressions also cover dependency-map order and genuine changes in all
four dependency sections, failed-tag version reservation, paginated releases
and tags, malformed tags, absent repositories, discovery failures and matching
preview/publish version selection with no-mutation preflight.

### Code signing & notarization

`electron-builder` reads signing material from the environment — no secrets are
committed:

- **Windows:** `CSC_LINK` (path to `.pfx`) + `CSC_KEY_PASSWORD`.
- **macOS:** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  (hardened runtime + entitlements are already configured).

### Auto-update

#### Deleted Smart Cloud downloads — desktop 1.0.3

This source change first ships in **desktop 1.0.3**. It has not released any
installers or cleaned any production PCs. A website Publish alone does **not**
update installed desktop apps. Use the existing native installer/release
pipeline above; operators then use tray **Check for Updates…**, accept the
downloaded update and restart, or install the platform's 1.0.3 installer from
the approved release. The existing feed must actually contain that release.

The server requires the additive schema and trigger migration
`migrations/0394_desktop_cloud_deletions.sql`. It follows the normal development
post-merge migration process; include its custom trigger/function in the
owner-reviewed production migration/Publish process. Schema column sync alone
does not install PostgreSQL trigger bodies. Never run this DDL at app startup.
Until the matching server contract is available, desktops retain files.

Only new, positively journalled downloads carrying a source generation can be
removed automatically. Older downloads cannot be retroactively claimed from
their names or sizes: the dashboard explains how to preserve them outside sync
and remove them manually. Client originals and operator-added/modified files
are never removed by this feature.
Downloaded operator recovery copies under `operator-uploads/` are also protected,
even if an older journal already stamped them with a source generation. Their
retained status is explicit; only the separate verified-coverage project-folder
retirement process may retire those bytes.

The next normal sync (default five minutes), Sync Now, resume or restart checks
all known copies against bounded authoritative receipt queries. Receipts have
no expiry and there is no deletion cursor: a long-offline desktop uses the same
exact-identity reconciliation, never a snapshot-absence inference. Paused,
offline or closed desktops cannot delete immediately. Active playback and
locked files are retried on later syncs. Changes to selection, permissions,
account, session or root retain files.

The receipt journals only the exact intentionally removed download. Folder
retirement still requires verified cloud coverage for every remaining local
file, including manual and modified files. Mere project detachment, temporary
manifest omissions and derivative replacements are not global deletions.

`electron-updater` is wired in `src/main/updater.js` and the feed is configured in
`electron-builder.yml` (`publish:` → GitHub releases by default). Change
`owner`/`repo` (or switch to a generic URL provider) before the first release.

## How auth + sync work

- The user signs in once; credentials are exchanged for a session and stored in
  the **OS keychain** (`keytar`). If the keychain is unavailable the daemon falls
  back to in-memory credentials and the Settings page says so.
- The daemon registers the device (`POST /api/devices/register`) and sends a
  heartbeat (`POST /api/devices/heartbeat`) on each cycle with disk + sync state.
- The server derives a traffic-light status from `last_seen_at` and surfaces the
  fleet at `GET /api/admin/devices`, rendered by the Device Fleet tile on
  `/admin/health`.

## Icons

The platform icons electron-builder needs are committed as brand-red placeholders
so all three installers build out of the box:

- `assets/icon.ico` (Windows, multi-resolution)
- `assets/icon.icns` (macOS)
- `assets/icon.png` (Linux, 1024×1024 — also the source master)

Regenerate them from the master after editing the artwork:

```bash
node scripts/build-icons.mjs    # requires ImageMagick (`magick`) on PATH
```

Replace the master draw step in `scripts/build-icons.mjs` with real branded
artwork before a public release. The tray PNGs remain solid-color placeholders.
