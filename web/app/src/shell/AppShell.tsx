import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router';
import { PrefetchLink } from '@/components/PrefetchLink';
import { config } from '@/config';
import { isTauriDesktop } from '@/desktop/tauriBridge';
import { UpdateBannerAndGate } from '@/desktop/UpdateBannerAndGate';
import { useDesktopIntegrations } from '@/desktop/useDesktopIntegrations';
import { useExtension } from '@/extension/useExtension';
import { isMobileBrowser } from '@/lib/platform';
import { resumeSession } from '@/party/listenTogether';
import { startPartySync } from '@/party/partySync';
import { useDiscordPresence } from '@/playback/discordPresence';
import { startHistoryReporting } from '@/playback/historyReporting';
import { startLivePresence } from '@/playback/livePresence';
import { useSources } from '@/state/sources';
import { useUi } from '@/state/ui';
import { AudioOutputModal } from './AudioOutputModal';
import { AudioPipelineDialog } from './AudioPipelineDialog';
import { Banner, bannerButtonClass } from './Banner';
import { CastModal } from './CastModal';
import { MobileBottomChrome } from './MobileBottomChrome';
import { MobileTopBar } from './MobileTopBar';
import { PlayerBar } from './PlayerBar';
import { ShortcutsModal } from './ShortcutsModal';
import { Sidebar } from './Sidebar';
import { SidebarToggleButton } from './SidebarToggleButton';
import { QuickSignInModal } from '@/desktop/QuickSignInModal';
import { SidePanel } from './SidePanel';
import { TitleBar } from './TitleBar';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mobile = isMobileBrowser();
const desktop = isTauriDesktop();
const FullScreenPlayer = lazy(() => import('./FullScreenPlayer').then((m) => ({ default: m.FullScreenPlayer })));

export const LAST_ROUTE_KEY = 'bitchord:last-route';

function isRestorableRoute(pathname: string): boolean {
  if (!pathname || pathname === '/') return false;
  if (pathname.startsWith('/invite')) return false;
  if (pathname.startsWith('/extension')) return false;
  return true;
}

export function AppShell() {
  useKeyboardShortcuts();
  useDiscordPresence();
  useDesktopIntegrations();
  const location = useLocation();
  useEffect(() => {
    if (!isRestorableRoute(location.pathname)) return;
    try {
      localStorage.setItem(LAST_ROUTE_KEY, `${location.pathname}${location.search}`);
    } catch {
      // Ignore storage errors.
    }
  }, [location.pathname, location.search]);
  useEffect(() => {
    if (desktop) {
      void useSources.getState().loadFromBackend().catch(() => {});
    }
  }, []);
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
  const sidebarCompact = useUi((s) => s.sidebarCompact);
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
    <div className="relative isolate flex h-full flex-col">
      <div
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        data-sidebar-compact={sidebarCompact || undefined}
      >
        {/* Continuous backdrop spans y=0..100% behind TitleBar and main to avoid a subpixel DPI seam over transparent Mica. */}
        <div
          aria-hidden="true"
          data-page-backdrop="true"
          className="pointer-events-none absolute inset-y-0 right-0 left-(--web-navigation-width) -z-1 bg-(--scrollablePageBG) sm:transition-[left] sm:duration-(--duration-panel) sm:ease-panel max-sm:left-0"
        />
        {desktop && <div className="h-9 flex-none" aria-hidden="true" />}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <MobileTopBar />
          <main
            id="scrollable-page"
            className="absolute inset-0 overflow-x-hidden overflow-y-auto pl-(--web-navigation-width) [scrollbar-gutter:stable] data-tint:bg-(--page-tint) data-tint:transition-[background-color] data-tint:duration-300 data-tint:ease-in sm:transition-[padding-left] sm:duration-(--duration-panel) sm:ease-panel max-sm:pt-(--mobile-top-bar-height) max-sm:pl-0"
          >
            <div className="min-h-full pb-[calc(var(--player-pill-height)+var(--player-bottom-offset)+40px)] max-sm:pb-[156px]">
              <Outlet />
            </div>
          </main>
          <PlayerBar />
          <MobileBottomChrome />
          <SidePanel />
        </div>
        <Sidebar />
        {!desktop && (
          <div className="pointer-events-none absolute top-0 left-0 z-[calc(var(--z-web-chrome)+1)] hidden h-11 w-(--web-navigation-compact-width) items-center justify-center sm:flex">
            <SidebarToggleButton className="pointer-events-auto grid size-9 place-items-center rounded-nav text-secondary transition-colors hover:bg-quinary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-key" />
          </div>
        )}
        <TitleBar />
      </div>
      {banner}
      {fullScreenMounted && (
        <Suspense fallback={null}>
          <FullScreenPlayer exiting={!fullScreen} onExited={handleFullScreenExited} />
        </Suspense>
      )}
      <AudioOutputModal />
      <AudioPipelineDialog />
      <CastModal />
      <ShortcutsModal />
      <QuickSignInModal />
      <UpdateBannerAndGate />
    </div>
  );
}
