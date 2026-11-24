import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DeveloperWatermark } from '@/components/DeveloperWatermark';
import { Select } from '@/components/Select';
import { SubpageHeader } from '@/components/SubpageHeader';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { publishUpdateResult } from '@/desktop/UpdateBannerAndGate';
import { usePlayer } from '@/state/player';
import { useUi, type ThemePreference } from '@/state/ui';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

export default function AppearanceSettingsPage() {
  const desktop = isTauriDesktop();
  const queryClient = useQueryClient();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const minimizeToTray = useUi((s) => s.minimizeToTray);
  const setMinimizeToTray = useUi((s) => s.setMinimizeToTray);
  const showNerdStats = usePlayer((s) => s.showNerdStats);
  const setShowNerdStats = usePlayer((s) => s.setShowNerdStats);

  const updaterPrefs = useQuery({
    queryKey: ['desktop', 'updater-prefs'],
    queryFn: () => desktopApi.updaterGetPrefs(),
    enabled: desktop,
  });

  const [feedDraft, setFeedDraft] = useState('');
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);

  useEffect(() => {
    if (updaterPrefs.data) {
      setFeedDraft(updaterPrefs.data.updateFeedUrl ?? '');
    }
  }, [updaterPrefs.data]);

  const saveUpdaterPrefs = useMutation({
    mutationFn: (patch: Parameters<typeof desktopApi.updaterSetPrefs>[0]) =>
      desktopApi.updaterSetPrefs(patch),
    onSuccess: (next) => {
      queryClient.setQueryData(['desktop', 'updater-prefs'], next);
    },
  });

  const updateCheck = useMutation({
    mutationFn: () => desktopApi.checkForUpdates(),
    onSuccess: (res) => {
      setDownloadedPath(res.downloadedPath);
      setDownloadError(null);
      publishUpdateResult(res);
    },
  });

  const downloadMut = useMutation({
    mutationFn: async () => {
      const res = updateCheck.data;
      if (!res?.installerUrl) throw new Error('No Windows installer asset attached to this release.');
      return desktopApi.downloadUpdate(res.installerUrl, res.installerFileName, res.installerSha256);
    },
    onSuccess: (path) => {
      setDownloadedPath(path);
      setDownloadError(null);
    },
    onError: (err) => {
      setDownloadError(err instanceof Error ? err.message : String(err));
    },
  });

  const installMut = useMutation({
    mutationFn: async () => {
      const path = downloadedPath ?? updateCheck.data?.downloadedPath;
      if (!path) throw new Error('Update package has not been downloaded yet.');
      await desktopApi.installUpdate(path);
    },
    onError: (err) => {
      setDownloadError(err instanceof Error ? err.message : String(err));
    },
  });

  const checkData = updateCheck.data;
  const activeDownloadedPath = downloadedPath ?? checkData?.downloadedPath ?? null;

  return (
    <div className={settingsUi.centered}>
      <SubpageHeader title="Appearance" backTo="/settings" />
      <div className={settingsUi.body}>
        <h2 className={settingsUi.sectionHeader}>Theme &amp; Display</h2>
        <section className={settingsUi.group}>
          <label className={settingsUi.controlRow}>
            <span>Appearance</span>
            <Select<ThemePreference>
              label="Appearance"
              value={theme}
              options={[
                { value: 'system', label: 'Match Windows' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={setTheme}
            />
          </label>
          <Toggle
            label="Show Stats for Nerds"
            detail="Codec, bitrate, sample rate, and bit-perfect status under the artist in Now Playing."
            checked={showNerdStats}
            onChange={setShowNerdStats}
          />
        </section>

        {desktop && (
          <>
            <h2 className={settingsUi.sectionHeader}>Desktop Window &amp; Updates</h2>
            <section className={settingsUi.group}>
              <Toggle
                label="Minimize to System Tray on Close"
                detail="Keep music playing in the background instead of exiting when closing the window."
                checked={minimizeToTray}
                onChange={setMinimizeToTray}
              />
              <Toggle
                label="Automatic Update Checks"
                detail="Check for new patches on startup. Installations more than 3 major patches behind must update."
                checked={updaterPrefs.data?.autoCheckUpdates ?? true}
                onChange={(checked) => saveUpdaterPrefs.mutate({ autoCheckUpdates: checked })}
              />
              <Toggle
                label="Auto-Download Background Patches"
                detail="Download verified installers quietly when 1 to 3 major patches behind."
                checked={updaterPrefs.data?.autoDownloadUpdates ?? true}
                onChange={(checked) => saveUpdaterPrefs.mutate({ autoDownloadUpdates: checked })}
              />
              <div className={settingsUi.row}>
                <span className={settingsUi.rowText}>
                  <span className="flex flex-wrap items-center gap-2">
                    <span>App Updates</span>
                    {checkData && (
                      <span
                        className={`rounded-[6px] px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.04em] uppercase ${
                          checkData.mandatory
                            ? 'bg-key/15 text-key'
                            : 'bg-quaternary text-secondary'
                        }`}
                      >
                        {checkData.majorPatchLag}/{checkData.maxMajorPatchLag} major patches
                      </span>
                    )}
                  </span>
                  <span className={settingsUi.rowDetail}>
                    {downloadError
                      ? downloadError
                      : checkData?.latestVersion && checkData.status !== 'up_to_date'
                        ? `v${checkData.currentVersion} -> v${checkData.latestVersion}${
                            checkData.mandatory ? ' (Mandatory update required)' : ''
                          }`
                        : (checkData?.notes ?? 'Check Aberuu/bitchord-dsk releases for desktop fixes.')}
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  {checkData &&
                    checkData.status !== 'up_to_date' &&
                    (activeDownloadedPath ? (
                      <button
                        type="button"
                        className="rounded-pill bg-key px-3 py-1 type-callout-emphasized text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        disabled={installMut.isPending}
                        onClick={() => installMut.mutate()}
                      >
                        {installMut.isPending ? 'Launching...' : 'Install Update'}
                      </button>
                    ) : checkData.installerUrl ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-pill bg-key px-3 py-1 type-callout-emphasized text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        disabled={downloadMut.isPending}
                        onClick={() => downloadMut.mutate()}
                      >
                        <Download size={12} aria-hidden="true" />
                        {downloadMut.isPending ? 'Downloading...' : 'Download'}
                      </button>
                    ) : checkData.releaseUrl ? (
                      <a
                        href={checkData.releaseUrl}
                        target="_blank"
                        rel="noreferrer"
                        className={settingsUi.inlineButton}
                      >
                        <span className="inline-flex items-center gap-1">
                          <ExternalLink size={12} aria-hidden="true" />
                          Release
                        </span>
                      </a>
                    ) : null)}
                  <button
                    type="button"
                    className={settingsUi.inlineButton}
                    disabled={updateCheck.isPending}
                    onClick={() => updateCheck.mutate()}
                  >
                    <span className="inline-flex items-center gap-1">
                      <RefreshCw
                        size={12}
                        className={updateCheck.isPending ? 'animate-spin' : undefined}
                        aria-hidden="true"
                      />
                      {updateCheck.isPending ? 'Checking...' : 'Check Now'}
                    </span>
                  </button>
                </div>
              </div>
              <form
                className={settingsUi.row}
                onSubmit={(e) => {
                  e.preventDefault();
                  saveUpdaterPrefs.mutate({ updateFeedUrl: feedDraft.trim() });
                }}
              >
                <span className={settingsUi.rowText}>
                  <span>Custom Update Feed URL</span>
                  <span className={settingsUi.rowDetail}>
                    Optional JSON mirror or local test manifest. Leave blank for GitHub Releases.
                  </span>
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <input
                    type="url"
                    value={feedDraft}
                    onChange={(e) => setFeedDraft(e.currentTarget.value)}
                    placeholder="Default (GitHub)"
                    aria-label="Custom update feed URL"
                    className={settingsUi.input}
                  />
                  <button
                    type="submit"
                    disabled={saveUpdaterPrefs.isPending}
                    className={settingsUi.inlineButton}
                  >
                    Save
                  </button>
                </div>
              </form>
            </section>
          </>
        )}

        <h2 className={settingsUi.sectionHeader}>About</h2>
        <section className={settingsUi.group} aria-label="Developer attribution">
          <DeveloperWatermark variant="rows" />
        </section>
      </div>
    </div>
  );
}
