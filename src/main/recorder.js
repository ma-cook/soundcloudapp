'use strict';

/**
 * Track Recorder (main process only).
 *
 * Per-track capture pipeline: resolve the signed media-CDN URL for a track
 * (via `scApi.resolveTrackStream`, which keeps OAuth out of the renderer),
 * then pipe that URL into an `ffmpeg` child process that decodes it to
 * either a 24-bit 48 kHz PCM WAV or a lossless FLAC (level 8) file.
 *
 * Design notes:
 *  - Jobs are queued (concurrency 1) and recorded one at a time; the track
 *    that triggered auto-record is enqueued with `reason: 'auto'`.
 *  - Output goes to `<outputDir>/SoundCloud Desktop/<Artist> - <Title>.<ext>`,
 *    written as `<name>.<ext>.part` and renamed atomically when ffmpeg
 *    exits 0, so a crashed capture never leaves a half-written file that
 *    looks complete.
 *  - ffmpeg reads the media directly from its https URL; the signed CDN
 *    link never leaves the main process and is never persisted.
 *  - Every state transition is broadcast on the `recorder:changed` event so
 *    the renderer can render progress bars from one source of truth.
 *  - A watchdog kills ffmpeg when no data has arrived for a while; failed
 *    `.part` files are removed before the job is marked failed.
 *
 * This module registers the `recorder:*` ipcMain handlers on load, the same
 * way `oauth.js` does.
 */

const { app, ipcMain, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

const scApi = require('./scApi');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Simultaneous ffmpeg captures. One keeps disk/CPU sane and preserves order. */
const MAX_CONCURRENT_JOBS = 1;
/** Abort an ffmpeg run that has produced no new data for this long. */
const STALL_TIMEOUT_MS = 30 * 1000;
/** Upper bound on a single capture (failsafe against a hung source). */
const MAX_JOB_DURATION_MS = 4 * 60 * 60 * 1000;
/** Delay before auto-retrying a failed job. */
const RETRY_DELAY_MS = 2 * 1000;

/**
 * ffmpeg binary resolution. Packaged builds ship the binary under
 * `<resources>/bin` (see the `extraResources` mapping in package.json, which
 * copies `vendor/ffmpeg/<os>` there — `ffmpeg.exe` on Windows, `ffmpeg`
 * elsewhere); `FFMPEG_PATH` overrides it for local runs.
 */
function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  if (app.isPackaged) {
    const binary = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    return path.join(process.resourcesPath || '', 'bin', binary);
  }
  return 'ffmpeg'; // rely on PATH in dev
}

// ---------------------------------------------------------------------------
// Track naming / output layout
// ---------------------------------------------------------------------------

/** Sanitize a segment for use inside a file name. */
function sanitizeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

/**
 * Build `<Artist> - <Title>.<ext>` from a LikedTrack + settings.
 * @param {{ id: number|string, title: string, user?: { username?: string } }} track
 * @param {{ format: 'wav'|'flac' }} preset
 * @returns {string}
 */
function buildOutputFileName(track, preset) {
  const artist = sanitizeSegment(track.user?.username, 'Unknown artist');
  const title = sanitizeSegment(track.title, `Track ${track.id}`);
  return `${artist} - ${title}.${preset.format}`;
}

/**
 * Resolve + create the directory a capture will be written into.
 * Layout: `<settings.outputDir>/SoundCloud Desktop/<filename>`.
 * @param {{ outputDir?: string }} settings
 * @param {string} fileName
 * @returns {Promise<string>}
 */
async function prepareOutputDir(settings, fileName) {
  let base;
  if (settings.outputDir && String(settings.outputDir).trim()) {
    base = String(settings.outputDir).trim();
  } else {
    try {
      base = app.getPath('music');
    } catch {
      // No system Music folder (some Linux setups) — fall back to userData.
      base = app.getPath('userData');
    }
  }
  // Avoid doubling the folder when the user already picked .../SoundCloud Desktop.
  const dir =
    path.basename(base) === 'SoundCloud Desktop'
      ? base
      : path.join(base, 'SoundCloud Desktop');
  await fs.mkdir(dir, { recursive: true });
  return path.join(dir, fileName);
}

// ---------------------------------------------------------------------------
// ffmpeg argument construction
// ---------------------------------------------------------------------------

/**
 * High-quality per-format ffmpeg arguments.
 *  - input: the signed media-CDN URL (ffmpeg fetches it itself; progressive
 *    mp3/aac and HLS playlists both work with the default demuxers).
 *  - wav:  signed 24-bit PCM, 48 kHz, stereo (`-c:a pcm_s24le`).
 *  - flac: lossless FLAC, compression level 8.
 * `-map_metadata -1` keeps the file free of CDN query junk; `-progress pipe:1`
 * turns stdout into machine-readable progress key=value lines (watchdog
 * kicks + byte counts come from there).
 * @param {string} mediaUrl Signed https media URL (input).
 * @param {string} outputPath `.part` temp path
 * @param {{ format: 'wav'|'flac' }} preset
 * @returns {string[]}
 */
function buildFfmpegArgs(mediaUrl, outputPath, preset) {
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-nostdin',
    '-y',
    '-nostats',
    '-progress', 'pipe:1',
    // Input: ffmpeg fetches the signed https media URL itself (progressive
    // mp3/aac and HLS playlists both demux straight from the URL).
    '-i', mediaUrl,
    // Output options must come after the input: `-map_metadata` is an
    // output-only option and ffmpeg rejects it placed before `-i`.
    '-vn', // ignore embedded cover streams; artwork is not part of the audio job
    '-map_metadata', '-1',
  ];
  if (preset.format === 'wav') {
    args.push('-c:a', 'pcm_s24le', '-ar', '48000', '-ac', '2');
  } else {
    args.push('-c:a', 'flac', '-compression_level', '8');
  }
  args.push(outputPath);
  return args;
}

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------

let nextJobSeq = 1;

/**
 * @typedef {Object} RecorderJob
 * @property {string} id
 * @property {number|string} trackId
 * @property {string} title
 * @property {string} artist
 * @property {'auto'|'manual'} reason
 * @property {'queued'|'recording'|'completed'|'failed'|'cancelled'} status
 * @property {string|null} outputPath
 * @property {string|null} error
 * @property {number} createdAt
 * @property {number|null} startedAt
 * @property {number|null} finishedAt
 * @property {number} bytesWritten  Output bytes written so far (ffmpeg total_size).
 * @property {number} recordedMs    Recorded audio duration in ms (ffmpeg out_time_us).
 * @property {number} durationMs    Full track duration in ms (0 = unknown), for progress %.
 * @property {number} attempt
 */
/** @type {RecorderJob[]} */
const jobs = [];

/** @type {Set<string>} */
const cancelling = new Set();

let runningJobs = 0;

/** ffmpeg child processes keyed by job id. */
const activeChildren = new Map();

/** Renderer-safe snapshot of one job (no paths beyond the output file). */
function publicJob(job) {
  return {
    id: job.id,
    trackId: job.trackId,
    title: job.title,
    artist: job.artist,
    reason: job.reason,
    status: job.status,
    outputPath: job.outputPath,
    error: job.error,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    bytesWritten: job.bytesWritten,
    recordedMs: job.recordedMs,
    durationMs: job.durationMs,
    attempt: job.attempt,
  };
}

function getJob(id) {
  return jobs.find((j) => j.id === id) || null;
}

function broadcastState() {
  const payload = {
    jobs: jobs.map(publicJob),
    running: runningJobs > 0,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('recorder:changed', payload);
  }
}

// ---------------------------------------------------------------------------
// Queue driving
// ---------------------------------------------------------------------------

async function pumpQueue() {
  if (runningJobs >= MAX_CONCURRENT_JOBS) return;
  const next = jobs.find((j) => j.status === 'queued');
  if (!next) return;

  runningJobs += 1;
  try {
    await runJob(next);
  } finally {
    runningJobs -= 1;
    if (cancelling.has(next.id)) cancelling.delete(next.id);
    broadcastState();
    setImmediate(pumpQueue);
  }
}

/**
 * Run one job end-to-end: resolve the CDN URL, stream it through ffmpeg,
 * then atomically rename the `.part` file into place.
 * @param {RecorderJob} job
 */
async function runJob(job) {
  const settings = getRecorderSettings();
  const fileName = buildOutputFileName(job, settings.preset);
  let targetPath;
  let partPath;
  try {
    targetPath = await prepareOutputDir(settings, fileName);
    partPath = `${targetPath}.part`;
  } catch (err) {
    job.status = 'failed';
    job.error = `Could not prepare output directory: ${err.message}`;
    job.finishedAt = Date.now();
    return;
  }

  job.status = 'recording';
  job.startedAt = Date.now();
  job.finishedAt = null; // reset from any earlier failed attempt
  job.error = null;
  job.outputPath = targetPath;
  broadcastState();

  try {
    // Resolve fresh — the signed CDN URL expires and must never be reused.
    const stream = await scApi.resolveTrackStream(job.trackId, { force: true });
    if (cancelling.has(job.id)) {
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      return;
    }
    await captureWithFfmpeg(stream.url, partPath, settings.preset, job);
    if (cancelling.has(job.id)) {
      await fs.rm(partPath, { force: true }).catch(() => {});
      job.status = 'cancelled';
      job.finishedAt = Date.now();
      return;
    }
    await fs.rename(partPath, targetPath);
    job.bytesWritten = (await fs.stat(targetPath)).size;
    job.status = 'completed';
    job.finishedAt = Date.now();
  } catch (err) {
    await fs.rm(partPath, { force: true }).catch(() => {});
    if (cancelling.has(job.id)) {
      job.status = 'cancelled';
    } else {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.attempt += 1;
      if (job.attempt < 3) {
        job.status = 'queued';
        const retryTimer = setTimeout(() => {
          if (getJob(job.id)?.status === 'queued') pumpQueue();
        }, RETRY_DELAY_MS);
        if (typeof retryTimer.unref === 'function') retryTimer.unref();
      }
    }
    if (job.status !== 'queued') job.finishedAt = Date.now();
  }
}

/**
 * Spawn ffmpeg, feed it the CDN URL, and pipe progress.
 * @param {string} mediaUrl
 * @param {string} partPath
 * @param {{ format: 'wav'|'flac' }} preset
 * @param {RecorderJob} job
 */
function captureWithFfmpeg(mediaUrl, partPath, preset, job) {
  return new Promise((resolve, reject) => {
    if (cancelling.has(job.id)) {
      reject(new Error('cancelled'));
      return;
    }
    const child = spawn(resolveFfmpegPath(), buildFfmpegArgs(mediaUrl, partPath, preset), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.set(job.id, child);

    let stderr = '';
    let settled = false;
    const finalize = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      clearTimeout(maxTimer);
      activeChildren.delete(job.id);
      if (err) reject(err);
      else resolve();
    };

    // Watchdog: abort if ffmpeg stops producing data for STALL_TIMEOUT_MS.
    const stallTimer = setTimeout(() => {
      stderr += '\nffmpeg stalled: no data received in time.';
      child.kill('SIGKILL');
    }, STALL_TIMEOUT_MS);
    const maxTimer = setTimeout(() => {
      stderr += '\nffmpeg exceeded the maximum recording duration.';
      child.kill('SIGKILL');
    }, MAX_JOB_DURATION_MS);
    const kick = () => {
      clearTimeout(stallTimer);
      stallTimer.refresh();
    };

    child.on('spawn', () => broadcastState());

    // ffmpeg's log/error output (with `-loglevel error`, failures only) —
    // captured so a non-zero exit can report the reason.
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 16 * 1024) stderr = stderr.slice(-8 * 1024);
    });

    // `-progress pipe:1` emits `key=value` lines on stdout: `total_size` for
    // bytes written so far, `out_time_us` for recorded audio microseconds.
    let progressBuf = '';
    child.stdout.on('data', (chunk) => {
      progressBuf += chunk.toString();
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop() || '';
      for (const line of lines) {
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = Number(line.slice(eq + 1).trim());
        if (!Number.isFinite(value)) continue;
        if (key === 'total_size' && value >= 0) job.bytesWritten = value;
        else if (key === 'out_time_us' && value >= 0) job.recordedMs = Math.round(value / 1000);
      }
      kick();
      broadcastState();
    });

    child.on('error', (err) => finalize(new Error(`Could not start ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (cancelling.has(job.id)) {
        finalize(new Error('cancelled'));
        return;
      }
      if (code === 0) finalize();
      else finalize(new Error(`ffmpeg exited with code ${code}: ${stderr.trim().slice(-400)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Settings plumbing
// ---------------------------------------------------------------------------

/**
 * The recorder needs `{ outputDir, preset: { format: 'wav'|'flac' } }`.
 * `settingsStore.js` (companion task) will own persistence; until it
 * registers itself we fall back to environment / defaults so the pipeline
 * is testable standalone.
 */
const settingsStore = (() => {
  try {
    // eslint-disable-next-line global-require
    return require('./settingsStore');
  } catch {
    return null;
  }
})();

/** @returns {{ outputDir: string|null, preset: { format: 'wav'|'flac' } }} */
function getRecorderSettings() {
  if (settingsStore && typeof settingsStore.getRecordingSettings === 'function') {
    const stored = settingsStore.getRecordingSettings();
    if (stored) {
      const format = stored.format === 'flac' ? 'flac' : 'wav';
      return { outputDir: stored.outputDir || null, preset: { format } };
    }
  }
  const envFormat = process.env.RECORDER_FORMAT === 'flac' ? 'flac' : 'wav';
  return {
    outputDir: process.env.RECORDER_OUTPUT_DIR || null,
    preset: { format: envFormat },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enqueue a track for capture. `reason` distinguishes auto-record
 * (track-change event) from an explicit user request.
 * @param {{ id: number|string, title: string, user?: { username?: string } }} track
 * @param {{ reason?: 'auto'|'manual' }} [options]
 * @returns {Promise<RecorderJob>}
 */
async function enqueueTrack(track, { reason = 'manual' } = {}) {
  if (!track || typeof track.id === 'undefined') {
    throw new Error('enqueueTrack requires a track object with an id.');
  }
  if (reason !== 'auto' && reason !== 'manual') {
    throw new Error(`enqueueTrack reason must be "auto" or "manual", got "${reason}".`);
  }
  const job = {
    id: `job-${nextJobSeq++}`,
    trackId: track.id,
    title: typeof track.title === 'string' && track.title ? track.title : 'Untitled',
    artist: track.user?.username || 'Unknown artist',
    durationMs: Number(track.durationMs) || 0,
    reason,
    status: 'queued',
    outputPath: null,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    bytesWritten: 0,
    recordedMs: 0,
    attempt: 0,
  };
  jobs.push(job);
  broadcastState();
  setImmediate(pumpQueue);
  return publicJob(job);
}

/** Cancel an in-flight or queued job. Completed jobs cannot be cancelled. */
async function cancelJob(id) {
  const job = getJob(id);
  if (!job) throw new Error(`Unknown recorder job: ${id}`);
  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return publicJob(job);
  }
  cancelling.add(id);
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.finishedAt = Date.now();
    cancelling.delete(id); // never reached the runner; nothing will consume it
  } else {
    const child = activeChildren.get(id);
    if (child) child.kill('SIGKILL');
  }
  broadcastState();
  return publicJob(job);
}

/** Snapshot for `recorder:getState`. */
function getState() {
  return { jobs: jobs.map(publicJob), running: runningJobs > 0 };
}

/** Forget finished jobs; running/queued jobs are kept. */
function clearFinishedJobs() {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const status = jobs[i].status;
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      jobs.splice(i, 1);
    }
  }
  broadcastState();
  return getState();
}

/** Stop everything and clean up. Called on app quit. */
function shutdown() {
  for (const child of activeChildren.values()) {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  activeChildren.clear();
}

// ---------------------------------------------------------------------------
// IPC registration (same pattern as oauth.js)
// ---------------------------------------------------------------------------

let registered = false;

function registerRecorderIpc() {
  if (registered) return;
  registered = true;

  ipcMain.handle('recorder:enqueue', (_event, track, options) =>
    enqueueTrack(track, options || {})
  );
  ipcMain.handle('recorder:getState', () => getState());
  ipcMain.handle('recorder:cancel', (_event, jobId) => cancelJob(jobId));
  ipcMain.handle('recorder:clearFinished', () => clearFinishedJobs());
}

registerRecorderIpc();

module.exports = {
  enqueueTrack,
  cancelJob,
  getState,
  clearFinishedJobs,
  shutdown,
  registerRecorderIpc,
};
