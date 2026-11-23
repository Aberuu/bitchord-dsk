import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { DeveloperWatermark } from '@/components/DeveloperWatermark';
import { Select } from '@/components/Select';
import { SubpageHeader } from '@/components/SubpageHeader';
import { desktopApi, isTauriDesktop } from '@/desktop/tauriBridge';
import { usePlayer } from '@/state/player';
import { useUi, type ThemePreference } from '@/state/ui';
import { Toggle } from './IntegrationSettings';
import { settingsUi } from './settingsStyles';

export default function AppearanceSettingsPage() {
  const desktop = isTauriDesktop();
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const minimizeToTray = useUi((s) => s.minimizeToTray);
  const setMinimizeToTray = useUi((s) => s.setMinimizeToTray);
  const showNerdStats = usePlayer((s) => s.showNerdStats);
  const setShowNerdStats = usePlayer((s) => s.setShowNerdStats);
  const updateCheck = useMutation({ mutationFn: () => desktopApi.checkForUpdates() });

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
                detail="Keep music playing in the background when you close the main window."
                checked={minimizeToTray}
                onChange={setMinimizeToTray}
              />
              <div className={settingsUi.row}>
                <span className={settingsUi.rowText}>
                  <span>App Updates</span>
                  <span className={settingsUi.rowDetail}>
                    {updateCheck.data?.notes ?? 'Check for stream-resolver and desktop fixes.'}
                  </span>
                </span>
                <button
                  type="button"
                  className={settingsUi.inlineButton}
                  disabled={updateCheck.isPending}
                  onClick={() => updateCheck.mutate()}
                >
                  <span className="inline-flex items-center gap-1">
                    <RefreshCw size={12} className={updateCheck.isPending ? 'animate-spin' : undefined} aria-hidden="true" />
                    {updateCheck.isPending ? 'Checking…' : 'Check Now'}
                  </span>
                </button>
              </div>
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
