#!/usr/bin/env node
'use strict';

/**
 * Fetch a standalone ffmpeg binary for the recording pipeline.
 *
 * `src/main/recorder.js` spawns `ffmpeg` from `<resources>/bin` in packaged
 * builds (see `resolveFfmpegPath()` there, plus the `extraResources` entry in
 * package.json, which copies `vendor/ffmpeg/<os>` → `<resources>/bin`). This
 * script is what populates `vendor/ffmpeg/<os>/` before electron-builder runs,
 * so it is part of every `dist*` script:
 *
 *     node fetch-ffmpeg.mjs [--platform windows|macos|linux] [--dest DIR] [--force]
 *
 * Platform defaults to the machine running the build; the per-OS dist scripts
 * pass it explicitly so a Linux CI box can cross-vendor for any target.
 *
 * Sources (pinned, well-known distributions):
 *  - Windows / Linux: BtbN's FFmpeg Builds (GPL build, static, no installer).
 *  - macOS: evermeet.cx release build (x86_64). It runs on Apple Silicon via
 *    Rosetta 2, which ships with macOS by default — good enough for a capture
 *    helper, and avoids depending on unsigned one-off arm64 archives.
 *
 * The binary is ~78 MB; it is vendored once and reused across builds (the
 * script is idempotent — it exits early unless `--force` is given or the
 * destination has no `ffmpeg` binary yet).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** Maps this script's --platform names to electron-builder's ${os} token. */
const PLATFORM_DIRS = Object.freeze({
  windows: 'windows',
  macos: 'macos',
  linux: 'linux',
});

const HOST_PLATFORM = {
  win32: 'windows',
  darwin: 'macos',
  linux: 'linux',
}[process.platform] || 'linux';

/**
 * Pinned download URLs per platform. Keep these stable: a bumped URL must be
 * re-verified (the magic-byte check below guards against truncated/HTML error
 * responses, but not against a changed archive layout).
 */
const FFMPEG_SOURCES = Object.freeze({
  windows: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    ext: '.zip',
    binaryName: 'ffmpeg.exe',
  },
  macos: {
    url: 'https://evermeet.cx/ffmpeg/getrelease/zip',
    ext: '.zip',
    binaryName: 'ffmpeg',
  },
  linux: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    ext: '.tar.xz',
    binaryName: 'ffmpeg',
  },
});

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { platform: HOST_PLATFORM, dest: null, force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--platform') args.platform = argv[++i];
    else if (arg === '--dest') args.dest = argv[++i];
    else if (arg === '--force') args.force = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else {
      fail(`Unknown argument: ${arg} (see --help)`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(`Usage: node fetch-ffmpeg.mjs [--platform <windows|macos|linux>] [--dest <dir>] [--force]

Vendors a standalone ffmpeg binary into vendor/ffmpeg/<os>/ so electron-builder
can ship it as an extraResource (recorder.js resolves it from <resources>/bin).

  --platform  Target platform (default: this machine's OS: ${HOST_PLATFORM})
  --dest      Override the destination directory (default: vendor/ffmpeg/<os>)
  --force     Re-download even if a binary is already vendored
`);
}

function fail(message) {
  process.stderr.write(`fetch-ffmpeg: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Download / extract helpers
// ---------------------------------------------------------------------------

/** Run a command, returning { status, stdout, stderr } without throwing. */
function run(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

/**
 * Download `url` to `destPath` with curl (present on Windows 10+, macOS and
 * virtually every Linux image). `-L` follows the GitHub release redirect;
 * `--fail` turns HTTP errors into non-zero exits so we never "extract" an
 * HTML error page.
 */
function download(url, destPath) {
  process.stdout.write(`fetch-ffmpeg: downloading ${url}\n`);
  const res = run('curl', ['-fSL', '--retry', '3', '--retry-delay', '2', '-o', destPath, url]);
  if (res.status !== 0 || !fs.existsSync(destPath)) {
    fail(`download failed (curl exit ${res.status}):\n${String(res.stderr || '')}`);
  }
}

/**
 * Sanity-check the downloaded archive: big enough to be a real ffmpeg build
 * and not an HTML error page / empty file (ELF/Mach-O/PE checks happen after
 * extraction, on the binary itself).
 */
function verifyArchive(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size < 5 * 1024 * 1024) {
    fail(`downloaded archive is only ${stat.size} bytes — not a real ffmpeg build`);
  }
}

/** Extract any supported archive format with the system tar/bsdtar. */
function extract(archivePath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const res = run('tar', ['-xf', archivePath, '-C', outDir]);
  if (res.status !== 0) {
    fail(`extraction failed (tar exit ${res.status}). Is bsdtar/GNU tar with xz support available?\n${String(res.stderr || '')}`);
  }
}

/** Recursively find a file named `name` (exact match) under `dir`. */
function findFile(dir, name, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(full, name, depth + 1);
      if (hit) return hit;
    } else if (entry.isFile() && entry.name === name) {
      return full;
    }
  }
  return null;
}

/** True if the file starts with a known executable magic (ELF / Mach-O / PE). */
function looksLikeExecutable(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    if (fs.readSync(fd, buf, 0, 4, 0) < 4) return false;
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true; // ELF
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true; // MZ (PE)
    if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) return true; // Mach-O fat
    return buf[0] === 0xcf || buf[0] === 0xca || buf[0] === 0xfe; // Mach-O 64/ARM
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

if (!PLATFORM_DIRS[args.platform]) {
  fail(`unsupported platform "${args.platform}" (expected one of: ${Object.keys(PLATFORM_DIRS).join(', ')})`);
}

const source = FFMPEG_SOURCES[args.platform];
const destDir = args.dest || path.join(REPO_ROOT, 'vendor', 'ffmpeg', PLATFORM_DIRS[args.platform]);
const destBinary = path.join(destDir, source.binaryName);

fs.mkdirSync(destDir, { recursive: true });

if (!args.force && fs.existsSync(destBinary) && looksLikeExecutable(destBinary)) {
  process.stdout.write(`fetch-ffmpeg: ${path.relative(REPO_ROOT, destBinary)} already vendored — skipping (use --force to re-download)\n`);
  process.exit(0);
}

const workDir = fs.mkdtempSync(path.join(destDir, '.fetch-'));
const archivePath = path.join(workDir, `ffmpeg${source.ext}`);

try {
  download(source.url, archivePath);
  verifyArchive(archivePath);
  extract(archivePath, workDir);

  const found = findFile(workDir, source.binaryName) || findFile(workDir, path.basename(source.binaryName, '.exe'));
  if (!found) fail(`ffmpeg binary not found inside the downloaded archive for ${args.platform}`);

  // Cross-vendored binaries can't be executed here — validate by magic bytes
  // instead of running `-version` (which only works for the host platform).
  if (!looksLikeExecutable(found)) fail(`"${found}" does not look like an executable`);

  fs.copyFileSync(found, destBinary);
  if (process.platform !== 'win32') fs.chmodSync(destBinary, 0o755);
  process.stdout.write(`fetch-ffmpeg: vendored ffmpeg (${args.platform}) → ${path.relative(REPO_ROOT, destBinary)}\n`);
} finally {
  fs.rmSync(workDir, { recursive: true, force: true });
}