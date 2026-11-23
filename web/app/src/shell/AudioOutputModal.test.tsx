// @vitest-environment happy-dom
import { QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioDeviceInfo, AudioSettings, NativePlaybackSnapshot } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { DEFAULT_EQ_CONFIG } from '@/playback/webAudioEq';
import { useUi } from '@/state/ui';
import { AudioOutputModal } from './AudioOutputModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let currentDevices: AudioDeviceInfo[] = [];
let currentSnapshot: NativePlaybackSnapshot;

const listDevicesMock = vi.fn(async () => currentDevices);
const snapshotMock = vi.fn(async () => currentSnapshot);
const updateSettingsMock = vi.fn(async (next: AudioSettings) => {
  currentSnapshot = { ...currentSnapshot, settings: next };
  return currentSnapshot;
});

vi.mock('@/desktop/tauriBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/desktop/tauriBridge')>();
  return {
    ...actual,
    isTauriDesktop: () => true,
    desktopApi: {
      ...actual.desktopApi,
      audioListDevices: () => listDevicesMock(),
      audioSnapshot: () => snapshotMock(),
      audioUpdateSettings: (next: AudioSettings) => updateSettingsMock(next),
      audioSetVolume: vi.fn(async () => {}),
    },
  };
});

async function flushUi() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 25));
  });
}

describe('AudioOutputModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient.clear();
    listDevicesMock.mockClear();
    snapshotMock.mockClear();
    updateSettingsMock.mockClear();

    currentDevices = [
      {
        id: 'wasapi_id:{spk}',
        name: 'Speakers (Realtek(R) Audio)',
        isDefault: true,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 48000,
        kind: 'speakers',
        isUsbDac: false,
      },
    ];
    currentSnapshot = {
      active: false,
      tapActive: false,
      status: 'idle',
      trackId: null,
      positionSec: 0,
      durationSec: 0,
      volume: 1,
      playbackRate: 1,
      codec: null,
      sampleRateHz: 48000,
      bitDepth: 32,
      channels: 2,
      bitPerfect: {
        active: false,
        driver: null,
        deviceName: null,
        sampleRateHz: 48000,
        outputBits: 32,
        sourceBits: 16,
        sourceRateHz: 48000,
        exact: false,
        dacLimited: false,
        fallbackReason: null,
      },
      asioAvailable: false,
      eqCurvePoints: [],
      settings: {
        outputMode: 'shared',
        deviceId: null,
        playbackRate: 1,
        sleepTimerEndEpochMs: null,
        sleepAfterTrack: false,
        eq: DEFAULT_EQ_CONFIG,
      },
    };
    useUi.setState({ audioOutputOpen: false, audioPipelineOpen: false });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    host.remove();
  });

  it('refetches devices when opened even with pre-existing global query cache and detects newly plugged IEM', async () => {
    // Seed cached list prior to plugging in the IEM (simulating global 5-minute staleTime).
    queryClient.setQueryData(['desktop', 'audio', 'devices'], currentDevices);

    currentDevices = [
      ...currentDevices,
      {
        id: 'wasapi_id:{iem}',
        name: 'Headphones (Realtek(R) Audio)',
        isDefault: false,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 96000,
        kind: 'headphones',
        isUsbDac: false,
      },
    ];

    useUi.setState({ audioOutputOpen: true });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AudioOutputModal />
        </QueryClientProvider>,
      );
    });
    await flushUi();

    expect(listDevicesMock).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Speakers (Realtek(R) Audio)');
    expect(host.textContent).toContain('Headphones (Realtek(R) Audio)');
    expect(host.textContent).toContain('Playing via Speakers (Realtek(R) Audio)');

    const hpButton = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Headphones (Realtek(R) Audio)'),
    );
    expect(hpButton).toBeTruthy();

    await act(async () => {
      hpButton!.click();
    });
    await flushUi();

    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 'wasapi_id:{iem}' }),
    );

    // Close and re-open after plugging another endpoint: must trigger another live fetch.
    await act(async () => {
      useUi.setState({ audioOutputOpen: false });
    });
    currentDevices = [
      ...currentDevices,
      {
        id: 'wasapi_id:{iem-usb}',
        name: 'Moondrop Dawn Pro',
        isDefault: false,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 384000,
        kind: 'usb_dac',
        isUsbDac: true,
      },
    ];
    await act(async () => {
      useUi.setState({ audioOutputOpen: true });
    });
    await flushUi();

    expect(listDevicesMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('Moondrop Dawn Pro');
  });

  it('supports manual refresh while open when a USB DAC is plugged in', async () => {
    useUi.setState({ audioOutputOpen: true });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AudioOutputModal />
        </QueryClientProvider>,
      );
    });
    await flushUi();
    expect(host.textContent).not.toContain('FiiO KA11');

    currentDevices = [
      ...currentDevices,
      {
        id: 'wasapi_id:{dac}',
        name: 'Speakers (FiiO KA11)',
        isDefault: false,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 384000,
        kind: 'usb_dac',
        isUsbDac: true,
      },
    ];

    const refreshBtn = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh audio devices"]');
    expect(refreshBtn).toBeTruthy();

    await act(async () => {
      refreshBtn!.click();
    });
    await flushUi();

    expect(host.textContent).toContain('Speakers (FiiO KA11)');
    expect(host.textContent).toContain('USB DAC · WASAPI · up to 384 kHz');
  });

  it('switches cleanly between Headphones (96 kHz), Speakers (48 kHz), Exclusive toggle, and Default', async () => {
    currentDevices = [
      ...currentDevices,
      {
        id: 'wasapi_id:{hp}',
        name: 'Headphones (Realtek(R) Audio)',
        isDefault: false,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 96000,
        kind: 'headphones',
        isUsbDac: false,
      },
    ];
    updateSettingsMock.mockImplementationOnce(async (next: AudioSettings) => {
      currentSnapshot = {
        ...currentSnapshot,
        tapActive: true,
        settings: next,
        bitPerfect: { ...currentSnapshot.bitPerfect, sampleRateHz: 96000, deviceName: 'Headphones (Realtek(R) Audio)' },
      };
      return currentSnapshot;
    });
    updateSettingsMock.mockImplementationOnce(async (next: AudioSettings) => {
      currentSnapshot = {
        ...currentSnapshot,
        tapActive: true,
        settings: next,
        bitPerfect: { ...currentSnapshot.bitPerfect, sampleRateHz: 48000, deviceName: 'Speakers (Realtek(R) Audio)' },
      };
      return currentSnapshot;
    });
    updateSettingsMock.mockImplementationOnce(async (next: AudioSettings) => {
      currentSnapshot = {
        ...currentSnapshot,
        tapActive: true,
        settings: next,
        bitPerfect: {
          ...currentSnapshot.bitPerfect,
          active: next.outputMode === 'wasapi_exclusive',
          driver: next.outputMode === 'wasapi_exclusive' ? 'WASAPI Exclusive Tap' : 'WASAPI Shared Tap',
          sampleRateHz: 48000,
          outputBits: 24,
        },
      };
      return currentSnapshot;
    });
    updateSettingsMock.mockImplementationOnce(async (next: AudioSettings) => {
      currentSnapshot = {
        ...currentSnapshot,
        tapActive: false,
        settings: next,
        bitPerfect: { ...currentSnapshot.bitPerfect, active: false, driver: null, sampleRateHz: 48000 },
      };
      return currentSnapshot;
    });

    useUi.setState({ audioOutputOpen: true });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AudioOutputModal />
        </QueryClientProvider>,
      );
    });
    await flushUi();

    const findButton = (text: string) =>
      Array.from(host.querySelectorAll('button')).find((b) => b.textContent?.includes(text));

    await act(async () => {
      findButton('Headphones (Realtek(R) Audio)')!.click();
    });
    await flushUi();
    expect(host.textContent).toContain('32-bit float · 96 kHz');

    await act(async () => {
      findButton('WASAPI · up to 48 kHz')!.click();
    });
    await flushUi();
    expect(host.textContent).toContain('32-bit float · 48 kHz');

    await act(async () => {
      findButton('WASAPI Exclusive (Bit-Perfect)')!.click();
    });
    await flushUi();
    expect(updateSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: 'wasapi_id:{spk}', outputMode: 'wasapi_exclusive' }),
    );

    await act(async () => {
      findButton('This PC (Default Output)')!.click();
    });
    await flushUi();
    expect(updateSettingsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ deviceId: null }),
    );
  });
});
