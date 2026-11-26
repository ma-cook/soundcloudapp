import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 50;

/**
 * Paginated access to the signed-in user's liked tracks over the
 * `likes:getPage` IPC bridge.
 *
 * The first page is fetched on mount (unless `auto` is false); `loadMore()`
 * pulls the next page using the opaque `nextHref` cursor of the last
 * response. Every response carries the "generation" it was requested in —
 * only the latest generation may commit state, so a `refresh()` issued while
 * a page is in flight can never interleave stale rows into the fresh list.
 * The list resets itself when the auth session flips between signed-in and
 * signed-out states (token refreshes keep `authenticated` stable and do not
 * clear it).
 *
 * @param {{ auto?: boolean, limit?: number }} [options]
 * @returns {{
 *   tracks: Array,
 *   status: 'loading'|'ready'|'error',
 *   error: string|null,
 *   hasMore: boolean,
 *   loadingMore: boolean,
 *   loadMore: () => void,
 *   refresh: () => void,
 * }}
 */
export default function useLikes({ auto = true, limit = PAGE_SIZE } = {}) {
  const [tracks, setTracks] = useState([]);
  const [status, setStatus] = useState(auto ? 'loading' : 'idle');
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  /** Bumped on refresh/unmount; responses from older generations are dropped. */
  const generationRef = useRef(0);
  const nextHrefRef = useRef(null);
  /** Guards against two concurrent `loadMore()` fetches for the same page. */
  const fetchingRef = useRef(false);
  const lastAuthRef = useRef(null);

  const commitPage = useCallback((generation, mode, page) => {
    if (generation !== generationRef.current) return;
    nextHrefRef.current = page.nextHref;
    setTracks((prev) => {
      // Cursor pagination can repeat a track when likes change between
      // pages; drop anything already in the list.
      const seen = new Set(mode === 'append' ? prev.map((t) => String(t.id)) : []);
      const fresh = page.tracks.filter((t) => !seen.has(String(t.id)));
      return mode === 'append' ? [...prev, ...fresh] : fresh;
    });
    setHasMore(Boolean(page.hasMore));
    setError(null);
    setStatus('ready');
    setLoadingMore(false);
  }, []);

  const failRequest = useCallback((generation, err) => {
    if (generation !== generationRef.current) return;
    setError(err instanceof Error ? err.message : String(err));
    setStatus('error');
    setLoadingMore(false);
  }, []);

  const fetchPage = useCallback(
    async (generation, mode, nextHref) => {
      if (mode === 'append') setLoadingMore(true);
      fetchingRef.current = true;
      try {
        const page = await window.cube.likes.getPage({ limit, nextHref });
        fetchingRef.current = false;
        commitPage(generation, mode, page);
      } catch (err) {
        fetchingRef.current = false;
        failRequest(generation, err);
      }
    },
    [limit, commitPage, failRequest]
  );

  const loadMore = useCallback(() => {
    if (fetchingRef.current || !nextHrefRef.current) return;
    fetchPage(generationRef.current, 'append', nextHrefRef.current);
  }, [fetchPage]);

  const refresh = useCallback(() => {
    const generation = ++generationRef.current;
    nextHrefRef.current = null;
    fetchingRef.current = false;
    setTracks([]);
    setHasMore(false);
    setError(null);
    setStatus('loading');
    fetchPage(generation, 'replace', null);
  }, [fetchPage]);

  // First page on mount.
  useEffect(() => {
    if (!auto) return undefined;
    refresh();
    return () => {
      // Drop any in-flight response after unmount.
      generationRef.current += 1;
    };
  }, [auto, refresh]);

  // Reset when the session flips between signed-in and signed-out.
  useEffect(() => {
    const unsubscribe = window.cube.auth.onChanged((authStatus) => {
      const authenticated = Boolean(authStatus && authStatus.authenticated);
      if (lastAuthRef.current !== null && authenticated !== lastAuthRef.current) {
        refresh();
      }
      lastAuthRef.current = authenticated;
    });
    return unsubscribe;
  }, [refresh]);

  return { tracks, status, error, hasMore, loadingMore, loadMore, refresh };
}
