import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet } from 'react-router';
import { PrefetchLink } from '@/components/PrefetchLink';
import { config } from '@/config';
import { isTauriDesktop } from '@/desktop/tauriBridge';
import { useDesktopIntegrations } from '@/desktop/useDesktopIntegrations';
import { useExtension } from '@/extension/useExtension';
import { isMobileBrowser } from '@/lib/platform';
import { resumeSession } from '@/party/listenTogether';
import { startPartySync } from '@/party/partySync';
import { useDiscordPresence } from '@/playback/discordPresence';
import { startHistoryReporting } from '@/playback/historyReporting';
import { startLivePresence } from '@/playback/livePresence';
import { useUi } from '@/state/ui';
import { AudioOutputModal } from './AudioOutputModal';
import { AudioPipelineDialog } from './AudioPipelineDialog';
import { Banner, bannerButtonClass } from './Banner';
import { MobileBottomChrome } from './MobileBottomChrome';
import { MobileTopBar } from './MobileTopBar';
import { PlayerBar } from './PlayerBar';
import { Sidebar } from './Sidebar';
import { SidePanel } from './SidePanel';
import { TitleBar } from './TitleBar';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mobile = isMobileBrowser();
const desktop = isTauriDesktop();
const FullScreenPlayer = lazy(() => import('./FullScreenPlayer').then((m) => ({ default: m.FullScreenPlayer })));

export function AppShell() {
  useKeyboardShortcuts();
  useDiscordPresence();
  useDesktopIntegrations();
  useEffect(() => {
    resumeSession();
    return startPartySync();
  }, []);
  useEffect(() => startHistoryReporting(), []);
  // Only report live presence when running against an explicitly configured self-hosted server.
  useEffect(() => {
    if (desktop) return;
    return startLivePresence();
  }, []);

  const extension = useExtension();
  const bannerDismissed = useUi((s) => s.installBannerDismissed);
  const dismissBanner = useUi((s) => s.dismissInstallBanner);
  const fullScreen = useUi((s) => s.fullScreen);
  const [fullScreenMounted, setFullScreenMounted] = useState(fullScreen);
  useEffect(() => {
    if (fullScreen) setFullScreenMounted(true);
  }, [fullScreen]);
  const handleFullScreenExited = useCallback(() => {
    if (!useUi.getState().fullScreen) setFullScreenMounted(false);
  }, []);

  let banner = null;
  if (!desktop && mobile) {
    banner = (
      <Banner
        title="BitChord is better in the app."
        detail="Phone browsers cannot run the BitChord extension. The Android app has everything."
        action={
          <a className={bannerButtonClass} href={config.androidAppUrl} target="_blank" rel="noreferrer">
            Get the App
          </a>
        }
      />
    );
  } else if (!desktop && extension.state === 'missing' && !bannerDismissed) {
    banner = (
      <Banner
        title="Play YouTube Music with the BitChord extension."
        detail="Playback, YouTube Music sign-in, Spotify and Discord need the extension. Addons and lyrics work without it."
        action={
          <PrefetchLink className={bannerButtonClass} to="/extension">
            Get the Extension
          </PrefetchLink>
        }
        onDismiss={dismissBanner}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <TitleBar />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <MobileTopBar />
        <main
          id="scrollable-page"
          className="absolute inset-0 overflow-x-hidden overflow-y-auto pl-(--web-navigation-width) [scrollbar-gutter:stable] data-tint:bg-(--page-tint) data-tint:transition-[background-color] data-tint:duration-300 data-tint:ease-in max-sm:pt-(--mobile-top-bar-height) max-sm:pl-0"
        >
          <div className="min-h-full pb-[calc(var(--player-pill-height)+var(--player-bottom-offset)+40px)] max-sm:pb-[156px]">
            <Outlet />
          </div>
        </main>
        <PlayerBar />
        <MobileBottomChrome />
        <SidePanel />
      </div>
      {banner}
      {fullScreenMounted && (
        <Suspense fallback={null}>
          <FullScreenPlayer exiting={!fullScreen} onExited={handleFullScreenExited} />
        </Suspense>
      )}
      <AudioOutputModal />
      <AudioPipelineDialog />
    </div>
  );
}
