'use strict';

/**
 * Secure storage for SoundCloud OAuth tokens.
 *
 * Tokens are encrypted at rest with Electron's `safeStorage` (DPAPI on
 * Windows, Keychain on macOS, libsecret/kwallet on Linux) and persisted to a
 * single file inside the app's `userData` directory. Writes are atomic
 * (temp file + rename) and carry a 0600 mode on POSIX filesystems.
 *
 * On-disk envelope (versioned so the format can evolve):
 *   { "v": 1, "enc": "safeStorage" | "plain", "data": <base64 payload> }
 *
 * `enc: "plain"` is a best-effort fallback used only when the OS keyring is
 * unavailable (typically headless Linux); consumers can call
 * `isEncryptionAvailable()` to warn the user in that case.
 */

const { safeStorage, app } = require('electron');
const fs = require('fs/promises');
const path = require('path');

const STORE_VERSION = 1;
const STORE_FILE = 'soundcloud-oauth-tokens.json';

/**
 * @typedef {Object} TokenRecord
 * @property {string}  access_token          SoundCloud OAuth access token.
 * @property {string}  [refresh_token]       Long-lived refresh token, if granted.
 * @property {string}  [token_type]          Usually "Bearer".
 * @property {string}  [scope]               Space-separated granted scopes.
 * @property {number}  expires_at            Epoch milliseconds; 0 = unknown.
 * @property {number}  [created_at]          Epoch milliseconds.
 */

/** @type {TokenRecord | null} */
let cache = null;

function storeFilePath() {
  return path.join(app.getPath('userData'), STORE_FILE);
}

/** True when the OS can encrypt secrets at rest. */
function isEncryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** @param {TokenRecord} record */
function toEnvelope(record) {
  const json = JSON.stringify(record);
  if (isEncryptionAvailable()) {
    return {
      v: STORE_VERSION,
      enc: 'safeStorage',
      data: safeStorage.encryptString(json).toString('base64'),
    };
  }
  return {
    v: STORE_VERSION,
    enc: 'plain',
    data: Buffer.from(json, 'utf8').toString('base64'),
  };
}

/** @param {unknown} envelope @returns {TokenRecord} */
function fromEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Token store file is corrupt (not an object)');
  }
  const { v, enc, data } = /** @type {Record<string, unknown>} */ (envelope);
  if (v !== STORE_VERSION) {
    throw new Error(`Unsupported token store version: ${String(v)}`);
  }
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('Token store file is corrupt (missing payload)');
  }
  if (enc === 'safeStorage') {
    if (!isEncryptionAvailable()) {
      throw new Error(
        'Tokens were encrypted with the OS keyring, which is unavailable now'
      );
    }
    return JSON.parse(safeStorage.decryptString(Buffer.from(data, 'base64')));
  }
  if (enc === 'plain') {
    return JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  }
  throw new Error(`Unsupported token store encryption: ${String(enc)}`);
}

/**
 * Fill defaults and normalize the expiry fields of a raw token payload.
 * Accepts either `expires_at` (epoch ms) or `expires_in` (seconds, as OAuth
 * servers return) and always produces a `expires_at` on the record.
 * @param {Record<string, unknown>} input
 * @returns {TokenRecord}
 */
function normalizeTokenRecord(input) {
  if (typeof input.access_token !== 'string' || input.access_token === '') {
    throw new TypeError('Token record must include a non-empty access_token');
  }
  /** @type {TokenRecord} */
  const record = {
    access_token: input.access_token,
    token_type: typeof input.token_type === 'string' && input.token_type ? input.token_type : 'Bearer',
  };
  if (typeof input.refresh_token === 'string' && input.refresh_token) {
    record.refresh_token = input.refresh_token;
  }
  if (typeof input.scope === 'string' && input.scope) {
    record.scope = input.scope;
  }
  if (typeof input.created_at === 'number') {
    record.created_at = input.created_at;
  }
  if (typeof input.expires_at === 'number') {
    record.expires_at = input.expires_at;
  } else if (typeof input.expires_in === 'number') {
    record.expires_at = Date.now() + input.expires_in * 1000;
  } else {
    record.expires_at = 0; // unknown expiry
  }
  return record;
}

/** Write bytes atomically with owner-only permissions where supported. */
async function writeAtomically(filePath, data) {
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, data, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}

/**
 * Persist tokens (encrypting them when the OS supports it) and update the
 * in-memory cache. Accepts raw OAuth token payloads (`expires_in`) as well
 * as normalized records (`expires_at`).
 * @param {Record<string, unknown>} tokens
 * @returns {Promise<TokenRecord>} the normalized record that was stored
 */
async function saveTokens(tokens) {
  const record = normalizeTokenRecord(tokens);
  await fs.mkdir(path.dirname(storeFilePath()), { recursive: true });
  await writeAtomically(storeFilePath(), Buffer.from(JSON.stringify(toEnvelope(record))));
  cache = record;
  return record;
}

/**
 * Read and decrypt the stored tokens.
 * @returns {Promise<TokenRecord|null>} null when no tokens are stored.
 * @throws when the store exists but cannot be read/decrypted (callers decide
 *   whether to clear and force re-login).
 */
async function loadTokens() {
  if (cache) return cache;
  let raw;
  try {
    raw = await fs.readFile(storeFilePath());
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
    throw err;
  }
  const record = normalizeTokenRecord(fromEnvelope(JSON.parse(raw.toString('utf8'))));
  cache = record;
  return record;
}

/**
 * Merge a partial update (e.g. a refreshed access token) into the stored
 * record and persist it.
 * @param {Partial<TokenRecord>} patch
 * @returns {Promise<TokenRecord>}
 */
async function updateTokens(patch) {
  const current = await loadTokens();
  if (!current) {
    throw new Error('Cannot update tokens: no token record stored');
  }
  return saveTokens({ ...current, ...patch });
}

/**
 * Remove the stored tokens from disk and memory. Missing file is not an error.
 * @returns {Promise<void>}
 */
async function clearTokens() {
  cache = null;
  try {
    await fs.unlink(storeFilePath());
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
}

module.exports = {
  saveTokens,
  loadTokens,
  updateTokens,
  clearTokens,
  isEncryptionAvailable,
};
