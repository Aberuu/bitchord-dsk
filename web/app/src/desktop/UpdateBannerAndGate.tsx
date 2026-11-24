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

  const [result, setResult] = useState<UpdateCheckResult | null>(initialResult);
  const [prefs, setPrefs] = useState<UpdaterPrefs | null>(initialPrefs);
  const [downloading, setDownloading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState<UpdateDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(
    initialResult?.downloadedPath ?? null,
  );
  const lastNotifiedVersionRef = useRef<string | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement>(null);

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
    useUi.getState().setMandatoryUpdateLocked(mandatory);
    return () => {
      useUi.getState().setMandatoryUpdateLocked(false);
    };
  }, [mandatory]);

  useEffect(() => {
    setHasPendingUpdate(isAvailable);
  }, [isAvailable, setHasPendingUpdate]);

  useEffect(() => {
    if (!modalOpen && !mandatory) return;
    primaryActionRef.current?.focus({ preventScroll: true });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      ev.stopPropagation();
      if (!mandatory && !applying) {
        setModalOpen(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [modalOpen, mandatory, applying, setModalOpen]);

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
    [downloadedPath, applyUpdate],
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

    if (import.meta.env.DEV && window.location.hash === '#preview-software-update') {
      setResult({
        status: 'available',
        currentVersion: '1.0.0',
        latestVersion: '1.10.0',
        majorPatchLag: 2,
        maxMajorPatchLag: 3,
        mandatory: false,
        releaseUrl: 'https://github.com/Aberuu/bitchord-dsk/releases',
        installerUrl: 'https://github.com/Aberuu/bitchord-dsk/releases/download/v1.10.0/BitChord-win-x64.exe',
        installerSha256: null,
        installerFileName: 'BitChord-win-x64.exe',
        downloadedPath: null,
        notes: [
          '## Top Features',
          '- **In-App Patch Updates**: download, verify SHA-256, apply silently, and restart automatically inside BitChord.',
          '- **Mobile Sync Hub**: host a local Wi-Fi Listen Together server and merge Replay stats without overwriting PC history.',
          '- **Expanded Shortcuts**: press **F** for Fullscreen, **M** to Mute, or **?** for the full cheatsheet.',
        ].join('\n'),
      });
      setModalOpen(true);
    }

    let unlisten: (() => void) | null = null;
    let startupTimer: number | undefined;
    let interval: number | undefined;

    if (desktop && initialResult === null) {
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
  }, [desktop, initialResult, runCheck, setModalOpen]);

  if (!result || !isAvailable) return null;
  if (!mandatory && !modalOpen) return null;
  if (!mandatory && prefs?.skippedVersion === result.latestVersion && !modalOpen) return null;

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

  const dismissLater = () => {
    if (mandatory || applying) return;
    setModalOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-[calc(var(--z-modal)+10)] flex items-center justify-center bg-black/35 p-4"
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
        className="w-[min(340px,92vw)] overflow-hidden rounded-[14px] border border-(--labelDivider) bg-(--systemStandardThickMaterialSover) text-primary shadow-[0_24px_64px_rgba(0,0,0,0.48)] backdrop-blur-2xl animate-zoom"
        style={{ backdropFilter: 'saturate(200%) blur(26px)' }}
        onClick={(ev) => ev.stopPropagation()}
      >
        <div className="px-4 pt-5 pb-4 text-center">
          <h2 id="software-update-title" className="text-[17px] leading-[22px] font-semibold tracking-[-0.015em] text-primary">
            Software Update
          </h2>
          <p id="software-update-subtitle" className="mt-1 text-[13px] leading-[17px] text-primary/90">
            {subtitle}
          </p>

          {showProgressBar && (
            <div className="mt-3" aria-live="polite">
              <div className="h-1 w-full overflow-hidden rounded-full bg-primary/15">
                <div
                  className={`h-full rounded-full transition-[width] duration-150 ${
                    error
                      ? 'bg-red'
                      : 'bg-key'
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
            <p role="alert" className="mt-2 text-[12px] leading-[16px] text-red break-words">
              {error}
            </p>
          )}

          {result.notes && (
            <>
              <div className="mt-3.5 h-px w-full bg-(--labelDivider)" />
              <div className="mt-3 text-left">
                <p className="text-[12px] leading-[16px] font-semibold text-secondary">
                  What&apos;s new
                </p>
                <div className="mt-1.5 max-h-[240px] overflow-y-auto pr-1">
                  <ReleaseNotesMarkdown notes={result.notes} />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="border-t border-(--labelDivider)">
          {applying ? (
            <div className="flex h-11 w-full items-center justify-center text-[16px] font-medium text-secondary">
              Installing Update...
            </div>
          ) : downloading ? (
            mandatory ? (
              <div className="flex h-11 w-full items-center justify-center text-[16px] font-medium text-secondary">
                Downloading Update...
              </div>
            ) : (
              <button
                type="button"
                onClick={dismissLater}
                className="flex h-11 w-full items-center justify-center text-[16px] font-normal text-primary/90 transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
              >
                Hide &amp; Continue in Background
              </button>
            )
          ) : error ? (
            <>
              {result.installerUrl && (
                <button
                  ref={primaryActionRef}
                  type="button"
                  onClick={() => void downloadAndApply(result)}
                  className="flex h-11 w-full items-center justify-center text-[16px] font-semibold text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
                >
                  Try Again
                </button>
              )}
              {result.releaseUrl && (
                <a
                  href={result.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-11 w-full items-center justify-center border-t border-(--labelDivider) text-[16px] font-normal text-primary/90 transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
                >
                  Open Releases Page
                </a>
              )}
              <button
                type="button"
                onClick={mandatory ? () => void desktopApi.exitApp() : dismissLater}
                className="flex h-11 w-full items-center justify-center border-t border-(--labelDivider) text-[16px] font-normal text-secondary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
              >
                {mandatory ? 'Exit BitChord' : 'Remind Me Later'}
              </button>
            </>
          ) : (
            <>
              {result.installerUrl || downloadedPath ? (
                <button
                  ref={primaryActionRef}
                  type="button"
                  onClick={() => void downloadAndApply(result)}
                  className="flex h-11 w-full items-center justify-center text-[16px] font-semibold text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
                >
                  {downloadedPath ? 'Update & Restart Now' : 'Download Now'}
                </button>
              ) : result.releaseUrl ? (
                <a
                  href={result.releaseUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-11 w-full items-center justify-center text-[16px] font-semibold text-primary transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key"
                >
                  Open Releases Page
                </a>
              ) : null}

              <button
                type="button"
                onClick={mandatory ? () => void desktopApi.exitApp() : dismissLater}
                className={`flex h-11 w-full items-center justify-center border-t border-(--labelDivider) text-[16px] font-normal transition-colors hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-key ${
                  mandatory ? 'text-red' : 'text-primary/90'
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
