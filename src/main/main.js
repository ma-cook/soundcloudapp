const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL) || !app.isPackaged;

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/ipc.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // External URLs open in the system browser; the app window never navigates.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  if (DEV_SERVER_URL) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../dist/renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// Scaffold IPC handlers. Feature modules (auth, library, recorder, settings)
// register their own ipcMain handlers and extend the preload allowlists.
// ---------------------------------------------------------------------------
ipcMain.handle('app:getInfo', () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron,
  platform: process.platform,
  isDev,
}));

// Liked tracks. The renderer asks for one page at a time with the opaque
// `nextHref` cursor from the previous response (see src/main/scApi.js, which
// validates the cursor and never follows it to a non-SoundCloud host).
ipcMain.handle('likes:getPage', (_event, options) =>
  scApi.fetchLikedTracksPage(options || {})
);

// Audio streaming. The renderer asks for a playable URL per track id;
// src/main/scApi.js resolves the signed media-CDN URL (cached in memory
// only — it expires, so it is never persisted) and validates that it is
// an https:// URL before it is ever handed to the renderer's <audio> element.
ipcMain.handle('media:resolveStream', (_event, trackId, options) =>
  scApi.resolveTrackStream(trackId, options || {})
);

// SoundCloud OAuth2 PKCE login with secure token storage. Loading the module
// registers the auth:* ipcMain handlers and the auth:changed event source
// (see src/main/oauth.js, which uses src/main/tokenStore.js for persistence).
require('./oauth');

// Track Recorder: per-track ffmpeg capture to WAV/FLAC. Loading the module
// registers the recorder:* ipcMain handlers (see src/main/recorder.js, which
// resolves media URLs via scApi and pipes them into ffmpeg in the main
// process — signed CDN URLs never reach the renderer).
const recorder = require('./recorder');

// Recording settings: auto-record toggle, output directory, quality preset.
// Loading the module registers the settings:* ipcMain handlers (see
// src/main/settingsStore.js, which recorder.js also reads through
// settingsStore.getRecordingSettings() when a capture starts).
require('./settingsStore');

app.on('quit', () => {
  recorder.shutdown();
});

// SoundCloud API client backing the `likes:getPage` handler above.
const scApi = require('./scApi');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createMainWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}