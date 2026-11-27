import React, { useEffect, useState } from 'react';
import LikedTracks from './components/LikedTracks.jsx';
import RecordingSettings from './components/RecordingSettings.jsx';
import LoginPage from './components/LoginPage.jsx';
import useAuth from './hooks/useAuth.js';

const FALLBACK_APP_INFO = {
  name: 'SoundCloud Desktop',
  version: '0.1.0',
  electron: '',
  platform: 'unknown',
  isDev: false,
};

/**
 * Root renderer component. Renders the app shell and verifies the
 * main <-> renderer IPC bridge via the `app:getInfo` round-trip.
 */
export default function App() {
  const [appInfo, setAppInfo] = useState(FALLBACK_APP_INFO);
  const [error, setError] = useState(null);
  const {
    isAuthenticated,
    isChecking,
    isBusy: isAuthBusy,
    error: authError,
    login,
    logout,
    complete,
  } = useAuth();

  useEffect(() => {
    let cancelled = false;
    window.cube.app
      .getInfo()
      .then((info) => {
        if (!cancelled) setAppInfo(info);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1 className="app-title">{appInfo.name}</h1>
        <span className="app-badge">v{appInfo.version}</span>
        <span className="app-header-status">
          {isChecking ? 'Checking your SoundCloud session…' : isAuthenticated ? 'Connected' : 'Not connected'}
        </span>
        {isAuthenticated && (
          <button type="button" className="login-signout" onClick={() => logout()} disabled={isAuthBusy}>
            {isAuthBusy ? 'Signing out…' : 'Sign out'}
          </button>
        )}
      </header>

      <main className="app-main">
        {isChecking ? (
          <p className="app-auth-checking">Checking your SoundCloud session…</p>
        ) : isAuthenticated ? (
          <>
            <LikedTracks />

            <RecordingSettings />
          </>
        ) : (
          <LoginPage
            onLogin={login}
            onComplete={complete}
            isBusy={isAuthBusy}
            error={authError}
          />
        )}

        <dl className="app-meta">
          <div className="app-meta-row">
            <dt>Platform</dt>
            <dd>{appInfo.platform}</dd>
          </div>
          <div className="app-meta-row">
            <dt>Electron</dt>
            <dd>{appInfo.electron || '—'}</dd>
          </div>
          <div className="app-meta-row">
            <dt>IPC bridge</dt>
            <dd>{error ? 'unavailable' : 'connected'}</dd>
          </div>
        </dl>

        {error && (
          <p className="app-error" role="alert">
            IPC error: {error}
          </p>
        )}
      </main>
    </div>
  );
}