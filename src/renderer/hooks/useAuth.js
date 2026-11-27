import { useCallback, useEffect, useRef, useState } from 'react';

/** @typedef {'checking'|'signed-in'|'signed-out'} AuthStatus */

/** Normalize anything thrown over IPC into a displayable message. */
function toMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Tracks the SoundCloud OAuth session for the renderer.
 *
 * On mount it probes the current session via `auth:getStatus`. The hook
 * starts in the `checking` state until that round-trip settles, so the app
 * can show a "Checking your SoundCloud session…" placeholder instead of
 * flashing the login screen at already signed-in users. While mounted it
 * follows `auth:changed` events (login, logout, token refresh — a refresh
 * keeps `authenticated` stable and therefore causes no state flip), and
 * `login()` / `logout()` / `complete()` wrap the matching IPC calls so the
 * UI can disable controls and surface errors in one place.
 *
 * The hook never sees raw tokens — the main process only reports the
 * renderer-safe status object
 * `{ authenticated, expiresAt, scope, hasRefreshToken, storage }`.
 *
 * @returns {{
 *   status: AuthStatus,
 *   isAuthenticated: boolean,
 *   isChecking: boolean,
 *   isBusy: boolean,
 *   error: string|null,
 *   session: object|null,
 *   login: () => Promise<boolean>,
 *   logout: () => Promise<void>,
 *   complete: (redirectUrl: string) => Promise<boolean>,
 * }}
 */
export default function useAuth() {
  const [session, setSession] = useState(null);
  const [status, setStatus] = useState('checking');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState(null);
  /** Guards setState after unmount (e.g. a sign-in resolving post-navigation). */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Commit a renderer-safe auth status object. */
  const apply = useCallback((next) => {
    if (!mountedRef.current) return;
    setSession(next || null);
    setStatus(next && next.authenticated ? 'signed-in' : 'signed-out');
  }, []);

  // Initial session probe + live updates for the lifetime of the app.
  useEffect(() => {
    let cancelled = false;
    window.cube.auth
      .getStatus()
      .then((next) => {
        if (!cancelled) apply(next);
      })
      .catch((err) => {
        if (cancelled) return;
        // An unreadable token store or a broken IPC bridge both mean "not
        // signed in" as far as the UI is concerned — surface the reason on
        // the login screen instead of failing silently.
        setError(`Could not read the SoundCloud session: ${toMessage(err)}`);
        apply(null);
      });
    const unsubscribe = window.cube.auth.onChanged((next) => {
      if (cancelled) return;
      setError(null);
      apply(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apply]);

  /** Run the interactive PKCE sign-in in the system browser. */
  const login = useCallback(async () => {
    if (mountedRef.current) {
      setIsBusy(true);
      setError(null);
    }
    try {
      apply(await window.cube.auth.login());
      return true;
    } catch (err) {
      if (mountedRef.current) setError(toMessage(err));
      return false;
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, [apply]);

  /** Clear the stored tokens and drop back to the signed-out state. */
  const logout = useCallback(async () => {
    if (mountedRef.current) {
      setIsBusy(true);
      setError(null);
    }
    try {
      apply(await window.cube.auth.logout());
    } catch (err) {
      if (mountedRef.current) setError(toMessage(err));
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, [apply]);

  /**
   * Manual fallback for the loopback redirect: exchange a redirect URL the
   * user pasted from the browser address bar.
   * @param {string} redirectUrl
   * @returns {Promise<boolean>} whether the sign-in completed
   */
  const complete = useCallback(async (redirectUrl) => {
    if (mountedRef.current) {
      setIsBusy(true);
      setError(null);
    }
    try {
      apply(await window.cube.auth.complete(redirectUrl));
      return true;
    } catch (err) {
      if (mountedRef.current) setError(toMessage(err));
      return false;
    } finally {
      if (mountedRef.current) setIsBusy(false);
    }
  }, [apply]);

  return {
    status,
    isAuthenticated: status === 'signed-in',
    isChecking: status === 'checking',
    isBusy,
    error,
    session,
    login,
    logout,
    complete,
  };
}
