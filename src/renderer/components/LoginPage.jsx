import React, { useState } from 'react';

/**
 * Sign-in screen shown whenever there is no SoundCloud session.
 *
 * The primary action starts the OAuth2 PKCE flow in the system browser
 * (`auth:login`, handled in src/main/oauth.js). Because the OAuth redirect
 * arrives on a loopback URL served by the main process, the screen also
 * offers a manual fallback: when the loopback callback cannot reach the app
 * (firewall, port in use, browser on another device) the user pastes the
 * redirect URL from the browser address bar and it is exchanged via
 * `auth:complete`.
 *
 * The fallback must stay usable *while* the browser flow is pending — a
 * pending `login()` is settled by a pasted URL too — so only the connect
 * button is disabled while busy.
 *
 * Props come from the single useAuth() instance owned by App.jsx so session
 * state, busy flags and errors live in one place.
 *
 * @param {{
 *   onLogin: () => Promise<boolean>,
 *   onComplete: (redirectUrl: string) => Promise<boolean>,
 *   isBusy?: boolean,
 *   error?: string|null,
 * }} props
 */
export default function LoginPage({ onLogin, onComplete, isBusy = false, error = null }) {
  const [redirectUrl, setRedirectUrl] = useState('');
  const [showFallback, setShowFallback] = useState(false);

  /** Start the interactive browser sign-in flow. */
  async function handleConnect() {
    setShowFallback(false);
    await onLogin();
  }

  /** Exchange a pasted redirect URL (manual loopback fallback). */
  async function handleSubmit(event) {
    event.preventDefault();
    const url = redirectUrl.trim();
    if (!url) return;
    const ok = await onComplete(url);
    if (ok) setRedirectUrl('');
  }

  return (
    <section className="login" aria-labelledby="login-heading">
      <h2 className="login-title" id="login-heading">
        Connect your SoundCloud account
      </h2>
      <p className="login-copy">
        Sign in to browse your liked tracks and record them. A browser window
        opens for the SoundCloud login — this app never sees your password.
      </p>

      <button type="button" className="login-button" onClick={handleConnect} disabled={isBusy}>
        {isBusy ? 'Connecting…' : 'Connect to SoundCloud'}
      </button>

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}

      {showFallback ? (
        <form className="login-fallback" onSubmit={handleSubmit}>
          <label className="login-fallback-label" htmlFor="login-redirect-url">
            Paste the redirect URL from the browser address bar
          </label>
          <textarea
            id="login-redirect-url"
            className="login-fallback-input"
            rows={2}
            value={redirectUrl}
            placeholder="http://127.0.0.1:48250/callback?code=…&state=…"
            onChange={(event) => setRedirectUrl(event.target.value)}
            spellCheck={false}
          />
          <div className="login-fallback-actions">
            <button
              type="submit"
              className="login-button"
              disabled={isBusy || redirectUrl.trim().length === 0}
            >
              Complete sign-in
            </button>
            <button
              type="button"
              className="login-fallback-cancel"
              onClick={() => setShowFallback(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="login-fallback-toggle"
          onClick={() => setShowFallback(true)}
        >
          Signed in in the browser but stuck on this screen?
        </button>
      )}
    </section>
  );
}
