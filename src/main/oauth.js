'use strict';

/**
 * SoundCloud OAuth2 Authorization Code flow with PKCE.
 *
 * The app never embeds a browser or reads third-party cookies. Instead:
 *   1. We generate a `code_verifier` / `code_challenge` (S256) pair.
 *   2. The system browser opens `https://secure.soundcloud.com/authorize`
 *      with the challenge and a random `state`.
 *   3. SoundCloud redirects to a loopback URL (`http://127.0.0.1:<port>/callback`)
 *      served by a temporary local HTTP server. If the loopback port cannot
 *      be bound (firewall, other app), the user can paste the redirect URL
 *      from the browser address bar into the app instead.
 *   4. We verify `state` (timing-safe), exchange the code for tokens using
 *      the verifier, and hand the tokens to `tokenStore` (encrypted at rest).
 *
 * Raw tokens never leave the main process. The renderer only ever receives
 * status metadata (authenticated, expiry, storage kind) via `auth:getStatus`
 * and `auth:changed` events; API calls are performed in the main process by
 * the SoundCloud API client, which uses `getValidAccessToken()`.
 *
 * Configuration (environment):
 *   SOUNDCLOUD_CLIENT_ID     required — registered SoundCloud application id
 *   SOUNDCLOUD_CLIENT_SECRET optional — included in the token exchange when set
 *   SOUNDCLOUD_REDIRECT_URI  optional — full override of the loopback redirect
 *   SOUNDCLOUD_REDIRECT_PORT optional — loopback port (default 48250)
 *   SOUNDCLOUD_SCOPES        optional — space-separated scopes, default "non-expiring"
 */

const { ipcMain, shell, BrowserWindow } = require('electron');
const crypto = require('crypto');
const http = require('http');
const { URL, URLSearchParams } = require('url');

const tokenStore = require('./tokenStore');

const AUTHORIZE_URL = 'https://secure.soundcloud.com/authorize';
const TOKEN_URL = 'https://secure.soundcloud.com/oauth/token';
const DEFAULT_PORT = 48250;
const CALLBACK_PATH = '/callback';
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
/** Refresh when the access token expires within this window. */
const EXPIRY_SAFETY_MARGIN_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function getClientId() {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'SoundCloud client ID is not configured. Set the SOUNDCLOUD_CLIENT_ID ' +
        'environment variable to the id of a registered SoundCloud application ' +
        'with redirect URI "http://127.0.0.1:48250/callback".'
    );
  }
  return clientId;
}

function getRedirectUri() {
  if (process.env.SOUNDCLOUD_REDIRECT_URI) {
    return process.env.SOUNDCLOUD_REDIRECT_URI;
  }
  const port = Number(process.env.SOUNDCLOUD_REDIRECT_PORT) || DEFAULT_PORT;
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

function getScopes() {
  return process.env.SOUNDCLOUD_SCOPES || 'non-expiring';
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function createPkcePair() {
  // 48 bytes -> 64 base64url chars, inside the RFC 7636 43..128 range.
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function createRandomId(bytes = 24) {
  return base64url(crypto.randomBytes(bytes));
}

/** Timing-safe string comparison; returns false on length mismatch. */
function safeEquals(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Token exchange (token endpoint)
// ---------------------------------------------------------------------------

/**
 * POST to the token endpoint. Throws an Error with a usable message on any
 * non-2xx response, surfacing the OAuth `error` field when present.
 * @param {URLSearchParams} form
 * @returns {Promise<Record<string, unknown>>} parsed JSON body
 */
async function tokenRequest(form) {
  let response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    });
  } catch (err) {
    throw new Error(`Could not reach the SoundCloud token endpoint: ${err.message}`);
  }
  const text = await response.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error body — fall through with the raw text below */
  }
  if (!response.ok) {
    const reason = body.error_description || body.error || text.slice(0, 200);
    /** @type {Error & { oauthError?: string, httpStatus?: number }} */
    const err = new Error(`Token request failed (${response.status}): ${reason}`);
    err.oauthError = typeof body.error === 'string' ? body.error : undefined;
    err.httpStatus = response.status;
    throw err;
  }
  return body;
}

/**
 * Exchange an authorization code for tokens using the PKCE verifier.
 * @param {string} code
 * @param {string} verifier
 * @returns {Promise<Record<string, unknown>>} raw OAuth token payload
 */
async function exchangeCodeForTokens(code, verifier) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
    client_id: getClientId(),
    code_verifier: verifier,
  });
  if (process.env.SOUNDCLOUD_CLIENT_SECRET) {
    form.set('client_secret', process.env.SOUNDCLOUD_CLIENT_SECRET);
  }
  return tokenRequest(form);
}

/**
 * Refresh the access token using the stored refresh token.
 * @returns {Promise<Record<string, unknown>>} raw OAuth token payload
 */
async function refreshTokens() {
  const stored = await tokenStore.loadTokens();
  if (!stored || !stored.refresh_token) {
    throw new Error('No refresh token stored — sign in again.');
  }
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stored.refresh_token,
    client_id: getClientId(),
  });
  if (process.env.SOUNDCLOUD_CLIENT_SECRET) {
    form.set('client_secret', process.env.SOUNDCLOUD_CLIENT_SECRET);
  }
  try {
    const payload = await tokenRequest(form);
    // Some providers omit refresh_token on refresh; keep the existing one.
    if (!payload.refresh_token) payload.refresh_token = stored.refresh_token;
    await tokenStore.saveTokens(payload);
    await broadcastAuthState();
    return payload;
  } catch (err) {
    // invalid_grant / 401: the refresh token is dead — clear it and re-login.
    if (err.oauthError === 'invalid_grant' || err.httpStatus === 401) {
      await tokenStore.clearTokens();
      await broadcastAuthState();
      throw new Error('Session expired — sign in again.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Loopback redirect receiver
// ---------------------------------------------------------------------------

/** @type {{ state: string, verifier: string, redirectUri: string, server: import('http').Server | null, timeout: NodeJS.Timeout | null, resolve: (url: string) => void, reject: (err: Error) => void, done: boolean, exchangePromise: Promise<Record<string, unknown>> | null } | null} */
let pendingLogin = null;

function cleanupLoopbackServer() {
  if (!pendingLogin) return;
  if (pendingLogin.timeout) clearTimeout(pendingLogin.timeout);
  if (pendingLogin.server) pendingLogin.server.close();
  pendingLogin.server = null;
  pendingLogin.timeout = null;
}

function callbackLandingPageHtml(ok, message) {
  const title = ok ? 'Signed in' : 'Sign-in failed';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    '<style>body{background:#0b0d10;color:#f2f4f8;font-family:system-ui,sans-serif;' +
    'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
    'p{opacity:.8}</style></head><body><div><h1>' + title + '</h1><p>' + message +
    '</p></div></body></html>';
}

/**
 * Create the temporary loopback server that receives the OAuth redirect.
 * @param {string} redirectUri
 * @returns {Promise<import('http').Server>} the listening server
 */
function startLoopbackServer(redirectUri) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        req.resume();
        const requestUrl = new URL(req.url || '/', getRedirectUri());
        const oauthError = requestUrl.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          callbackLandingPageHtml(
            !oauthError,
            oauthError
              ? `Authorization failed: ${oauthError}. You can close this tab and retry from the app.`
              : 'SoundCloud sign-in complete. You can close this tab and return to the app.'
          )
        );
        // Resolve with the full redirect URL; verification happens in one place.
        if (pendingLogin && !pendingLogin.done) {
          pendingLogin.done = true;
          pendingLogin.resolve(requestUrl.toString());
        }
      } catch (err) {
        if (pendingLogin && !pendingLogin.done) {
          pendingLogin.done = true;
          pendingLogin.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    server.once('error', reject);
    const { port } = new URL(redirectUri);
    server.listen(Number(port), '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Login orchestration
// ---------------------------------------------------------------------------

/**
 * Build the authorization URL for a PKCE pair and state.
 * @param {string} challenge
 * @param {string} state
 * @param {string} redirectUri
 */
function buildAuthorizeUrl(challenge, state, redirectUri) {
  const params = new URLSearchParams({
    client_id: getClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    scope: getScopes(),
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Verify a redirect URL against the pending session and exchange the code.
 * @param {string} rawUrl
 * @param {{ state: string, verifier: string }} session
 * @returns {Promise<Record<string, unknown>>} raw OAuth token payload
 */
async function verifyAndExchange(rawUrl, session) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('That does not look like a valid redirect URL.');
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new Error(
      parsed.searchParams.get('error_description') || `Authorization failed: ${error}`
    );
  }
  const code = parsed.searchParams.get('code');
  const state = parsed.searchParams.get('state');
  if (!code) {
    throw new Error('The redirect URL did not contain an authorization code.');
  }
  if (!state || !safeEquals(state, session.state)) {
    throw new Error('Authorization state mismatch — aborting sign-in.');
  }

  const payload = await exchangeCodeForTokens(code, session.verifier);
  await tokenStore.saveTokens(payload);
  await broadcastAuthState();
  return payload;
}

/**
 * Handle a redirect URL (from the loopback server or a user-pasted URL),
 * verify state, exchange the code, and persist the tokens. Idempotent per
 * sign-in session: concurrent arrivals (loopback + pasted URL) share one
 * exchange, so the authorization code is redeemed exactly once and an
 * interactive `login()` still waiting on the loopback path is settled either
 * way instead of hanging until the timeout.
 * @param {string} rawUrl
 * @returns {Promise<Record<string, unknown>>} raw OAuth token payload
 */
async function handleCallbackUrl(rawUrl) {
  const session = pendingLogin;
  if (!session) {
    throw new Error('No sign-in is currently in progress.');
  }
  if (session.exchangePromise) {
    return session.exchangePromise;
  }
  session.exchangePromise = (async () => {
    try {
      const payload = await verifyAndExchange(rawUrl, session);
      // Pasted-URL path: settle the interactive login() awaiting the
      // loopback redirect so it does not hang until the timeout.
      if (session === pendingLogin && !session.done) {
        session.done = true;
        session.resolve(rawUrl);
      }
      return payload;
    } catch (err) {
      if (session === pendingLogin && !session.done) {
        session.done = true;
        session.reject(err instanceof Error ? err : new Error(String(err)));
      }
      throw err;
    }
  })();
  return session.exchangePromise;
}

/**
 * Run the full interactive sign-in flow. Resolves with the stored token
 * status; rejects on user cancellation, timeout, or exchange failure.
 * @returns {Promise<object>} auth status (see getSessionStatus)
 */
async function login() {
  if (pendingLogin) {
    throw new Error('A sign-in is already in progress.');
  }

  const redirectUri = getRedirectUri();
  const { verifier, challenge } = createPkcePair();
  const state = createRandomId();

  // Register the pending login *before* the loopback server starts listening,
  // so a fast redirect can never arrive while `pendingLogin` is still null.
  const callbackUrlPromise = new Promise((resolve, reject) => {
    pendingLogin = { state, verifier, redirectUri, server: null, timeout: null, resolve, reject, done: false };
  });

  // The loopback server is best-effort: if its port cannot be bound we still
  // open the browser and let the user paste the redirect URL manually.

  try {
    pendingLogin.server = await startLoopbackServer(redirectUri);
  } catch {
    pendingLogin.server = null;
  }


  pendingLogin.timeout = setTimeout(() => {
    if (pendingLogin && !pendingLogin.done) {
      pendingLogin.done = true;
      pendingLogin.reject(new Error('Sign-in timed out — please try again.'));
    }
  }, LOGIN_TIMEOUT_MS);

  try {
    await shell.openExternal(buildAuthorizeUrl(challenge, state, redirectUri));
  } catch (err) {
    // No system browser available: tear the session down cleanly and let the
    // caller surface the error. The paste-URL path needs a live session, so
    // we cannot keep it around here.
    cleanupLoopbackServer();
    pendingLogin = null;
    throw new Error(`Could not open the system browser: ${err.message}`);
  }

  try {
    const redirectUrl = await callbackUrlPromise;
    // Deduped with any concurrent paste-path exchange via exchangePromise.
    if (pendingLogin) {
      await handleCallbackUrl(redirectUrl);
    }
  } finally {
    cleanupLoopbackServer();
    pendingLogin = null;
  }
  return getSessionStatus();
}

/** Abort an in-progress sign-in (e.g. the user closed the login panel). */
function cancelLogin() {
  if (pendingLogin && !pendingLogin.done) {
    pendingLogin.done = true;
    pendingLogin.reject(new Error('Sign-in cancelled.'));
  }
  cleanupLoopbackServer();
  pendingLogin = null;
}

// ---------------------------------------------------------------------------
// Status / logout
// ---------------------------------------------------------------------------

/**
 * Renderer-safe status snapshot. Never contains raw tokens.
 * @returns {Promise<object>}
 */
async function getSessionStatus() {
  let stored = null;
  try {
    stored = await tokenStore.loadTokens();
  } catch {
    stored = null; // unreadable store == signed out; logout clears the file
  }
  return {
    authenticated: Boolean(stored && stored.access_token),
    expiresAt: stored ? stored.expires_at || null : null,
    scope: stored ? stored.scope || null : null,
    hasRefreshToken: Boolean(stored && stored.refresh_token),
    storage: tokenStore.isEncryptionAvailable() ? 'keyring' : 'plain',
  };
}

/** Sign out: destroy stored tokens and notify the renderer. */
async function logout() {
  await tokenStore.clearTokens();
  await broadcastAuthState();
  return getSessionStatus();
}

/**
 * Access token for main-process SoundCloud API calls, refreshing it when it
 * is about to expire. Never sent to the renderer.
 * @returns {Promise<string>}
 */
async function getValidAccessToken() {
  const stored = await tokenStore.loadTokens();
  if (!stored) throw new Error('Not signed in to SoundCloud.');
  const expiredSoon =
    stored.expires_at > 0 && stored.expires_at - Date.now() < EXPIRY_SAFETY_MARGIN_MS;
  if (expiredSoon && stored.refresh_token) {
    const payload = await refreshTokens();
    return /** @type {string} */ (payload.access_token);
  }
  if (expiredSoon) {
    throw new Error('Access token expired — sign in again.');
  }
  return stored.access_token;
}

// ---------------------------------------------------------------------------
// IPC registration + renderer notifications
// ---------------------------------------------------------------------------

function broadcastAuthState() {
  return getSessionStatus().then((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('auth:changed', status);
    }
    return status;
  });
}

let registered = false;

/** Register the auth IPC handlers (invoked automatically on module load). */
function registerOauthIpc() {
  if (registered) return;
  registered = true;

  ipcMain.handle('auth:login', () => login());
  ipcMain.handle('auth:logout', () => logout());
  ipcMain.handle('auth:getStatus', () => getSessionStatus());
  // Fallback entry point when the loopback redirect cannot reach us.
  ipcMain.handle('auth:complete', async (_event, url) => {
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error('auth:complete requires the redirect URL string.');
    }
    await handleCallbackUrl(url);
    return getSessionStatus(); // never expose raw tokens to the renderer
  });
}

registerOauthIpc();

module.exports = {
  login,
  cancelLogin,
  logout,
  getSessionStatus,
  getValidAccessToken,
  refreshTokens,
  handleCallbackUrl,
  registerOauthIpc,
};
