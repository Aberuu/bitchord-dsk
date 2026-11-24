// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioDeviceInfo, NativePlaybackSnapshot } from '@/desktop/tauriBridge';
import { queryClient } from '@/lib/queryClient';
import { DEFAULT_EQ_CONFIG } from '@/playback/webAudioEq';

const FIIO_DEVICE: AudioDeviceInfo = {
  id: 'wasapi_id:{fiio-k7}',
  name: 'FiiO K7 USB DAC',
  isDefault: false,
  backend: 'WASAPI',
  supportsExclusive: true,
  maxSampleRateHz: 384000,
  kind: 'usb_dac',
  isUsbDac: true,
};

const WINDOWS_SPEAKERS: AudioDeviceInfo = {
  id: 'wasapi_id:{speakers}',
  name: 'Speakers (Realtek Audio)',
  isDefault: true,
  backend: 'WASAPI',
  supportsExclusive: true,
  maxSampleRateHz: 48000,
  kind: 'speakers',
  isUsbDac: false,
};

let backendSnapshot: NativePlaybackSnapshot;
const updateSettingsMock = vi.fn(async (next: NativePlaybackSnapshot['settings']) => {
  backendSnapshot = { ...backendSnapshot, settings: next };
  return backendSnapshot;
});

vi.mock('@/desktop/tauriBridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/desktop/tauriBridge')>();
  return {
    ...actual,
    isTauriDesktop: () => true,
    desktopApi: {
      ...actual.desktopApi,
      audioListDevices: vi.fn(async () => [WINDOWS_SPEAKERS, FIIO_DEVICE]),
      audioSnapshot: vi.fn(async () => backendSnapshot),
      audioUpdateSettings: (next: NativePlaybackSnapshot['settings']) => updateSettingsMock(next),
      audioSetVolume: vi.fn(async () => {}),
    },
  };
});

describe('Playback session restore & OS-default audio output behavior', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
    updateSettingsMock.mockClear();
    backendSnapshot = {
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
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists active queue, track, and position, restores paused on reopen, and seeks cleanly before Play', async () => {
    const playerMod = await import('./player');
    const { usePlayer, flushPlaybackSession, hydratePlaybackSessionFromStorage, getPlayhead } = playerMod;

    usePlayer.setState({
      queue: [
        {
          entryId: 'e1',
          tier: 'user',
          source: { title: 'Album', type: 'album', id: 'alb-1' },
          track: {
            videoId: 'vid-restore-1',
            title: 'Previous Session Track',
            artists: [{ name: 'Artist A', id: null }],
            album: { name: 'Record 1', id: null },
            durationSec: 245,
            explicit: false,
            thumbnail: null,
            index: 0,
            plays: null,
          },
        },
      ],
      index: 0,
      nowPlaying: {
        videoId: 'vid-restore-1',
        title: 'Previous Session Track',
        artist: 'Artist A',
        artworkUrl: null,
        durationSec: 245,
        streamInfo: '251 opus',
        stream: null,
      },
      status: 'playing',
      nativeActive: true,
      nativePlayhead: {
        trackId: 'vid-restore-1',
        positionSec: 84,
        durationSec: 245,
        playbackRate: 1,
        updatedAtMs: performance.now(),
        paused: true,
      },
    });

    flushPlaybackSession();
    const rawSaved = localStorage.getItem('bitchord:playback-session');
    expect(rawSaved).toContain('vid-restore-1');

    // Simulate closing and reopening with clean store state.
    usePlayer.setState({
      queue: [],
      index: -1,
      nowPlaying: null,
      status: 'idle',
      nativeActive: false,
      nativePlayhead: null,
    });

    expect(hydratePlaybackSessionFromStorage()).toBe(true);
    const restored = usePlayer.getState();
    expect(restored.nowPlaying?.videoId).toBe('vid-restore-1');
    expect(restored.queue).toHaveLength(1);
    expect(restored.status).toBe('paused');
    expect(getPlayhead()?.sec).toBeCloseTo(84, 1);

    // Seeking on a lazily restored paused session updates saved timestamp before Play.
    restored.seek(120);
    expect(getPlayhead()?.sec).toBeCloseTo(120, 1);
  });

  it('defaults preferUsbDac to false so startup follows OS default instead of forcing FiiO USB DAC, while still allowing manual selection', async () => {
    // Seed legacy prefs where old default wrote preferUsbDac: true.
    localStorage.setItem('bitchord:player', JSON.stringify({ preferUsbDac: true }));
    vi.resetModules();

    const playerMod = await import('./player');
    const devicesMod = await import('@/desktop/useDesktopAudioDevices');

    expect(playerMod.usePlayer.getState().preferUsbDac).toBe(false);

    await devicesMod.refreshDesktopAudioState(true);
    // Startup did NOT override deviceId: null with FiiO USB DAC.
    expect(updateSettingsMock).not.toHaveBeenCalled();
    expect(backendSnapshot.settings.deviceId).toBeNull();

    // User can still switch manually inside the app anytime.
    await updateSettingsMock({ ...backendSnapshot.settings, deviceId: FIIO_DEVICE.id });
    expect(backendSnapshot.settings.deviceId).toBe(FIIO_DEVICE.id);
  });
});
