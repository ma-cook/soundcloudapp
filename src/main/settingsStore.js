'use strict';

/**
 * Recording settings store (main process only).
 *
 * Owns the user's recording preferences — the auto-record toggle, the output
 * directory, and the quality preset — and persists them to a plain JSON file
 * inside the app's `userData` directory. Nothing here is a secret, so unlike
 * `tokenStore.js` the file is stored unencrypted; writes are still atomic
 * (temp file + rename) so a crash can never leave a half-written settings
 * file behind.
 *
 * On-disk shape (versioned so the format can evolve):
 *   { "v": 1, "settings": { autoRecord, outputDir, qualityPreset } }
 *
 * Consumers:
 *  - `src/main/recorder.js` calls `getRecordingSettings()` **synchronously**
 *    when a job starts, so the store keeps an in-memory cache and loads it
 *    from disk once at module init (a small file — a sync read at startup is
 *    fine and keeps the recorder pipeline dependency-free of async wiring).
 *  - The renderer reads/writes via the `settings:*` IPC handlers registered
 *    below; every successful change is broadcast on `settings:changed` so all
 *    windows (and the recorder status UI) can re-render from one source of
 *    truth.
 *
 * This module registers the `settings:*` ipcMain handlers on load, the same
 * way `oauth.js` and `recorder.js` do.
 */

const { app, ipcMain, BrowserWindow, dialog } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const STORE_VERSION = 1;
const STORE_FILE = 'soundcloud-settings.json';

/** Supported quality presets. Keys mirror the ffmpeg encoder choices in recorder.js. */
const QUALITY_PRESETS = Object.freeze(['wav', 'flac']);

/**
 * Defaults. `outputDir: ''` means "not set" — recorder.js then falls back to
 * the system Music folder (userData as a last resort). `autoRecord` defaults
 * to false: capturing audio only starts once the user opts in.
 */
const DEFAULT_SETTINGS = Object.freeze({
  autoRecord: false,
  outputDir: '',
  qualityPreset: 'wav',
});

/** @typedef {{ autoRecord: boolean, outputDir: string, qualityPreset: 'wav'|'flac' }} RecordingSettings */

/** @type {RecordingSettings | null} in-memory cache; null until first load. */
let cache = null;

/** Set when the on-disk file exists but could not be parsed/applied. */
let lastLoadError = null;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Coerce arbitrary input (a parsed JSON file or an IPC patch) into a valid
 * settings object. Unknown/invalid fields silently fall back to defaults so
 * a hand-edited or partially-written file can never break the app; the one
 * case that *is* rejected loudly is a relative output directory on `set`
 * (see updateRecordingSettings).
 * @param {unknown} input
 * @returns {RecordingSettings}
 */
function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {};
  const preset = source.qualityPreset;
  return {
    autoRecord: source.autoRecord === true,
    outputDir: typeof source.outputDir === 'string' ? source.outputDir.trim() : '',
    qualityPreset:
      typeof preset === 'string' && QUALITY_PRESETS.includes(preset)
        ? /** @type {'wav'|'flac'} */ (preset)
        : DEFAULT_SETTINGS.qualityPreset,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function storeFilePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

/** Load settings from disk into the cache. Never throws; a corrupt or
 *  missing file yields defaults (corruption is reported via lastLoadError
 *  and left untouched on disk until the next successful save). */
function loadFromDiskSync() {
  lastLoadError = null;
  let raw;
  try {
    raw = require('fs').readFileSync(storeFilePath(), 'utf8');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      cache = null; // first run — defaults apply
      return;
    }
    lastLoadError = err instanceof Error ? err.message : String(err);
    cache = null;
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== STORE_VERSION) {
      throw new Error(`Unsupported settings store version: ${parsed && parsed.v}`);
    }
    cache = normalizeSettings(parsed.settings);
  } catch (err) {
    lastLoadError = err instanceof Error ? err.message : String(err);
    cache = null;
  }
}

/** Write bytes atomically (temp file + rename), like tokenStore.js. */
async function writeAtomically(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, data);
  await fs.rename(tmpPath, filePath);
}

/**
 * Persist a settings object to disk and refresh the cache.
 * @param {RecordingSettings} settings
 */
async function saveSettings(settings) {
  const payload = JSON.stringify({ v: STORE_VERSION, settings });
  await fs.mkdir(path.dirname(storeFilePath()), { recursive: true });
  await writeAtomically(storeFilePath(), Buffer.from(payload, 'utf8'));
  cache = settings;
}

// ---------------------------------------------------------------------------
// Public API (main process)
// ---------------------------------------------------------------------------

/**
 * Current settings, loading them from disk on first access.
 * @returns {RecordingSettings}
 */
function getSettings() {
  if (cache === null) loadFromDiskSync();
  return { ...(cache || DEFAULT_SETTINGS) };
}

/**
 * Recorder-facing view of the settings. Kept synchronous — recorder.js reads
 * this at the start of every job.
 * @returns {{ autoRecord: boolean, outputDir: string|null, format: 'wav'|'flac' }}
 */
function getRecordingSettings() {
  const settings = getSettings();
  return {
    autoRecord: settings.autoRecord,
    outputDir: settings.outputDir || null, // '' -> recorder falls back to Music
    format: settings.qualityPreset,
  };
}

/** Why the on-disk file could not be read, if it could not be. */
function getLoadError() {
  return lastLoadError;
}

/**
 * Merge a partial patch into the stored settings, persist it, and notify the
 * renderer. Throws on a clearly invalid patch (relative output directory) so
 * the renderer can surface the problem instead of silently storing a path
 * the recorder cannot resolve.
 * @param {unknown} patch e.g. { autoRecord: true } or { qualityPreset: 'flac' }
 * @returns {Promise<RecordingSettings>} the settings now in effect
 */
async function updateRecordingSettings(patch) {
  const source = patch && typeof patch === 'object' ? /** @type {Record<string, unknown>} */ (patch) : {};
  if ('outputDir' in source) {
    const dir = typeof source.outputDir === 'string' ? source.outputDir.trim() : '';
    // '' clears the override (back to the Music folder) and is always valid.
    if (dir && !path.isAbsolute(dir)) {
      throw new Error('Output directory must be an absolute path.');
    }
  }
  const next = normalizeSettings({ ...getSettings(), ...source });
  await saveSettings(next);
  broadcastSettingsChanged(next);
  return { ...next };
}

// ---------------------------------------------------------------------------
// IPC registration + renderer notifications
// ---------------------------------------------------------------------------

function broadcastSettingsChanged(settings) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('settings:changed', settings);
  }
}

/**
 * Open the OS directory picker. Returns the chosen path without saving —
 * the renderer decides when to commit it via `settings:setRecording`, so the
 * dialog can be cancelled or previewed without mutating the store.
 * @returns {Promise<{ canceled: boolean, path: string | null }>}
 */
async function chooseOutputDir() {
  const parent =
    BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) || null;
  const result = await dialog.showOpenDialog(parent, {
    title: 'Choose where recordings are saved',
    defaultPath: getSettings().outputDir || undefined,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, path: null };
  }
  return { canceled: false, path: result.filePaths[0] };
}

let registered = false;

/** Register the settings IPC handlers (invoked automatically on module load). */
function registerSettingsIpc() {
  if (registered) return;
  registered = true;

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:setRecording', (_event, patch) => updateRecordingSettings(patch));
  ipcMain.handle('settings:chooseOutputDir', () => chooseOutputDir());
}

registerSettingsIpc();

module.exports = {
  getSettings,
  getRecordingSettings,
  getLoadError,
  updateRecordingSettings,
  chooseOutputDir,
  registerSettingsIpc,
  QUALITY_PRESETS,
  DEFAULT_SETTINGS,
};
