const { contextBridge, ipcRenderer } = require('electron');

// Allowlists: the renderer can only reach these channels. Feature modules
// extend both sets as they register new ipcMain handlers / events.
const INVOKE_CHANNELS = new Set([
  'app:getInfo',
  // OAuth2 PKCE login (src/main/oauth.js)
  'auth:login',
  'auth:logout',
  'auth:getStatus',
  'auth:complete',
  // Liked tracks pagination (src/main/scApi.js via src/main/main.js)
  'likes:getPage',
  // Track recorder (src/main/recorder.js)
  'recorder:enqueue',
  'recorder:getState',
  'recorder:cancel',
  'recorder:clearFinished',
  // Recording settings (src/main/settingsStore.js)
  'settings:get',
  'settings:setRecording',
  'settings:chooseOutputDir',
]);
const EVENT_CHANNELS = new Set([
  'auth:changed',
  'recorder:changed',
  'settings:changed',
]);

/**
 * Invoke a whitelisted main-process handler.
 * @param {string} channel
 * @param {unknown} [payload]
 * @returns {Promise<unknown>}
 */
function invoke(channel, payload) {
  if (!INVOKE_CHANNELS.has(channel)) {
    return Promise.reject(new Error(`Channel "${channel}" is not exposed to the renderer`));
  }
  return ipcRenderer.invoke(channel, payload);
}

/**
 * Subscribe to a main-process event with automatic cleanup support.
 * @param {string} channel
 * @param {(payload: unknown) => void} listener
 * @returns {() => void} unsubscribe function
 */
function subscribe(channel, listener) {
  if (!EVENT_CHANNELS.has(channel)) {
    throw new Error(`Channel "${channel}" is not exposed to the renderer`);
  }
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api = {
  invoke,
  subscribe,
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
  },
  /**
   * SoundCloud OAuth2 session control. Handlers live in src/main/oauth.js;
   * every method resolves to a renderer-safe status object:
   * `{ authenticated, expiresAt, scope, hasRefreshToken, storage }`.
   * Raw access/refresh tokens are never exposed to the renderer.
   */
  auth: {
    /** Opens the system browser for the PKCE authorize step. */
    login: () => ipcRenderer.invoke('auth:login'),
    /** Clears the stored tokens and signs out. */
    logout: () => ipcRenderer.invoke('auth:logout'),
    /** Current session status (no tokens). */
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
    /**
     * Manual fallback when the loopback redirect cannot reach the app:
     * paste the full redirect URL from the browser address bar.
     */
    complete: (redirectUrl) => ipcRenderer.invoke('auth:complete', redirectUrl),
    /**
     * Subscribe to session changes (login, logout, token refresh).
     * @param {(status: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    onChanged: (listener) => subscribe('auth:changed', listener),
  },
  /**
   * Liked tracks. Pages come from GET /me/likes/tracks via `likes:getPage`;
   * the main process normalizes each track to:
   * `{ id, title, permalinkUrl, durationMs, artworkUrl, streamable, playable,
   *    genre, user: { id, username, avatarUrl }, likedAt }`.
   */
  likes: {
    /**
     * Fetch one page of the signed-in user's liked tracks.
     * @param {{ limit?: number, nextHref?: string|null }} [options]
     * @returns {Promise<{ tracks: Array, nextHref: string|null, hasMore: boolean, fetchedAt: number }>}
     */
    getPage: (options) => ipcRenderer.invoke('likes:getPage', options || {}),
  },
  /**
   * Audio streaming. `resolveStream` returns
   * `{ trackId, url, format: 'progressive'|'hls', mimeType, isPreview, fetchedAt }`.
   * The URL is a signed media-CDN link that expires; it is for the
   * <audio> element only — never persist it. Pass `{ force: true }` to
   * bypass the main-process cache and re-resolve.
   */
  media: {
    resolveStream: (trackId, options) =>
      ipcRenderer.invoke('media:resolveStream', trackId, options || {}),
  },
  /**
   * Recording settings. Handlers live in src/main/settingsStore.js, which
   * persists `{ autoRecord, outputDir, qualityPreset }` to a JSON file in
   * userData and broadcasts every change on `settings:changed`.
   */
  settings: {
    /** Current recording settings. */
    get: () => ipcRenderer.invoke('settings:get'),
    /**
     * Merge a partial patch (`{ autoRecord, outputDir, qualityPreset }`)
     * into the stored settings and persist it.
     * @returns {Promise<object>} the settings now in effect
     */
    setRecording: (patch) => ipcRenderer.invoke('settings:setRecording', patch),
    /**
     * Open the OS directory picker. Resolves to
     * `{ canceled, path }` without saving anything — commit the chosen
     * path with `setRecording({ outputDir })`.
     */
    chooseOutputDir: () => ipcRenderer.invoke('settings:chooseOutputDir'),
    /**
     * Subscribe to settings changes (any successful setRecording).
     * @param {(settings: object) => void} listener
     * @returns {() => void} unsubscribe
     */
    onChanged: (listener) => subscribe('settings:changed', listener),
  },
};

contextBridge.exposeInMainWorld('cube', api);