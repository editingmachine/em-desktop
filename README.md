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
```

## Develop

```bash
cd desktop-app
npm install
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

1. Push this `desktop-app` folder to its own GitHub repository.
2. In that repo: **Actions → "Build desktop installers" → Run workflow**
   (or push a tag like `v1.0.1`).
3. When it finishes, download the installers from the run's **Artifacts**
   (`macos-installer`, `windows-installer`, `linux-installer`).

Code-signing is optional and switched on by adding repo **Secrets** (see below).
Without signing the installers still work but show a first-open security warning.

### The manual way — build on your own machine

```bash
npm run build            # current platform
npm run build:win        # Windows NSIS   (run on Windows)
npm run build:mac        # macOS dmg + zip (run on a Mac)
npm run build:linux      # AppImage       (run on Linux)
```

### Code signing & notarization

`electron-builder` reads signing material from the environment — no secrets are
committed:

- **Windows:** `CSC_LINK` (path to `.pfx`) + `CSC_KEY_PASSWORD`.
- **macOS:** `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`
  (hardened runtime + entitlements are already configured).

### Auto-update

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
