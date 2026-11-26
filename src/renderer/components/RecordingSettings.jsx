import React, { useCallback, useEffect, useState } from 'react';

const PRESET_OPTIONS = [
  { value: 'wav', label: 'WAV — 24-bit / 48 kHz PCM (uncompressed, largest files)' },
  { value: 'flac', label: 'FLAC — lossless compression (same quality, smaller files)' },
];

const FALLBACK_SETTINGS = { autoRecord: false, outputDir: '', qualityPreset: 'wav' };

/**
 * Recording settings panel: auto-record toggle, output directory picker and
 * quality preset. Reads through the `settings:*` IPC bridge (handlers in
 * src/main/settingsStore.js) and re-renders on `settings:changed` broadcasts
 * so every surface of the app shows the same values.
 *
 * Changes are applied immediately (optimistic UI with rollback on error);
 * the directory picker dialog itself never saves — the chosen path is
 * committed here via `setRecording({ outputDir })` so cancelling the dialog
 * leaves the stored value untouched.
 */
export default function RecordingSettings() {
  const [settings, setSettings] = useState(FALLBACK_SETTINGS);
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirPicking, setDirPicking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.cube.settings
      .get()
      .then((stored) => {
        if (!cancelled) setSettings(stored);
      })
      .catch((err) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    const unsubscribe = window.cube.settings.onChanged((next) => {
      if (!cancelled) setSettings(next);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const applyPatch = useCallback(async (patch) => {
    setSaving(true);
    setActionError(null);
    try {
      const next = await window.cube.settings.setRecording(patch);
      setSettings(next); // also arrives via settings:changed; set here for snappiness
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, []);

  const handleAutoRecordToggle = useCallback(
    (event) => {
      applyPatch({ autoRecord: event.target.checked });
    },
    [applyPatch]
  );

  const handlePresetChange = useCallback(
    (event) => {
      applyPatch({ qualityPreset: event.target.value });
    },
    [applyPatch]
  );

  const handleChooseDir = useCallback(async () => {
    setDirPicking(true);
    setActionError(null);
    try {
      const result = await window.cube.settings.chooseOutputDir();
      if (!result.canceled && result.path) {
        await applyPatch({ outputDir: result.path });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setDirPicking(false);
    }
  }, [applyPatch]);

  const handleClearDir = useCallback(() => {
    applyPatch({ outputDir: '' });
  }, [applyPatch]);

  const busy = saving || dirPicking;

  return (
    <section className="rs" aria-label="Recording settings">
      <header className="rs-header">
        <h2 className="rs-heading">Recording settings</h2>
      </header>

      {loadError && (
        <p className="rs-status rs-status-error" role="alert">
          Stored settings could not be read ({loadError}). Showing defaults — saving will
          rebuild the settings file.
        </p>
      )}

      <div className="rs-row">
        <label className="rs-row-main" htmlFor="rs-auto-record">
          <span className="rs-label">
            <input
              id="rs-auto-record"
              type="checkbox"
              className="rs-toggle"
              checked={settings.autoRecord}
              onChange={handleAutoRecordToggle}
              disabled={busy}
            />
            Auto-record tracks
          </span>
          <span className="rs-hint">
            When enabled, each track you play is captured automatically with ffmpeg.
          </span>
        </label>
      </div>

      <div className="rs-row">
        <span className="rs-row-main">
          <span className="rs-label" id="rs-output-dir-label">
            Output directory
          </span>
          <span className="rs-dir-path" title={settings.outputDir || undefined}>
            {settings.outputDir
              ? settings.outputDir
              : 'Default (your Music folder, in a "SoundCloud Desktop" subfolder)'}
          </span>
          <span className="rs-actions">
            <button
              type="button"
              className="rs-button"
              onClick={handleChooseDir}
              disabled={busy}
            >
              {dirPicking ? 'Choosing…' : 'Browse…'}
            </button>
            {settings.outputDir && (
              <button
                type="button"
                className="rs-button rs-button-secondary"
                onClick={handleClearDir}
                disabled={busy}
              >
                Use default
              </button>
            )}
          </span>
        </span>
      </div>

      <div className="rs-row">
        <label className="rs-row-main" htmlFor="rs-quality">
          <span className="rs-label">Quality preset</span>
          <select
            id="rs-quality"
            className="rs-select"
            value={settings.qualityPreset}
            onChange={handlePresetChange}
            disabled={busy}
          >
            {PRESET_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {actionError && (
        <p className="rs-status rs-status-error" role="alert">
          {actionError}
        </p>
      )}
    </section>
  );
}
