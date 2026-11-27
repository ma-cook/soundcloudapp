# soundcloudapp

SoundCloud desktop player with auto-recording (Electron + React + Vite).

## Development

```bash
npm install
npm run dev       # Vite dev server + Electron with live reload
npm start         # build the renderer, then run Electron on it
```

Recording uses the system `ffmpeg` from `PATH` in dev; set `FFMPEG_PATH` to
point at a specific binary.

## Packaging & distribution

Installers for Windows, macOS and Linux are built with
[electron-builder](https://www.electron.build) — configuration lives in the
`build` section of `package.json`, and outputs land in `release/<version>/`.

```bash
npm run dist         # current platform, default targets (NSIS / DMG / AppImage+deb+tar.gz)
npm run dist:win     # Windows NSIS installer (x64)
npm run dist:mac     # macOS DMG (x64 + arm64)
npm run dist:linux   # Linux AppImage, deb and tar.gz
npm run dist:dir     # unpacked app directory only (fast smoke test)
```

### ffmpeg is bundled, not assumed

Packaged builds ship a standalone `ffmpeg` binary as an extraResource
(`vendor/ffmpeg/<os>` → `<resources>/bin`), which `src/main/recorder.js`
resolves at runtime. The `dist*` scripts vendor it automatically before
electron-builder runs (downloaded once, then reused; `node fetch-ffmpeg.mjs
--force` refreshes it). If `vendor/ffmpeg/<os>` is empty the dist step fails
with a clear error — vendoring needs `curl` and `tar` (both preinstalled on
Windows 10+, macOS and common CI images).

To point a packaged build at a different ffmpeg, launch it with `FFMPEG_PATH`
set to the binary's full path.

### Per-platform notes

- **Windows** — NSIS, per-user install with a chosen directory, desktop and
  Start-menu shortcuts. Unsigned; SmartScreen may warn on first run.
- **macOS** — unsigned DMG, universal via separate x64/arm64 artifacts
  (ffmpeg runs under Rosetta 2 on Apple Silicon). For distribution outside
  ad-hoc testing, sign and notarize (`CSC_LINK`/`CSC_KEY_PASSWORD`, plus
  `notarize: true` with App Store Connect credentials).
- **Linux** — AppImage (portable), `deb` (Debian/Ubuntu) and `tar.gz`. The
  AppImage bundles ffmpeg, so no system dependency beyond FUSE.

Version bump (`npm version …`) before `npm run dist` to keep artifact names
and auto-update metadata in sync.

## Manual QA — sign-in gate walkthrough

All signed-in features are gated behind the OAuth session in the renderer
(`src/renderer/App.jsx` + `src/renderer/hooks/useAuth.js`). Verified flow:

1. **Unauthenticated launch** — `useAuth` probes `auth:getStatus` on mount;
   while it runs the main area shows "Checking your SoundCloud session…",
   then the login screen only: "Connect to SoundCloud", header status
   "Not connected", no Sign out button. `LikedTracks`/`RecordingSettings`
   are not mounted, so no `likes:getPage` or `settings:*` calls are made.
2. **Connect** — the button starts the OAuth2 PKCE flow in the system
   browser (`auth:login` in `src/main/oauth.js`): best-effort loopback
   redirect server, state check, code exchange, tokens stored by
   `src/main/tokenStore.js`. While the browser is open the button reads
   "Connecting…"; the paste-redirect-URL fallback stays usable and settles
   a pending sign-in too.
3. **Success** — the token exchange persists the tokens and broadcasts
   `auth:changed`; the renderer flips to the signed-in view: header
   "Connected" with a Sign out button, and `LikedTracks` (first page
   fetched on mount) plus `RecordingSettings` appear.
4. **Sign out** — `auth:logout` clears the stored tokens
   (`tokenStore.clearTokens()`), broadcasts `auth:changed` again, and the
   login screen returns.

Tokens never reach the renderer — only the renderer-safe status object
(`authenticated`, `expiresAt`, `scope`, `hasRefreshToken`, `storage`).