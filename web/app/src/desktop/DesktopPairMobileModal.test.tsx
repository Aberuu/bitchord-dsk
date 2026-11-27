// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  desktopApi,
  type DesktopPairingOfferView,
  type PairedMobileRecord,
} from '@/desktop/tauriBridge';
import { extensionQueryKey } from '@/extension/useExtension';
import { spotifyAuthQueryKey } from '@/extension/useSpotifyAuth';
import { ytAuthQueryKey } from '@/extension/useYtAuth';
import { queryClient } from '@/lib/queryClient';
import { useUi } from '@/state/ui';
import { DesktopPairMobileModal } from './DesktopPairMobileModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeOffer(includeSpotify = false): DesktopPairingOfferView {
  return {
    active: true,
    offerId: 'offer-abc-123',
    code: '7K4-9MP',
    qrUri:
      'bitchord://pair?v=1&h=192.168.1.42&p=48221&id=offer-abc-123&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&c=7K49MP',
    lanIp: '192.168.1.42',
    port: 48221,
    desktopName: 'Studio PC',
    includeSpotify,
    expiresAtMs: Date.now() + 180_000,
  };
}

function seedSignedIn(): void {
  queryClient.setQueryData(extensionQueryKey, {
    info: { capabilities: ['yt.auth'] },
    bridge: { call: vi.fn(), subscribe: () => () => {} },
  });
  queryClient.setQueryData(ytAuthQueryKey, {
    browserSignedIn: true,
    connected: true,
    signedIn: true,
    accounts: [],
    active: {
      id: 'ch-1',
      name: 'Abel',
      handle: '@abel',
      avatarUrl: null,
      brand: false,
      authUser: '0',
    },
    problem: null,
  });
  queryClient.setQueryData(spotifyAuthQueryKey, {
    browserSignedIn: false,
    connected: false,
    signedIn: false,
    user: null,
    problem: null,
  });
}

describe('DesktopPairMobileModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient.clear();
    seedSignedIn();
    useUi.setState({ pairMobileOpen: true });
    vi.spyOn(desktopApi, 'pairingStopDesktopQr').mockResolvedValue({
      offer: {
        active: false,
        offerId: null,
        code: null,
        qrUri: null,
        lanIp: null,
        port: null,
        desktopName: null,
        includeSpotify: false,
        expiresAtMs: null,
      },
      pairedDevices: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    queryClient.clear();
    useUi.setState({ pairMobileOpen: false });
    vi.restoreAllMocks();
  });

  it('renders QR code SVG, 6-char code, LAN host, and hides Spotify option when Spotify is signed out', async () => {
    vi.spyOn(desktopApi, 'onMobilePaired').mockResolvedValue(() => {});

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DesktopPairMobileModal forceDesktop initialOffer={makeOffer(false)} initialSpotifySignedIn={false} />
        </QueryClientProvider>,
      );
    });

    const dialog = host.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Pair Mobile Device');
    expect(dialog?.textContent).toContain('7K4-9MP');
    expect(dialog?.textContent).toContain('192.168.1.42:48221');
    expect(host.querySelector('svg[role="img"]')).not.toBeNull();
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('includes Spotify toggle when signed into Spotify and regenerates offer when toggled', async () => {
    vi.spyOn(desktopApi, 'onMobilePaired').mockResolvedValue(() => {});
    const startSpy = vi
      .spyOn(desktopApi, 'pairingStartDesktopQr')
      .mockResolvedValue(makeOffer(true));

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <DesktopPairMobileModal forceDesktop initialOffer={makeOffer(false)} initialSpotifySignedIn />
        </QueryClientProvider>,
      );
    });

    const checkbox = host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      checkbox.click();
    });

    expect(startSpy).toHaveBeenCalledWith(true);
  });

  it('transitions to success view when pairing://mobile-paired fires and closes on Escape', async () => {
    let pairedCb: ((rec: PairedMobileRecord) => void) | undefined;
    vi.spyOn(desktopApi, 'onMobilePaired').mockImplementation(async (cb) => {
      pairedCb = cb;
      return () => {};
    });

    // Simulate realDesktop path via __TAURI_INTERNALS__
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    const startSpy = vi
      .spyOn(desktopApi, 'pairingStartDesktopQr')
      .mockResolvedValue(makeOffer(false));

    try {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <DesktopPairMobileModal />
          </QueryClientProvider>,
        );
      });

      expect(startSpy).toHaveBeenCalledWith(false);
      expect(pairedCb).toBeDefined();

      await act(async () => {
        pairedCb?.({
          deviceId: 'android-1',
          deviceName: 'Pixel 9',
          platform: 'android',
          pairedAtMs: Date.now(),
        });
      });

      expect(host.textContent).toContain('Connected to Pixel 9');
      expect(host.textContent).toContain('ANDROID');

      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(useUi.getState().pairMobileOpen).toBe(false);
    } finally {
      delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
