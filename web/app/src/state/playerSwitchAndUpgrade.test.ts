// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/data/music/types';
import { desktopApi, type AddonConfig } from '@/desktop/tauriBridge';
import { extensionQueryKey } from '@/extension/useExtension';
import { queryClient } from '@/lib/queryClient';
import { useSources } from '@/state/sources';

const engineLoadMock = vi.fn();
const engineStopMock = vi.fn(async () => {});

vi.mock('@/playback/youtube/videoDeck', () => ({
  followVideo: vi.fn(),
}));

vi.mock('@/playback/youtube/engine', () => {
  class MockYouTubeEngine {
    readonly audio: HTMLAudioElement;
    onFatal: (videoId: string, message: string, permanent: boolean) => void = () => {};
    onRecovered: (track: unknown) => void = () => {};

    constructor(audio: HTMLAudioElement) {
      this.audio = audio;
    }

    load(videoId: string, opts?: { startSec?: number; autoplay?: boolean }) {
      return engineLoadMock(this.audio, videoId, opts);
    }

    stop() {
      return engineStopMock();
    }
  }
  return { YouTubeEngine: MockYouTubeEngine };
});

import { getAudio, getPlayhead, usePlayer } from '@/state/player';

const TEST_ADDON: AddonConfig = {
  id: 'addon:layz',
  name: 'Layz Add On',
  baseUrl: 'http://127.0.0.1:8080',
  enabled: true,
  pickedQuality: 'lossless',
  qualityOptions: [{ value: 'lossless', label: 'Lossless' }],
  allowDownloads: true,
  checkValidLossless: true,
  bitchordAuth: false,
  version: '1.6.0',
  defaultSettings: {},
};

function makeTrack(videoId: string, title: string, artist: string, durationSec = 210): Track {
  return {
    videoId,
    title,
    artists: [{ name: artist, id: `art-${videoId}` }],
    album: { name: 'Album', id: `alb-${videoId}` },
    durationSec,
    explicit: false,
    thumbnail: null,
    index: null,
    plays: null,
  };
}

describe('player track switch isolation & background lossless upgrade', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    Object.assign(window, { __TAURI_INTERNALS__: {} });

    queryClient.setQueryData(extensionQueryKey, {
      info: { version: '1.0.0', capabilities: ['yt'] },
    });
    queryClient.setQueryData(['desktop', 'audio', 'snapshot'], {
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
      bitDepth: 24,
      channels: 2,
      bitPerfect: {
        active: false,
        driver: null,
        deviceName: null,
        sampleRateHz: 0,
        outputBits: 0,
        sourceBits: 0,
        sourceRateHz: 0,
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
        eq: {
          enabled: false,
          mode: 'manual',
          preset: 'flat',
          bandsDb: [0, 0, 0, 0, 0, 0, 0],
          toneX: 0,
          toneY: 0,
          toneFocused: false,
        },
      },
    });

    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: false, configurable: true });
      this.dispatchEvent(new Event('playing'));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { value: true, configurable: true });
      this.dispatchEvent(new Event('pause'));
    });

    vi.spyOn(desktopApi, 'downloadsMediaUrl').mockResolvedValue(null);
    vi.spyOn(desktopApi, 'localMediaUrl').mockResolvedValue(null);
    vi.spyOn(desktopApi, 'audioStop').mockResolvedValue();
    vi.spyOn(desktopApi, 'audioSetVolume').mockResolvedValue();

    useSources.setState({
      loaded: true,
      addons: [TEST_ADDON],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
    });

    usePlayer.setState({
      directSourceStream: false,
      streamingQuality: 'lossless',
      queue: [],
      index: -1,
      nowPlaying: null,
      status: 'idle',
      error: null,
      nativeActive: false,
      nativePlayhead: null,
    });

    engineLoadMock.mockReset();
    engineStopMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('immediately pauses previous audio and locks getPlayhead to 0:00 while next track is loading', async () => {
    const songA = makeTrack('vid-a', 'First Song', 'Artist One', 180);
    const songB = makeTrack('vid-b', 'Second Song', 'Artist Two', 200);

    vi.spyOn(desktopApi, 'sourcesSearchSource').mockImplementation(async (_src, q) => {
      if (q.toLowerCase().includes('first')) return [];
      await new Promise((r) => setTimeout(r, 8000));
      return [];
    });

    engineLoadMock.mockImplementation(async (audio: HTMLAudioElement, videoId: string) => {
      Object.defineProperty(audio, 'duration', { value: 180, configurable: true });
      audio.currentTime = 42;
      await audio.play();
      return {
        videoId,
        title: videoId === 'vid-a' ? 'First Song' : 'Second Song',
        author: videoId === 'vid-a' ? 'Artist One' : 'Artist Two',
        durationSec: 180,
        thumbnails: [],
        client: 'VISIONOS',
        format: '251 opus 140kbps direct',
        stream: {
          codec: 'Opus',
          itag: '251',
          bitrateKbps: 140,
          sampleRateHz: 48000,
          channels: 2,
          mode: 'direct',
        },
        loudnessDb: null,
      };
    });

    usePlayer.getState().playTrack(songA, { title: 'Search', type: 'search' });
    await vi.advanceTimersByTimeAsync(50);

    expect(usePlayer.getState().nowPlaying?.videoId).toBe('vid-a');
    expect(usePlayer.getState().status).toBe('playing');
    const firstAudio = getAudio()!;
    expect(firstAudio.paused).toBe(false);
    expect(getPlayhead()).toEqual({ sec: 42, paused: false });

    // Switch to Song B while addon lookup takes 8s (exceeds 2.5s race, so during the first 1s it is loading).
    usePlayer.getState().playTrack(songB, { title: 'Search', type: 'search' });
    await vi.advanceTimersByTimeAsync(100);

    // Song A's audio must be paused immediately and playhead must NOT leak Song A's 42s timestamp!
    expect(firstAudio.paused).toBe(true);
    expect(usePlayer.getState().nowPlaying?.videoId).toBe('vid-b');
    expect(usePlayer.getState().status).toBe('loading');
    expect(getPlayhead()).toEqual({ sec: 0, paused: true });

    // Even if a stale 'playing' event fires on Song A's element while Song B is loading, status stays 'loading'.
    firstAudio.dispatchEvent(new Event('playing'));
    expect(usePlayer.getState().status).toBe('loading');
    expect(getPlayhead()).toEqual({ sec: 0, paused: true });
  });

  it('starts YouTube Music after 2.5s race and smoothly upgrades to FLAC in background when >=20s remain', async () => {
    const song = makeTrack('vid-upgrade', 'Dumb Feeling', 'Mei Semones', 200);

    vi.spyOn(desktopApi, 'sourcesSearchSource').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 5000));
      return [
        {
          id: 'ia-flac-1',
          sourceId: TEST_ADDON.id,
          sourceName: TEST_ADDON.name,
          title: 'Dumb Feeling',
          artist: 'Mei Semones',
          album: 'Kabutomushi',
          durationSec: 200,
          explicit: false,
          artworkUrl: null,
          streamUrl: null,
          headers: {},
          mimeType: 'audio/flac',
          format: 'flac',
          codec: 'FLAC',
          bitrateKbps: 1411,
          sampleRateHz: 44100,
          bitDepth: 16,
          lossless: true,
        },
      ];
    });

    vi.spyOn(desktopApi, 'sourcesResolveCandidate').mockResolvedValue({
      proxyUrl: 'http://127.0.0.1:9999/tok/remote/flac-1',
      proxyKey: 'flac-1',
      stream: {
        sourceId: TEST_ADDON.id,
        sourceName: TEST_ADDON.name,
        trackId: 'ia-flac-1',
        url: 'https://archive.org/download/ia-flac-1/track.flac',
        headers: {},
        mimeType: 'audio/flac',
        format: 'flac',
        codec: 'FLAC',
        bitrateKbps: 1411,
        sampleRateHz: 44100,
        bitDepth: 16,
        lossless: true,
      },
    });

    engineLoadMock.mockImplementation(async (audio: HTMLAudioElement, videoId: string) => {
      Object.defineProperty(audio, 'duration', { value: 200, configurable: true });
      audio.currentTime = 12;
      await audio.play();
      return {
        videoId,
        title: 'Dumb Feeling',
        author: 'Mei Semones',
        durationSec: 200,
        thumbnails: [],
        client: 'VISIONOS',
        format: '251 opus 140kbps direct',
        stream: {
          codec: 'Opus',
          itag: '251',
          bitrateKbps: 140,
          sampleRateHz: 48000,
          channels: 2,
          mode: 'direct',
        },
        loudnessDb: null,
      };
    });

    // Simulate HTMLAudioElement setting readyState & firing loadedmetadata/canplay when src is assigned on back deck.
    const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      get() {
        return srcDescriptor?.get?.call(this) ?? '';
      },
      set(val: string) {
        srcDescriptor?.set?.call(this, val);
        Object.defineProperty(this, 'duration', { value: 200, configurable: true });
        Object.defineProperty(this, 'readyState', { value: 4, configurable: true });
        queueMicrotask(() => {
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('canplay'));
        });
      },
    });

    try {
      usePlayer.getState().playTrack(song, { title: 'Album', type: 'album' });

      // At 2.6s, the 2.5s fast race has timed out -> YouTube Music must already be playing!
      await vi.advanceTimersByTimeAsync(2600);
      expect(usePlayer.getState().status).toBe('playing');
      expect(usePlayer.getState().nowPlaying?.stream?.codec).toBe('Opus');
      const ytAudio = getAudio()!;

      // Advance past 5.0s addon lookup + 80ms micro-crossfade -> upgraded to FLAC on the other deck!
      await vi.advanceTimersByTimeAsync(3000);
      expect(usePlayer.getState().nowPlaying?.stream?.codec).toBe('FLAC');
      expect(usePlayer.getState().nowPlaying?.streamInfo).toContain('Layz Add On');
      const upgradedAudio = getAudio()!;
      expect(upgradedAudio).not.toBe(ytAudio);
      expect(ytAudio.paused).toBe(true);
      expect(upgradedAudio.paused).toBe(false);
    } finally {
      if (srcDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'src', srcDescriptor);
      }
    }
  });

  it('skips background FLAC upgrade when fewer than 20 seconds remain in the song', async () => {
    const song = makeTrack('vid-near-end', 'Short Tail', 'Mei Semones', 200);

    vi.spyOn(desktopApi, 'sourcesSearchSource').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return [
        {
          id: 'ia-flac-2',
          sourceId: TEST_ADDON.id,
          sourceName: TEST_ADDON.name,
          title: 'Short Tail',
          artist: 'Mei Semones',
          album: 'Album',
          durationSec: 200,
          explicit: false,
          artworkUrl: null,
          streamUrl: null,
          headers: {},
          mimeType: 'audio/flac',
          format: 'flac',
          codec: 'FLAC',
          bitrateKbps: 1411,
          sampleRateHz: 44100,
          bitDepth: 16,
          lossless: true,
        },
      ];
    });
    vi.spyOn(desktopApi, 'sourcesResolveCandidate').mockResolvedValue({
      proxyUrl: 'http://127.0.0.1:9999/tok/remote/flac-2',
      proxyKey: 'flac-2',
      stream: {
        sourceId: TEST_ADDON.id,
        sourceName: TEST_ADDON.name,
        trackId: 'ia-flac-2',
        url: 'https://archive.org/download/ia-flac-2/track.flac',
        headers: {},
        mimeType: 'audio/flac',
        format: 'flac',
        codec: 'FLAC',
        bitrateKbps: 1411,
        sampleRateHz: 44100,
        bitDepth: 16,
        lossless: true,
      },
    });

    engineLoadMock.mockImplementation(async (audio: HTMLAudioElement, videoId: string) => {
      Object.defineProperty(audio, 'duration', { value: 200, configurable: true });
      // Only 10 seconds left (< 20s threshold).
      audio.currentTime = 190;
      await audio.play();
      return {
        videoId,
        title: 'Short Tail',
        author: 'Mei Semones',
        durationSec: 200,
        thumbnails: [],
        client: 'VISIONOS',
        format: '251 opus 140kbps direct',
        stream: {
          codec: 'Opus',
          itag: '251',
          bitrateKbps: 140,
          sampleRateHz: 48000,
          channels: 2,
          mode: 'direct',
        },
        loudnessDb: null,
      };
    });

    usePlayer.getState().playTrack(song, { title: 'Album', type: 'album' });
    await vi.advanceTimersByTimeAsync(2600);
    expect(usePlayer.getState().nowPlaying?.stream?.codec).toBe('Opus');

    await vi.advanceTimersByTimeAsync(3000);
    // Must stay on Opus without cutting the final 10 seconds of the song.
    expect(usePlayer.getState().nowPlaying?.stream?.codec).toBe('Opus');
  });
});
