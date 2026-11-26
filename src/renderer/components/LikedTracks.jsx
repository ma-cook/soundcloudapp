import React, { useCallback, useEffect, useRef, useState } from 'react';
import useLikes from '../hooks/useLikes.js';

/** Thumbnail edge length in px — matches the .lt-artwork CSS. */
const ARTWORK_SIZE = 56;

/**
 * m:ss / h:mm:ss from milliseconds; 0 becomes "0:00".
 * @param {number} ms
 */
function formatDuration(ms) {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Artwork thumbnail with a letter fallback while loading / on error.
 * SoundCloud serves square art; non-square images are center-cropped by CSS.
 */
function Artwork({ track }) {
  const [failed, setFailed] = useState(false);
  const url = track.artworkUrl || track.user?.avatarUrl || null;
  const initial = (track.title || '?').trim().charAt(0).toUpperCase() || '?';

  if (!url || failed) {
    return (
      <div className="lt-artwork lt-artwork-fallback" aria-hidden="true">
        {initial}
      </div>
    );
  }
  return (
    <img
      className="lt-artwork"
      src={url}
      alt=""
      width={ARTWORK_SIZE}
      height={ARTWORK_SIZE}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

/**
 * One row of the list. Click / Enter / Space selects the track.
 * @param {{ track: object, index: number, selected: boolean, onSelect: Function }} props
 */
function TrackRow({ track, index, selected, onSelect }) {
  const handleKeyDown = (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(track, index);
    }
  };

  return (
    <li
      className={`lt-row${selected ? ' lt-row-selected' : ''}${track.streamable ? '' : ' lt-row-muted'}`}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(track, index)}
      onKeyDown={handleKeyDown}
    >
      <span className="lt-row-index" aria-hidden="true">
        <span className="lt-row-number">{index + 1}</span>
        <span className="lt-row-play">▶</span>
      </span>
      <Artwork track={track} />
      <span className="lt-row-main">
        <span className="lt-row-title" title={track.title}>
          {track.title}
        </span>
        <span className="lt-row-artist" title={track.user?.username || 'Unknown artist'}>
          {track.user?.username || 'Unknown artist'}
        </span>
      </span>
      <span className="lt-row-side">
        {track.genre && <span className="lt-row-genre">{track.genre}</span>}
        <span className="lt-row-duration">{formatDuration(track.durationMs)}</span>
      </span>
    </li>
  );
}

/**
 * "Liked tracks" list: album-art thumbnails, track title and artist name,
 * fetched page by page. Rows are announced via `onTrackSelect(track, index)`;
 * the app wires that into playback (and the auto-recorder listens for
 * track changes further down the chain).
 *
 * @param {{ onTrackSelect?: (track: object, index: number) => void }} props
 */
export default function LikedTracks({ onTrackSelect }) {
  const { tracks, status, error, hasMore, loadingMore, loadMore, refresh } = useLikes();
  const [selectedIndex, setSelectedIndex] = useState(-1);

  const handleSelect = useCallback(
    (track, index) => {
      setSelectedIndex(index);
      if (onTrackSelect) onTrackSelect(track, index);
    },
    [onTrackSelect]
  );

  // Pull the next page when the sentinel scrolls into view.
  const sentinelRef = useRef(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || loadingMore) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: '200px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, loadMore, tracks.length]);

  return (
    <section className="lt" aria-label="Liked tracks">
      <header className="lt-header">
        <h2 className="lt-heading">Liked tracks</h2>
        {status === 'ready' && (
          <span className="lt-count">
            {tracks.length}
            {hasMore ? '+' : ''} tracks
          </span>
        )}
        {status === 'ready' && tracks.length > 0 && (
          <button type="button" className="lt-refresh" onClick={refresh}>
            Refresh
          </button>
        )}
      </header>

      {status === 'error' && (
        <div className="lt-state" role="alert">
          <p className="lt-state-title">Could not load your liked tracks</p>
          <p className="lt-state-detail">{error}</p>
          <button type="button" className="lt-retry" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {status === 'loading' && (
        <ul className="lt-list" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <li className="lt-row lt-row-skeleton" key={i}>
              <span className="lt-row-index" />
              <span className="lt-artwork lt-artwork-skeleton" />
              <span className="lt-row-main">
                <span className="lt-skeleton-line lt-skeleton-title" />
                <span className="lt-skeleton-line lt-skeleton-artist" />
              </span>
              <span className="lt-skeleton-line lt-skeleton-duration" />
            </li>
          ))}
        </ul>
      )}

      {status === 'ready' && tracks.length === 0 && (
        <div className="lt-state">
          <p className="lt-state-title">No liked tracks yet</p>
          <p className="lt-state-detail">Tracks you like on SoundCloud will appear here.</p>
        </div>
      )}

      {status === 'ready' && tracks.length > 0 && (
        <>
          <ul className="lt-list" role="listbox" aria-label="Liked tracks">
            {tracks.map((track, index) => (
              <TrackRow
                key={track.id}
                track={track}
                index={index}
                selected={index === selectedIndex}
                onSelect={handleSelect}
              />
            ))}
          </ul>
          <div className="lt-footer" ref={sentinelRef}>
            {loadingMore && <span className="lt-loading-more">Loading more…</span>}
            {!loadingMore && hasMore && (
              <button type="button" className="lt-load-more" onClick={loadMore}>
                Load more
              </button>
            )}
            {!hasMore && <span className="lt-end">End of your {tracks.length} liked tracks</span>}
          </div>
        </>
      )}
    </section>
  );
}
