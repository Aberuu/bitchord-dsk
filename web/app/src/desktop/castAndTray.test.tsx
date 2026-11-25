// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAST_SESSION, useCast } from '@/desktop/castStore';
import { desktopApi } from '@/desktop/tauriBridge';
import AppearanceSettingsPage from '@/pages/AppearanceSettingsPage';
import SettingsPage from '@/pages/SettingsPage';
import { CastModal } from '@/shell/CastModal';
import { usePlayer } from '@/state/player';
import { useUi } from '@/state/ui';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('System Tray default OFF preference and Cast to TV modal', () => {
  let host: HTMLDivElement;
  let root: Root;
  let qc: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    Object.assign(window, { __TAURI_INTERNALS__: {} });

    useUi.setState({
      minimizeToTray: false,
      castModalOpen: false,
      audioOutputOpen: false,
    });
    useCast.setState({
      support: {
        supported: true,
        reason: null,
        localIp: '192.168.1.25',
        adapterName: 'Wi-Fi',
        protocols: ['chromecast', 'dlna'],
      },
      session: DEFAULT_CAST_SESSION,
      devices: [],
      scanning: false,
      error: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
    usePlayer.setState({ nowPlaying: null, queue: [], index: -1, status: 'idle' });
    useUi.setState({ minimizeToTray: false, castModalOpen: false });
  });

  it('defaults minimizeToTray to false and syncs toggle between Settings and Appearance', () => {
    const spy = vi.spyOn(desktopApi, 'setMinimizeToTray').mockResolvedValue(true);

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/settings']}>
            <SettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const checkboxes = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    const traySwitch = checkboxes.find((input) =>
      input.closest('label')?.textContent?.includes('Minimize to System Tray on Close'),
    )!;
    expect(traySwitch).toBeTruthy();
    expect(traySwitch.checked).toBe(false);

    act(() => {
      traySwitch.click();
    });
    expect(useUi.getState().minimizeToTray).toBe(true);
    expect(localStorage.getItem('bitchord:minimize-to-tray')).toBe('1');
    expect(spy).toHaveBeenCalledWith(true);

    act(() => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/settings/appearance']}>
            <AppearanceSettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const appTraySwitch = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((input) =>
      input.closest('label')?.textContent?.includes('Minimize to System Tray on Close'),
    )!;
    expect(appTraySwitch).toBeTruthy();
    expect(appTraySwitch.checked).toBe(true);
  });

  it('discovers receivers in CastModal, casts active local track, and disconnects cleanly', async () => {
    const tv = {
      id: 'dlna:uuid-tv-1',
      name: 'Living Room Smart TV',
      model: 'LG OLED',
      manufacturer: 'LG',
      protocol: 'dlna' as const,
      host: '192.168.1.90',
      port: 1920,
      avTransportUrl: 'http://192.168.1.90:1920/AVTransport/control',
      renderingControlUrl: null,
    };

    const discoverSpy = vi.spyOn(desktopApi, 'castDiscover').mockResolvedValue([tv]);
    const loadSpy = vi.spyOn(desktopApi, 'castLoadMedia').mockResolvedValue({
      connected: true,
      connecting: false,
      device: tv,
      trackId: 'local:test123',
      status: 'playing',
      positionSec: 0,
      durationSec: 180,
      volume: 1,
      muted: false,
      error: null,
    });
    const disconnectSpy = vi.spyOn(desktopApi, 'castDisconnect').mockResolvedValue(undefined);
    vi.spyOn(desktopApi, 'audioStop').mockResolvedValue(undefined);

    usePlayer.setState({
      nowPlaying: {
        videoId: 'local:test123',
        title: 'Midnight Track',
        artist: 'Test Artist',
        artworkUrl: null,
        durationSec: 180,
        streamInfo: 'FLAC',
        stream: null,
      },
      queue: [
        {
          entryId: 'e1',
          tier: 'user',
          source: { title: 'Local', type: 'other' },
          track: {
            videoId: 'local:test123',
            title: 'Midnight Track',
            artists: [{ name: 'Test Artist', id: null }],
            album: null,
            durationSec: 180,
            explicit: false,
            thumbnail: null,
            index: null,
            plays: null,
          },
        },
      ],
      index: 0,
      status: 'playing',
    });

    useUi.setState({ castModalOpen: true });

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/home']}>
            <CastModal />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    expect(discoverSpy).toHaveBeenCalledTimes(1);
    const deviceBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Living Room Smart TV'),
    )!;
    expect(deviceBtn).toBeTruthy();

    await act(async () => {
      deviceBtn.click();
      await Promise.resolve();
    });

    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(useCast.getState().session.connected).toBe(true);
    expect(useUi.getState().castModalOpen).toBe(false);

    // Reopen CastModal while connected and stop casting.
    await act(async () => {
      useUi.setState({ castModalOpen: true });
      await Promise.resolve();
    });
    const stopBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Stop Casting & Play Here'),
    )!;
    expect(stopBtn).toBeTruthy();

    await act(async () => {
      stopBtn.click();
      await Promise.resolve();
    });

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(useCast.getState().session.connected).toBe(false);
  });

  it('launches Windows Cast (Win + K) and Cast Settings buttons directly from CastModal and opens from PlayerBar', async () => {
    const winCastSpy = vi.spyOn(desktopApi, 'castOpenWindowsCast').mockResolvedValue(undefined);
    const winSettingsSpy = vi.spyOn(desktopApi, 'castOpenWindowsCastSettings').mockResolvedValue(undefined);
    vi.spyOn(desktopApi, 'castDiscover').mockResolvedValue([]);

    useCast.setState({
      support: {
        supported: true,
        reason: null,
        localIp: null,
        adapterName: null,
        protocols: ['miracast'],
      },
      session: DEFAULT_CAST_SESSION,
      devices: [],
      scanning: false,
      error: null,
    });

    const { PlayerBar } = await import('@/shell/PlayerBar');

    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={['/home']}>
            <PlayerBar />
            <CastModal />
          </MemoryRouter>
        </QueryClientProvider>,
      );
      await Promise.resolve();
    });

    const barCastBtn = host.querySelector('button[aria-label="Cast to TV"]') as HTMLButtonElement;
    expect(barCastBtn).toBeTruthy();

    await act(async () => {
      barCastBtn.click();
      await Promise.resolve();
    });

    expect(useUi.getState().castModalOpen).toBe(true);

    const winCastBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Open Windows Cast (Win + K)'),
    )!;
    const settingsBtn = [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('Cast Settings'),
    )!;
    expect(winCastBtn).toBeTruthy();
    expect(settingsBtn).toBeTruthy();

    await act(async () => {
      winCastBtn.click();
      settingsBtn.click();
      await Promise.resolve();
    });

    expect(winCastSpy).toHaveBeenCalledTimes(1);
    expect(winSettingsSpy).toHaveBeenCalledTimes(1);
  });
});
