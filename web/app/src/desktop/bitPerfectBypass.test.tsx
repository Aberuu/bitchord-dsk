// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativePlaybackSnapshot } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import AudioEqPage from '@/pages/AudioEqPage';
import PlaybackSettingsPage from '@/pages/PlaybackSettingsPage';
import { DEFAULT_EQ_CONFIG } from '@/playback/webAudioEq';
import { VolumeControl } from '@/shell/VolumeControl';
import { usePlayer } from '@/state/player';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let snapshotState: NativePlaybackSnapshot;

vi.mock('@/desktop/tauriBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/desktop/tauriBridge')>();
  return {
    ...actual,
    isTauriDesktop: () => true,
    desktopApi: {
      ...actual.desktopApi,
      audioListDevices: vi.fn(async () => []),
      audioSnapshot: vi.fn(async () => snapshotState),
      audioUpdateSettings: vi.fn(async (next) => {
        snapshotState = { ...snapshotState, settings: next };
        return snapshotState;
      }),
      audioSetVolume: vi.fn(async () => {}),
    },
  };
});

async function flushUi() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('Bit-Perfect DSP & control locking', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient.clear();

    snapshotState = {
      active: false,
      tapActive: false,
      status: 'playing',
      trackId: null,
      positionSec: 0,
      durationSec: 0,
      volume: 0.7,
      playbackRate: 1.25,
      codec: 'FLAC',
      sampleRateHz: 96000,
      bitDepth: 24,
      channels: 2,
      bitPerfect: {
        active: true,
        driver: 'WASAPI Exclusive',
        deviceName: 'Speakers (SNOWSKY Tiny B)',
        sampleRateHz: 96000,
        outputBits: 24,
        sourceBits: 24,
        sourceRateHz: 96000,
        exact: true,
        dacLimited: false,
        fallbackReason: null,
      },
      asioAvailable: false,
      eqCurvePoints: [],
      settings: {
        outputMode: 'wasapi_exclusive',
        deviceId: 'wasapi_id:{dac}',
        playbackRate: 1.25,
        sleepTimerEndEpochMs: null,
        sleepAfterTrack: false,
        eq: { ...DEFAULT_EQ_CONFIG, enabled: true },
      },
    };

    usePlayer.setState({
      volume: 0.7,
      muted: false,
      playbackRate: 1.25,
      desktopOutputMode: 'wasapi_exclusive',
      bitPerfectStatus: snapshotState.bitPerfect,
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
    usePlayer.setState({
      volume: 1,
      muted: false,
      playbackRate: 1,
      desktopOutputMode: 'shared',
      bitPerfectStatus: null,
    });
  });

  it('ignores software volume, mute, and playback speed mutations while Bit-Perfect stream is active', () => {
    const store = usePlayer.getState();
    store.setVolume(0.25);
    store.toggleMute();
    store.setPlaybackRate(1.75);

    const next = usePlayer.getState();
    expect(next.volume).toBe(0.7);
    expect(next.muted).toBe(false);
    expect(next.playbackRate).toBe(1.25);
  });

  it('locks bypassed settings in PlaybackSettingsPage and restores them when returning to shared mode', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <PlaybackSettingsPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushUi();

    expect(host.textContent).toContain('Bit-perfect output (WASAPI Exclusive) is active');
    expect(host.textContent).toContain('Locked at 1x while Bit-Perfect mode is on');

    const crossfadeSlider = host.querySelector<HTMLInputElement>(
      'input[aria-label="Crossfade duration in seconds"]',
    );
    expect(crossfadeSlider?.disabled).toBe(true);

    const eqLink = host.querySelector<HTMLAnchorElement>('a[href="/settings/audio"]');
    expect(eqLink?.getAttribute('aria-disabled')).toBe('true');

    const checkboxes = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    // First checkbox (Prefer USB DAC) and AutoPlay stay enabled; audio DSP toggles are disabled.
    const disabledCount = checkboxes.filter((cb) => cb.disabled).length;
    expect(disabledCount).toBe(4);

    // Switching Output Mode back to WASAPI Shared unlocks DSP toggles and removes the footer.
    const modeSelectBtn = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('WASAPI Exclusive'),
    );
    expect(modeSelectBtn).toBeTruthy();
    await act(async () => {
      modeSelectBtn!.click();
    });
    await flushUi();

    const sharedItem = Array.from(
      document.body.querySelectorAll<HTMLElement>('[role^="menuitem"], button'),
    ).find((el) => el.textContent?.includes('WASAPI Shared'));
    expect(sharedItem).toBeTruthy();

    snapshotState = {
      ...snapshotState,
      bitPerfect: { ...snapshotState.bitPerfect, active: false, exact: false, driver: 'WASAPI Shared' },
    };
    await act(async () => {
      sharedItem!.click();
    });
    await flushUi();

    expect(host.textContent).not.toContain('Bit-perfect output (WASAPI Exclusive) is active');
    expect(crossfadeSlider?.disabled).toBe(false);
    expect(checkboxes.filter((cb) => cb.disabled).length).toBe(0);
  });

  it('displays the bypass banner and disables EQ and Balance controls in AudioEqPage', async () => {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <AudioEqPage />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    await flushUi();

    expect(host.textContent).toContain('Equalizer & Balance bypassed (Bit-Perfect active)');

    const balanceSlider = host.querySelector<HTMLInputElement>(
      'input[aria-label="Stereo channel balance"]',
    );
    expect(balanceSlider?.disabled).toBe(true);

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('button[role="tab"]'));
    expect(tabs.every((t) => t.disabled)).toBe(true);

    const eqSwitch = host.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(eqSwitch?.disabled).toBe(true);
  });

  it('disables VolumeControl slider and button at 100% when Bit-Perfect output is streaming', async () => {
    await act(async () => {
      root.render(
        <VolumeControl open={true} onOpen={() => {}} className="size-8" />,
      );
    });
    await flushUi();

    const range = host.querySelector<HTMLInputElement>('input[type="range"]');
    const btn = host.querySelector<HTMLButtonElement>('button');
    expect(range?.disabled).toBe(true);
    expect(range?.value).toBe('1');
    expect(btn?.disabled).toBe(true);
    expect(btn?.getAttribute('aria-label')).toContain('bypassed');
  });
});
