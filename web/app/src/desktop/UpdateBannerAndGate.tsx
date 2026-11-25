import { ArrowRight } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  desktopApi,
  isTauriDesktop,
  type UpdateCheckResult,
  type UpdateDownloadProgress,
  type UpdaterPrefs,
} from '@/desktop/tauriBridge';
import { ReleaseNotesMarkdown } from '@/desktop/ReleaseNotesMarkdown';
import { useUi } from '@/state/ui';

export const UPDATE_RESULT_EVENT = 'bitchord:update-result';
const PREVIEW_HASH = '#preview-software-update';

const PREVIEW_RESULT: UpdateCheckResult = {
  status: 'available',
  currentVersion: '1.1.1',
  latestVersion: '1.2.1',
  majorPatchLag: 1,
  maxMajorPatchLag: 3,
  mandatory: false,
  releaseUrl: 'https://github.com/Aberuu/bitchord-dsk/releases',
  installerUrl: 'https://github.com/Aberuu/bitchord-dsk/releases/download/v1.2.1/BitChord_1.2.1_x64-setup.exe',
  installerSha256: null,
  installerFileName: 'BitChord_1.2.1_x64-setup.exe',
  downloadedPath: null,
  notes: [
    '### BitChord Desktop v1.2.1',
    '',
    '### Highlights',
    '- **Windows Wireless Cast (Miracast):** Open the native `Win + K` display picker right from Cast to TV, plus improved Chromecast and DLNA discovery.',
    '- **Single-Pass Auto-Updater:** Custom install folders such as `D:\\Program File\\BitChord` now update cleanly in one download and automatically reopen.',
    '- **Startup Behavior:** Reopening BitChord always lands on **Home** with your last played song ready to resume.',
    '',
    '#### Fixed Details',
    '- Repaired legacy backslash tags like \\quick_login.rs\\ and \\QuickSignInModal\\ for legible release notes.',
    '- Added ordered list support and generous typography spacing.',
    '',
    '#### Windows x64 Installers',
    '- BitChord_1.2.1_x64-setup.exe',
    '- BitChord_1.2.1_x64_en-US.msi',
  ].join('\n'),
};

export function publishUpdateResult(result: UpdateCheckResult): void {
  window.dispatchEvent(new CustomEvent<UpdateCheckResult>(UPDATE_RESULT_EVENT, { detail: result }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export interface UpdateBannerAndGateProps {
  /** Optional controlled state for unit testing or visual preview without Tauri runtime. */
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
  const modalOpen = useUi((s) => s.updateModalOpen);
  const setModalOpen = useUi((s) => s.setUpdateModalOpen);
  const setHasPendingUpdate = useUi((s) => s.setHasPendingUpdate);

  const [previewMode, setPreviewMode] = useState(
    () => typeof window !== 'undefined' && window.location.hash === PREVIEW_HASH,
  );
  const [result, setResult] = useState<UpdateCheckResult | null>(
    initialResult ?? (typeof window !== 'undefined' && window.location.hash === PREVIEW_HASH ? PREVIEW_RESULT : null),
  );
  const [prefs, setPrefs] = useState<UpdaterPrefs | null>(initialPrefs);
  const [downloading, setDownloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(
    initialResult?.downloadedPath ?? null,
  );
  const lastNotifiedVersionRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const mandatory = Boolean(result?.mandatory);
  const isAvailable = Boolean(
    result &&
      (result.status === 'available' ||
        result.status === 'downloaded' ||
        result.status === 'mandatory') &&
      result.latestVersion,
  );

  // Open automatically when a controlled initialResult is provided in tests/previews.
  useEffect(() => {
    if (!initialResult) return;
    setResult(initialResult);
    setDownloadedPath(initialResult.downloadedPath ?? null);
    const shouldOpen =
      initialResult.status === 'available' ||
      initialResult.status === 'downloaded' ||
      initialResult.status === 'mandatory';
    setHasPendingUpdate(shouldOpen);
    if (shouldOpen) setModalOpen(true);
  }, [initialResult, setHasPendingUpdate, setModalOpen]);

  useEffect(() => {
    const syncHash = () => {
      const active = window.location.hash === PREVIEW_HASH;
      setPreviewMode(active);
      if (active) {
        setResult(PREVIEW_RESULT);
        setModalOpen(true);
      }
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, [setModalOpen]);

  useEffect(() => {
    useUi.getState().setMandatoryUpdateLocked(mandatory);
    return () => {
      useUi.getState().setMandatoryUpdateLocked(false);
    };
  }, [mandatory]);

  useEffect(() => {
    setHasPendingUpdate(isAvailable);
  }, [isAvailable, setHasPendingUpdate]);

  const dismissLater = useCallback(() => {
    if (mandatory || applying) return;
    if (previewMode) {
      if (window.location.hash === PREVIEW_HASH) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
      setPreviewMode(false);
    }
    setModalOpen(false);
  }, [mandatory, applying, previewMode, setModalOpen]);

  useEffect(() => {
    if (!modalOpen && !mandatory && !previewMode) return;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      dismissLater();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modalOpen, mandatory, previewMode, dismissLater]);

  const applyUpdate = useCallback(async (path: string) => {
    setApplying(true);
    setError(null);
    setProgress({
      receivedBytes: 0,
      totalBytes: null,
      phase: 'applying',
      message: 'Installing update and restarting BitChord...',
    });
    try {
      await desktopApi.installUpdate(path);
    } catch (err) {
      setApplying(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const downloadAndApply = useCallback(
    async (target: UpdateCheckResult) => {
      if (previewMode) {
        setError('Preview mode: in-app download runs only inside BitChord Desktop.');
        return;
      }
      if (downloadedPath) {
        await applyUpdate(downloadedPath);
        return;
      }
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
        setDownloading(false);
        await applyUpdate(path);
      } catch (err) {
        setDownloading(false);
        setApplying(false);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [previewMode, downloadedPath, applyUpdate],
  );

  const runCheck = useCallback(async () => {
    if (!desktop) return;
    try {
      const loadedPrefs = await desktopApi.updaterGetPrefs();
      setPrefs(loadedPrefs);
      if (!loadedPrefs.autoCheckUpdates) return;
      const checked = await desktopApi.checkForUpdates();
      setResult(checked);
      setDownloadedPath(checked.downloadedPath);

      const actionable =
        (checked.status === 'available' ||
          checked.status === 'downloaded' ||
          checked.status === 'mandatory') &&
        Boolean(checked.latestVersion);
      if (!actionable) return;

      const versionKey = checked.latestVersion!;
      if (
        checked.mandatory ||
        (loadedPrefs.skippedVersion !== versionKey && lastNotifiedVersionRef.current !== versionKey)
      ) {
        lastNotifiedVersionRef.current = versionKey;
        setModalOpen(true);
      }
    } catch {
      // Background check stays silent when offline.
    }
  }, [desktop, setModalOpen]);

  useEffect(() => {
    let active = true;
    const onExternalResult = (ev: Event) => {
      const detail = (ev as CustomEvent<UpdateCheckResult>).detail;
      if (!detail) return;
      setResult(detail);
      setDownloadedPath(detail.downloadedPath);
      setError(null);
      if (
        detail.status === 'available' ||
        detail.status === 'downloaded' ||
        detail.status === 'mandatory'
      ) {
        setModalOpen(true);
      }
    };
    window.addEventListener(UPDATE_RESULT_EVENT, onExternalResult);

    let unlisten: (() => void) | null = null;
    let startupTimer: number | undefined;
    let interval: number | undefined;

    if (desktop && initialResult === null && !previewMode) {
      void desktopApi
        .onUpdaterProgress((p) => {
          if (active) setProgress(p);
        })
        .then((fn) => {
          if (active) unlisten = fn;
          else fn();
        })
        .catch(() => {});

      startupTimer = window.setTimeout(() => {
        if (active) void runCheck();
      }, 1800);
      interval = window.setInterval(() => {
        if (active) void runCheck();
      }, 6 * 60 * 60 * 1000);
    }

    return () => {
      active = false;
      if (startupTimer !== undefined) window.clearTimeout(startupTimer);
      if (interval !== undefined) window.clearInterval(interval);
      window.removeEventListener(UPDATE_RESULT_EVENT, onExternalResult);
      unlisten?.();
    };
  }, [desktop, initialResult, previewMode, runCheck, setModalOpen]);

  if (!result || !isAvailable) return null;
  if (!mandatory && !modalOpen && !previewMode) return null;
  if (!mandatory && prefs?.skippedVersion === result.latestVersion && !modalOpen && !previewMode) return null;

  const pct =
    applying
      ? 100
      : progress?.phase === 'verifying'
        ? 100
        : progress?.totalBytes && progress.totalBytes > 0
          ? Math.min(100, Math.round((progress.receivedBytes / progress.totalBytes) * 100))
          : null;

  const showProgressBar = downloading || applying || Boolean(error);

  const versionLabel = result.latestVersion ?? 'latest';
  const hasNotes = Boolean(result.notes?.trim());
  const subtitle = applying
    ? `Applying BitChord ${versionLabel} and restarting...`
    : downloading
      ? progress?.phase === 'verifying'
        ? `Verifying BitChord ${versionLabel}...`
        : pct !== null
          ? `Downloading BitChord ${versionLabel} (${pct}%)...`
          : `Downloading BitChord ${versionLabel}...`
      : error
        ? `Couldn't install BitChord ${versionLabel}.`
        : mandatory
          ? `BitChord ${versionLabel} is required (${result.majorPatchLag} major patches behind).`
          : `BitChord ${versionLabel} is available to download.`;

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)+10)] flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
      role={mandatory ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby="software-update-title"
      aria-describedby="software-update-subtitle"
      data-mandatory-update={mandatory ? 'true' : undefined}
      onClick={(ev) => {
        if (ev.target === ev.currentTarget && !mandatory && !applying) {
          dismissLater();
        }
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`flex max-h-[90vh] flex-col overflow-hidden rounded-[22px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] outline-none backdrop-blur-2xl animate-zoom ${
          hasNotes ? 'w-[min(480px,92vw)]' : 'w-[min(360px,92vw)]'
        }`}
        style={{ backdropFilter: 'saturate(200%) blur(28px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="flex-1 overflow-y-auto px-6 pt-5 pb-4 text-center scrollbar-compact">
          <h2 id="software-update-title" className="text-[18px] leading-[23px] font-semibold tracking-[-0.015em] text-primary">
            Software Update
          </h2>

          <div className="mt-2.5 flex justify-center">
            <span className="inline-flex items-center gap-1.5 rounded-pill border border-(--labelDivider) bg-primary/6 px-3 py-1 font-mono text-[11.5px] font-medium text-secondary">
              <span>v{result.currentVersion}</span>
              <ArrowRight size={12} strokeWidth={2.2} className="text-secondary/80" aria-hidden="true" />
              <span className="font-semibold text-primary">v{versionLabel}</span>
            </span>
          </div>

          <p id="software-update-subtitle" className="mt-2 text-[13px] leading-[18px] text-secondary">
            {subtitle}
          </p>

          {showProgressBar && (
            <div className="mt-3" aria-live="polite">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/15">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    error ? 'bg-red' : 'bg-key'
                  } ${
                    (downloading && pct === null) || applying || progress?.phase === 'verifying'
                      ? 'animate-pulse'
                      : ''
                  }`}
                  style={{ width: `${error ? 100 : (pct ?? 35)}%` }}
                />
              </div>
              {downloading && progress && (
                <p className="mt-1.5 font-mono text-[11px] text-secondary">
                  {progress.phase === 'verifying'
                    ? 'Verifying SHA-256 checksum...'
                    : progress.totalBytes
                      ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                      : formatBytes(progress.receivedBytes)}
                </p>
              )}
            </div>
          )}

          {error && (
            <p role="alert" className="mt-2.5 text-[12.5px] leading-[17px] text-red break-words">
              {error}
            </p>
          )}

          {result.notes && (
            <div className="mt-4 text-left">
              <p className="px-0.5 text-[12px] leading-[16px] font-semibold text-secondary">
                What&apos;s new
              </p>
              <div className="mt-1.5 max-h-[min(44vh,340px)] overflow-y-auto rounded-[14px] border border-(--labelDivider) bg-primary/5 px-4 py-3.5 scrollbar-compact">
                <ReleaseNotesMarkdown notes={result.notes} />
              </div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-(--labelDivider)">
          {applying ? (
            <div className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-medium text-secondary">
              Installing Update...
            </div>
          ) : downloading ? (
            mandatory ? (
              <div className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-medium text-secondary">
                Downloading Update...
              </div>
            ) : (
              <button
                type="button"
                onClick={dismissLater}
                className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-normal text-primary/90 transition-colors hover:bg-primary/6"
              >
                Hide &amp; Continue in Background
              </button>
            )
          ) : error ? (
            <>
              {result.installerUrl && (
                <button
                  type="button"
                  onClick={() => void downloadAndApply(result)}
                  className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-semibold text-primary transition-colors hover:bg-primary/6"
                >
                  Try Again
                </button>
              )}
              {result.releaseUrl && (
                <a
                  href={result.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-[48px] w-full items-center justify-center border-t border-(--labelDivider) text-[15px] font-normal text-primary/90 transition-colors hover:bg-primary/6"
                >
                  Open Releases Page
                </a>
              )}
              <button
                type="button"
                onClick={mandatory ? () => void desktopApi.exitApp() : dismissLater}
                className="flex min-h-[48px] w-full items-center justify-center border-t border-(--labelDivider) text-[15px] font-normal text-secondary transition-colors hover:bg-primary/6 hover:text-primary"
              >
                {mandatory ? 'Exit BitChord' : 'Remind Me Later'}
              </button>
            </>
          ) : (
            <>
              {result.installerUrl || downloadedPath ? (
                <button
                  type="button"
                  onClick={() => void downloadAndApply(result)}
                  className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-semibold text-key transition-colors hover:bg-primary/6"
                >
                  {downloadedPath ? 'Update & Restart Now' : 'Download Now'}
                </button>
              ) : result.releaseUrl ? (
                <a
                  href={result.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-[48px] w-full items-center justify-center text-[15px] font-semibold text-key transition-colors hover:bg-primary/6"
                >
                  Open Releases Page
                </a>
              ) : null}

              <button
                type="button"
                onClick={mandatory ? () => void desktopApi.exitApp() : dismissLater}
                className={`flex min-h-[48px] w-full items-center justify-center border-t border-(--labelDivider) text-[15px] font-normal transition-colors hover:bg-primary/6 ${
                  mandatory ? 'text-red' : 'text-secondary hover:text-primary'
                }`}
              >
                {mandatory ? 'Exit BitChord' : 'Remind Me Later'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
