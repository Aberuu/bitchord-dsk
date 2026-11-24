import { AlertTriangle, Download, ExternalLink, LogOut, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  desktopApi,
  isTauriDesktop,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type UpdaterPrefs,
} from '@/desktop/tauriBridge';
import { useUi } from '@/state/ui';

export const UPDATE_RESULT_EVENT = 'bitchord:update-result';

export function publishUpdateResult(result: UpdateCheckResult): void {
  window.dispatchEvent(new CustomEvent<UpdateCheckResult>(UPDATE_RESULT_EVENT, { detail: result }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export interface UpdateBannerAndGateProps {
  /** Optional controlled state for unit testing without Tauri runtime. */
  initialResult?: UpdateCheckResult | null;
  initialPrefs?: UpdaterPrefs | null;
  forceDesktop?: boolean;
}

export function UpdateBannerAndGate({
  initialResult = null,
  initialPrefs = null,
  forceDesktop = false,
}: UpdateBannerAndGateProps) {
  const desktop = forceDesktop || isTauriDesktop();
  const [result, setResult] = useState<UpdateCheckResult | null>(initialResult);
  const [prefs, setPrefs] = useState<UpdaterPrefs | null>(initialPrefs);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(initialResult?.downloadedPath ?? null);
  const autoDownloadStartedRef = useRef<string | null>(null);
  const actionRef = useRef<HTMLButtonElement>(null);

  const mandatory = Boolean(result?.mandatory);

  useEffect(() => {
    useUi.getState().setMandatoryUpdateLocked(mandatory);
    return () => {
      useUi.getState().setMandatoryUpdateLocked(false);
    };
  }, [mandatory]);

  useEffect(() => {
    if (!mandatory) return;
    actionRef.current?.focus({ preventScroll: true });
    const blockEscape = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
      }
    };
    window.addEventListener('keydown', blockEscape, true);
    return () => window.removeEventListener('keydown', blockEscape, true);
  }, [mandatory]);

  const startDownload = useCallback(async (target: UpdateCheckResult) => {
    if (!target.installerUrl) return;
    setDownloading(true);
    setError(null);
    try {
      const path = await desktopApi.downloadUpdate(
        target.installerUrl,
        target.installerFileName,
        target.installerSha256,
      );
      setDownloadedPath(path);
      setResult((prev) =>
        prev
          ? {
              ...prev,
              downloadedPath: path,
              status: prev.mandatory ? 'mandatory' : 'downloaded',
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDownloading(false);
    }
  }, []);

  const runCheck = useCallback(async () => {
    if (!desktop) return;
    try {
      const loadedPrefs = await desktopApi.updaterGetPrefs();
      setPrefs(loadedPrefs);
      if (!loadedPrefs.autoCheckUpdates) return;
      const checked = await desktopApi.checkForUpdates();
      setResult(checked);
      setDownloadedPath(checked.downloadedPath);
      if (
        !checked.mandatory &&
        checked.status === 'available' &&
        checked.installerUrl &&
        !checked.downloadedPath &&
        loadedPrefs.autoDownloadUpdates &&
        checked.latestVersion &&
        autoDownloadStartedRef.current !== checked.latestVersion
      ) {
        autoDownloadStartedRef.current = checked.latestVersion;
        void startDownload(checked);
      }
    } catch {
      // Startup background check stays silent when offline.
    }
  }, [desktop, startDownload]);

  useEffect(() => {
    if (!desktop || initialResult !== null) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    void desktopApi
      .onUpdaterProgress((p) => {
        if (active) setProgress(p);
      })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch(() => {});

    const startupTimer = window.setTimeout(() => {
      if (active) void runCheck();
    }, 2000);
    const interval = window.setInterval(() => {
      if (active) void runCheck();
    }, 6 * 60 * 60 * 1000);

    const onExternalResult = (ev: Event) => {
      const detail = (ev as CustomEvent<UpdateCheckResult>).detail;
      if (!detail) return;
      setResult(detail);
      setDownloadedPath(detail.downloadedPath);
      setError(null);
      if (detail.latestVersion && detail.latestVersion !== dismissedVersion) {
        setDismissedVersion(null);
      }
    };
    window.addEventListener(UPDATE_RESULT_EVENT, onExternalResult);

    return () => {
      active = false;
      window.clearTimeout(startupTimer);
      window.clearInterval(interval);
      window.removeEventListener(UPDATE_RESULT_EVENT, onExternalResult);
      unlisten?.();
    };
  }, [desktop, initialResult, runCheck, dismissedVersion]);

  const handleInstallOrDownload = async () => {
    if (!result) return;
    if (downloadedPath) {
      setError(null);
      try {
        await desktopApi.installUpdate(downloadedPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (result.installerUrl) {
      await startDownload(result);
    }
  };

  if (!desktop || !result) return null;

  const pct =
    progress?.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
      : null;

  if (result.mandatory) {
    return (
      <div
        className="fixed inset-0 z-[calc(var(--z-modal)+10)] flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mandatory-update-title"
        aria-describedby="mandatory-update-desc"
        data-mandatory-update="true"
      >
        <div className="w-[min(480px,95vw)] overflow-hidden rounded-[22px] border border-search-border/80 bg-page p-6 text-primary shadow-[0_28px_72px_rgba(0,0,0,0.6)]">
          <div className="flex items-start gap-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-key/15 text-key">
              <AlertTriangle size={20} strokeWidth={2.2} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="mandatory-update-title" className="type-[700_18px/23px] text-primary">
                Update required to continue
              </h2>
              <p id="mandatory-update-desc" className="mt-1.5 type-body-reduced text-secondary">
                This installation (v{result.currentVersion}) is{' '}
                <strong className="font-semibold text-primary">
                  {result.majorPatchLag} major patches behind
                </strong>{' '}
                v{result.latestVersion ?? 'latest'}. BitChord allows at most {result.maxMajorPatchLag} major
                patches behind before requiring an update.
              </p>
            </div>
          </div>

          {result.notes && (
            <div className="mt-4 max-h-32 overflow-y-auto rounded-[12px] bg-quinary px-3.5 py-2.5 type-callout text-secondary whitespace-pre-wrap">
              {result.notes}
            </div>
          )}

          {downloading && (
            <div className="mt-4 rounded-[12px] bg-quinary p-3" aria-live="polite">
              <div className="flex items-center justify-between type-footnote text-secondary">
                <span>
                  {progress?.phase === 'verifying'
                    ? 'Verifying SHA-256 checksum...'
                    : 'Downloading installer...'}
                </span>
                <span>
                  {progress
                    ? pct !== null
                      ? `${pct}% (${formatBytes(progress.receivedBytes)})`
                      : formatBytes(progress.receivedBytes)
                    : 'Starting...'}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-quaternary">
                <div
                  className="h-full rounded-full bg-key transition-[width] duration-150"
                  style={{ width: `${pct ?? 25}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-key/40 bg-key/10 px-3.5 py-2.5 type-callout text-primary"
            >
              <span className="min-w-0 flex-1 break-words">{error}</span>
              {result.installerUrl && (
                <button
                  type="button"
                  onClick={() => void startDownload(result)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-pill bg-quaternary px-3 py-1 type-footnote font-semibold text-primary hover:bg-tracklist-hover"
                >
                  <RefreshCw size={12} aria-hidden="true" />
                  Retry
                </button>
              )}
            </div>
          )}

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => void desktopApi.exitApp()}
              className="inline-flex items-center gap-1.5 rounded-pill bg-quinary px-4 py-2 type-callout-emphasized text-secondary transition-colors hover:bg-quaternary hover:text-primary"
            >
              <LogOut size={14} aria-hidden="true" />
              Exit BitChord
            </button>
            {result.releaseUrl && (
              <a
                href={result.releaseUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-pill bg-quaternary px-4 py-2 type-callout-emphasized text-primary transition-colors hover:bg-tracklist-hover"
              >
                <ExternalLink size={14} aria-hidden="true" />
                Release Page
              </a>
            )}
            {(result.installerUrl || downloadedPath) && (
              <button
                ref={actionRef}
                type="button"
                disabled={downloading}
                onClick={() => void handleInstallOrDownload()}
                className="inline-flex items-center gap-1.5 rounded-pill bg-key px-4 py-2 type-callout-emphasized text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Download size={14} aria-hidden="true" />
                {downloading
                  ? 'Downloading...'
                  : downloadedPath
                    ? 'Install Update'
                    : 'Update & Install'}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const showSoftBanner =
    (result.status === 'available' || result.status === 'downloaded') &&
    result.latestVersion &&
    dismissedVersion !== result.latestVersion &&
    prefs?.skippedVersion !== result.latestVersion;

  if (!showSoftBanner) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed right-5 bottom-[calc(var(--player-pill-height)+var(--player-bottom-offset)+16px)] z-(--z-web-chrome) flex max-w-[min(440px,calc(100vw-32px))] items-center gap-3 rounded-[16px] border border-search-border/80 bg-page/96 px-4 py-3 text-primary shadow-[0_14px_38px_rgba(0,0,0,0.35)] backdrop-blur-xl"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate type-callout-emphasized text-primary">
          BitChord v{result.latestVersion} {downloadedPath ? 'ready to install' : 'available'}
        </p>
        <p className="mt-0.5 truncate type-footnote text-secondary">
          {error
            ? error
            : downloading
              ? pct !== null
                ? `Downloading update (${pct}%)...`
                : 'Downloading update...'
              : result.majorPatchLag > 0
                ? `${result.majorPatchLag}/${result.maxMajorPatchLag} major patches behind`
                : 'Patch update ready.'}
        </p>
      </div>
      {result.installerUrl || downloadedPath ? (
        <button
          type="button"
          disabled={downloading}
          onClick={() => void handleInstallOrDownload()}
          className="shrink-0 rounded-pill bg-key px-3 py-1.5 type-footnote font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {downloading ? 'Downloading...' : downloadedPath ? 'Install Update' : 'Download'}
        </button>
      ) : result.releaseUrl ? (
        <a
          href={result.releaseUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-pill bg-quaternary px-3 py-1.5 type-footnote font-semibold text-primary hover:bg-tracklist-hover"
        >
          Open Release
        </a>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss update notification"
        onClick={() => setDismissedVersion(result.latestVersion)}
        className="grid size-7 shrink-0 place-items-center rounded-full text-secondary transition-colors hover:bg-quinary hover:text-primary"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
