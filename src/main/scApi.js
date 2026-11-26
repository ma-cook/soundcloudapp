'use strict';

/**
 * SoundCloud API client (main process only).
 *
 * All calls to `https://api.soundcloud.com` happen here, in the main process:
 * we attach the `Authorization: OAuth <token>` header obtained from
 * `oauth.getValidAccessToken()`, which transparently refreshes an access
 * token that is about to expire. Raw tokens never cross the contextBridge —
 * the renderer only ever receives normalized JSON payloads over IPC.
 *
 * Liked tracks are fetched from `GET /me/likes/tracks` with
 * `linked_partitioning=1`, which returns a `{ collection, next_href }` page
 * instead of one giant array. The cursor is the opaque absolute `next_href`
 * of the previous response; `fetchLikedTracksPage()` accepts it verbatim
 * (validated to point at api.soundcloud.com) so callers can walk the whole
 * library page by page, or use `fetchLikedTracks()` / `iterLikedTracks()`
 * to drain every page automatically.
 */

const oauth = require('./oauth');

const API_BASE = 'https://api.soundcloud.com';
const API_HOST = 'api.soundcloud.com';
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 15 * 1000;
/** Safety cap so a broken `next_href` loop cannot hang an unbounded fetch. */
const MAX_PAGES = 200;

/**
 * @typedef {Object} ScApiTrackUser
 * @property {number|string} id
 * @property {string}        username
 * @property {string|null}   avatarUrl
 */

/**
 * @typedef {Object} LikedTrack
 * @property {number|string}   id           Stable track id (SoundCloud numeric id).
 * @property {string}          title
 * @property {string|null}     permalinkUrl Web URL of the track page.
 * @property {number}          durationMs   Duration in milliseconds.
 * @property {string|null}     artworkUrl   Artwork upgraded to ~500x500 when possible.
 * @property {boolean}         streamable
 * @property {boolean}         playable
 * @property {string|null}     genre
 * @property {ScApiTrackUser}  user
 * @property {string|null}     likedAt      ISO date of the like, when the API provides it.
 */

/**
 * @typedef {Object} LikedTracksPage
 * @property {LikedTrack[]} tracks        Normalized tracks of this page (order preserved).
 * @property {string|null}  nextHref      Opaque cursor for the next page; null when done.
 * @property {boolean}      hasMore
 * @property {number}       fetchedAt     Epoch milliseconds, for cache freshness checks.
 */

/**
 * @typedef {Object} TrackStream
 * @property {number|string} trackId    Echo of the requested track id.
 * @property {string}        url        Absolute https:// URL an HTML <audio> element can play.
 *                                      Media CDN URLs embed expiring signatures, so treat it as
 *                                      short-lived and never persist it.
 * @property {'progressive'|'hls'} format
 * @property {string}        mimeType   e.g. "audio/mpeg".
 * @property {boolean}       isPreview  True when only a ~30s snippet is licensed for this track.
 * @property {number}        fetchedAt  Epoch milliseconds when the URL was resolved.
 */

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

/** @returns {AbortSignal} signal that aborts after REQUEST_TIMEOUT_MS */
function timeoutSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return controller.signal;
}

/**
 * Best-effort human-readable message from a SoundCloud error body, which
 * appears as `{ message }`, `{ error }` or `{ errors: [...] }` depending on
 * the endpoint generation.
 * @param {unknown} body
 * @returns {string | null}
 */
function extractApiErrorMessage(body) {
  if (!body || typeof body !== 'object') return null;
  const record = /** @type {Record<string, unknown>} */ (body);
  if (typeof record.message === 'string' && record.message) return record.message;
  if (typeof record.error === 'string' && record.error) return record.error;
  const errors = record.errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      if (typeof entry === 'string' && entry) return entry;
      if (entry && typeof entry === 'object') {
        const e = /** @type {Record<string, any>} */ (entry);
        const nested = e.error_message || e.message || (e.meta && e.meta.error);
        if (typeof nested === 'string' && nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Authenticated GET against the SoundCloud API.
 *
 * The access token comes from `oauth.getValidAccessToken()` (auto-refresh
 * near expiry). If the API still answers 401 — e.g. the token was revoked
 * server-side — we force one token refresh and retry exactly once so a
 * stale stored token never breaks a fetch.
 *
 * @param {string} url Absolute https://api.soundcloud.com URL.
 * @param {boolean} [allowRetry] Internal: whether a 401 may trigger a refresh+retry.
 * @returns {Promise<unknown>} Parsed JSON body (null for empty bodies).
 */
async function authedGet(url, allowRetry = true) {
  const token = await oauth.getValidAccessToken();
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${token}`,
        Accept: 'application/json; charset=utf-8',
      },
      signal: timeoutSignal(),
    });
  } catch (err) {
    throw new Error(`Could not reach the SoundCloud API: ${err.message}`);
  }

  if (response.status === 401 && allowRetry) {
    await oauth.refreshTokens();
    return authedGet(url, false);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body — reported via the status error below */
  }
  if (!response.ok) {
    const reason = extractApiErrorMessage(body) || text.slice(0, 200);
    /** @type {Error & { httpStatus?: number, retryAfterSeconds?: number }} */
    const err = new Error(`SoundCloud API request failed (${response.status}): ${reason}`);
    err.httpStatus = response.status;
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterSeconds = retryAfter;
    }
    throw err;
  }
  return body;
}

/**
 * Generic authenticated API GET by path (for future client features).
 * @param {string} path e.g. "/me" — absolute URLs are also accepted.
 * @param {Record<string, string|number|boolean|undefined>} [searchParams]
 * @returns {Promise<unknown>} parsed JSON body
 */
async function apiGet(path, searchParams) {
  const url = new URL(path.startsWith('http') ? path : API_BASE + (path.startsWith('/') ? path : `/${path}`));
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return authedGet(url.toString());
}

/**
 * Follow a `next_href` only when it points at the SoundCloud API host —
 * the cursor is opaque and must never be allowed to redirect credentials
 * elsewhere.
 * @param {string} href
 * @returns {string}
 */
function assertApiCursorUrl(href) {
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    throw new Error('SoundCloud API returned a malformed next_href cursor.');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== API_HOST) {
    throw new Error(
      `Refusing to follow a next_href cursor pointing at "${parsed.hostname}" — expected ${API_HOST}.`
    );
  }
  return parsed.toString();
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * SoundCloud serves artwork at fixed size tokens (`-large`, `-t500x500`,
 * `-original`, ...). Ask for the ~500px rendition for crisp list thumbnails
 * while keeping the response small; other URLs are returned unchanged.
 * @param {unknown} url
 * @returns {string|null}
 */
function upgradeArtworkUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  return url.replace(/-large(\.(jpg|png))/i, '-t500x500$1');
}

/**
 * Accepts both generations of the likes payload: the partitioned
 * `/me/likes/tracks` shape (`{ kind: "like", track, created_at }`) and the
 * plain track-array shape (v1 endpoints). Returns null for non-track noise.
 * @param {unknown} entry
 * @returns {{ track: Record<string, any>, likedAt: string | null } | null}
 */
function unwrapLikeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (entry);
  if (record.track && typeof record.track === 'object') {
    return { track: record.track, likedAt: typeof record.created_at === 'string' ? record.created_at : null };
  }
  if (typeof record.id !== 'undefined' && typeof record.title !== 'undefined') {
    return { track: record, likedAt: null };
  }
  return null;
}

/**
 * Project the (large) API track object onto the fields the UI needs.
 * @param {Record<string, any>} track
 * @param {string|null} likedAt
 * @returns {LikedTrack}
 */
function normalizeTrack(track, likedAt = null) {
  return {
    id: typeof track.id === 'number' ? track.id : String(track.id),
    title: typeof track.title === 'string' && track.title ? track.title : 'Untitled',
    permalinkUrl: typeof track.permalink_url === 'string' ? track.permalink_url : null,
    durationMs: Number(track.full_duration || track.duration || 0) || 0,
    artworkUrl: upgradeArtworkUrl(track.artwork_url),
    streamable: track.streamable !== false,
    playable: track.playable !== false,
    genre: typeof track.genre === 'string' && track.genre ? track.genre : null,
    user: {
      id: typeof track.user?.id === 'number' ? track.user.id : String(track.user?.id ?? ''),
      username:
        typeof track.user?.username === 'string' && track.user.username
          ? track.user.username
          : 'Unknown artist',
      avatarUrl: upgradeArtworkUrl(track.user?.avatar_url),
    },
    likedAt,
  };
}

/**
 * Normalize a partitioned page (`{ collection, next_href }`) or a plain
 * array into a `LikedTracksPage`.
 * @param {unknown} body
 * @returns {LikedTracksPage}
 */
function normalizeLikesPage(body) {
  const record = body && typeof body === 'object' ? /** @type {Record<string, any>} */ (body) : {};
  const collection = Array.isArray(record.collection)
    ? record.collection
    : Array.isArray(record)
      ? record
      : [];
  const tracks = [];
  for (const entry of collection) {
    const unwrapped = unwrapLikeEntry(entry);
    if (unwrapped) tracks.push(normalizeTrack(unwrapped.track, unwrapped.likedAt));
  }
  const nextHref =
    typeof record.next_href === 'string' && record.next_href ? assertApiCursorUrl(record.next_href) : null;
  return {
    tracks,
    nextHref,
    hasMore: Boolean(nextHref),
    fetchedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Public API — liked tracks with pagination
// ---------------------------------------------------------------------------

/**
 * Fetch a single page of the signed-in user's liked tracks.
 * @param {{ limit?: number, nextHref?: string | null }} [options]
 *   `nextHref` is the opaque cursor from a previous page's `nextHref`.
 * @returns {Promise<LikedTracksPage>}
 */
async function fetchLikedTracksPage({ limit = DEFAULT_PAGE_LIMIT, nextHref } = {}) {
  if (nextHref) {
    const url = assertApiCursorUrl(nextHref);
    return normalizeLikesPage(await authedGet(url));
  }
  const clampedLimit = Math.min(Math.max(Math.floor(limit) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);
  return normalizeLikesPage(await apiGet('/me/likes/tracks', { limit: clampedLimit, linked_partitioning: 1 }));
}

/**
 * Walk every page of liked tracks, yielding normalized tracks one by one.
 * @param {{ limit?: number, maxItems?: number }} [options]
 *   `maxItems` stops the walk after that many tracks (default: no limit).
 * @returns {AsyncGenerator<LikedTrack, void, void>}
 */
async function* iterLikedTracks({ limit = DEFAULT_PAGE_LIMIT, maxItems = Number.POSITIVE_INFINITY } = {}) {
  let nextHref = null;
  let yielded = 0;
  let pages = 0;
  do {
    const page = await fetchLikedTracksPage({ limit, nextHref });
    pages += 1;
    for (const track of page.tracks) {
      if (yielded >= maxItems) return;
      yield track;
      yielded += 1;
    }
    nextHref = page.nextHref;
    if (nextHref && pages >= MAX_PAGES) {
      throw new Error(
        `Liked-track pagination exceeded the ${MAX_PAGES}-page safety cap after ${yielded} tracks.`
      );
    }
  } while (nextHref);
}

/**
 * Fetch all liked tracks, aggregating every page. Pass `onPage` to consume
 * pages incrementally (e.g. to stream rows into the UI before the fetch
 * completes).
 * @param {{ limit?: number, maxItems?: number, onPage?: (tracks: LikedTrack[], page: LikedTracksPage) => void }} [options]
 * @returns {Promise<{ tracks: LikedTrack[], total: number, pages: number }>}
 */
async function fetchLikedTracks({
  limit = DEFAULT_PAGE_LIMIT,
  maxItems = Number.POSITIVE_INFINITY,
  onPage,
} = {}) {
  const allTracks = [];
  let nextHref = null;
  let pages = 0;
  do {
    const page = await fetchLikedTracksPage({ limit, nextHref });
    pages += 1;
    const remaining = maxItems - allTracks.length;
    const tracks =
      remaining < page.tracks.length ? page.tracks.slice(0, Math.max(remaining, 0)) : page.tracks;
    allTracks.push(...tracks);
    if (onPage) onPage(tracks, page);
    if (allTracks.length >= maxItems) break;
    nextHref = page.nextHref;
    if (nextHref && pages >= MAX_PAGES) {
      throw new Error(
        `Liked-track pagination exceeded the ${MAX_PAGES}-page safety cap after ${allTracks.length} tracks.`
      );
    }
  } while (nextHref);
  return { tracks: allTracks, total: allTracks.length, pages };
}

// ---------------------------------------------------------------------------
// Public API — track audio streams
// ---------------------------------------------------------------------------

const DEFAULT_MIME_TYPE = 'audio/mpeg';
const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';
/** Signed CDN URLs expire (commonly ~30 min); re-resolve before that. */
const STREAM_URL_TTL_MS = 20 * 60 * 1000;
/** Upper bound of the in-memory stream cache; oldest entries are evicted. */
const STREAM_CACHE_MAX = 128;

/** @type {Map<string, TrackStream>} */
const streamCache = new Map();

/**
 * SoundCloud track ids are numeric. Strings are accepted only when purely
 * numeric, so a poisoned id can never alter the API path we request.
 * @param {number|string} id
 * @returns {string}
 */
function assertTrackId(id) {
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  if (typeof id === 'string' && /^[0-9]+$/.test(id)) return id;
  throw new Error(`Invalid SoundCloud track id: ${JSON.stringify(id ?? null)}`);
}

/**
 * The resolved URL is handed to the renderer's <audio> element, so it must be
 * an absolute https:// URL (SoundCloud media CDNs only serve https).
 * @param {string} url
 * @returns {string}
 */
function assertHttpsMediaUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('SoundCloud returned a malformed media stream URL.');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing to play a media URL with protocol "${parsed.protocol}".`);
  }
  return parsed.toString();
}

/** @param {Record<string, any>} entry @returns {'progressive'|'hls'} */
function readStreamProtocol(entry) {
  const protocol = entry?.format?.protocol;
  return typeof protocol === 'string' && protocol.toLowerCase() === 'hls' ? 'hls' : 'progressive';
}

/** @param {Record<string, any>} entry @param {string} fallback @returns {string} */
function readStreamMimeType(entry, fallback) {
  const mime = entry?.format?.mime_type;
  return typeof mime === 'string' && mime ? mime : fallback;
}

/**
 * One rendition of the stream-manifest payload → `TrackStream`, or null when
 * the rendition is unusable. Unlicensed tracks expose only a short `demo`
 * snippet, which is returned with `isPreview: true`.
 * @param {Record<string, any>|Array} payload
 * @param {string} trackId
 * @returns {TrackStream|null}
 */
function normalizeStreamPayload(payload, trackId) {
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const stream = normalizeStreamPayload(entry, trackId);
      if (stream) return stream;
    }
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const url = typeof payload.url === 'string' && payload.url ? payload.url : null;
  if (url) {
    const format = readStreamProtocol(payload);
    return {
      trackId,
      url: assertHttpsMediaUrl(url),
      format,
      mimeType: readStreamMimeType(payload, format === 'hls' ? HLS_MIME_TYPE : DEFAULT_MIME_TYPE),
      isPreview: false,
      fetchedAt: Date.now(),
    };
  }
  const demo = Array.isArray(payload.demo) ? payload.demo[0] : null;
  if (demo && typeof demo.url === 'string' && demo.url) {
    const format = readStreamProtocol(demo);
    return {
      trackId,
      url: assertHttpsMediaUrl(demo.url),
      format,
      mimeType: readStreamMimeType(demo, DEFAULT_MIME_TYPE),
      isPreview: true,
      fetchedAt: Date.now(),
    };
  }
  return null;
}

/**
 * Resolve an `<audio>`-playable URL for a track.
 *
 * Two round-trips are needed: `GET /tracks/{id}/streams` returns `{ url }`
 * pointing at a transient manifest endpoint; fetching that endpoint yields
 * the actual rendition(s) — a progressive `{ url, format }` object, an HLS
 * object, or (for unlicensed tracks) only a short `demo` snippet. Resulting
 * CDN URLs embed expiring signatures, so they are cached in memory only and
 * never persisted; `force` bypasses the cache to re-resolve.
 *
 * @param {number|string} trackId
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<TrackStream>}
 */
async function resolveTrackStream(trackId, { force = false } = {}) {
  const key = assertTrackId(trackId);
  const cached = streamCache.get(key);
  if (!force && cached && Date.now() - cached.fetchedAt < STREAM_URL_TTL_MS) {
    return cached;
  }

  const streams = await authedGet(`${API_BASE}/tracks/${key}/streams`);
  const streamsRecord =
    streams && typeof streams === 'object' ? /** @type {Record<string, any>} */ (streams) : {};
  const streamUrl =
    typeof streamsRecord.url === 'string' && streamsRecord.url ? streamsRecord.url : null;
  if (!streamUrl) {
    throw new Error(
      'SoundCloud did not return a stream endpoint for this track (it may not be streamable).'
    );
  }

  const stream = normalizeStreamPayload(await authedGet(streamUrl), key);
  if (!stream) {
    throw new Error('SoundCloud returned no playable audio rendition for this track.');
  }

  streamCache.set(key, stream);
  if (streamCache.size > STREAM_CACHE_MAX) {
    const oldest = streamCache.keys().next().value;
    if (oldest !== undefined) streamCache.delete(oldest);
  }
  return stream;
}

/**
 * Basic profile of the signed-in user — handy as an auth sanity check.
 * @returns {Promise<{ id: number|string, username: string, avatarUrl: string|null, permalinkUrl: string|null }>}
 */
async function getMe() {
  const body = await apiGet('/me');
  const me = (body && typeof body === 'object' ? body : /** @type {Record<string, any>} */ ({}));
  return {
    id: typeof me.id === 'number' ? me.id : String(me.id ?? ''),
    username: typeof me.username === 'string' && me.username ? me.username : 'Unknown user',
    avatarUrl: upgradeArtworkUrl(me.avatar_url),
    permalinkUrl: typeof me.permalink_url === 'string' ? me.permalink_url : null,
  };
}

module.exports = {
  apiGet,
  fetchLikedTracksPage,
  fetchLikedTracks,
  iterLikedTracks,
  normalizeTrack,
  resolveTrackStream,
  getMe,
};
