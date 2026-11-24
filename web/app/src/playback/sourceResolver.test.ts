// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '@/data/music/types';
import { desktopApi, type AddonConfig, type SourceCandidateTrack } from '@/desktop/tauriBridge';
import {
  buildMatchTargetFromTrack,
  hasLosslessOutputCapability,
  pickMatchingCandidate,
  resolveReplacementSource,
} from '@/playback/sourceResolver';
import { useSources } from '@/state/sources';

const BASE_ADDON: AddonConfig = {
  id: 'addon:hires',
  name: 'Hi-Res Lossless',
  baseUrl: 'https://addon.example.com',
  enabled: true,
  pickedQuality: 'lossless',
  qualityOptions: [
    { value: 'lossless', label: 'Lossless' },
    { value: 'high', label: 'High' },
  ],
  allowDownloads: true,
  checkValidLossless: false,
  bitchordAuth: false,
  version: '1.0.0',
  defaultSettings: {},
};

const TARGET_TRACK: Track = {
  videoId: 'yt-123',
  title: 'Dumb Feeling',
  artists: [{ name: 'Mei Semones', id: 'artist-1' }],
  album: { name: 'Kabutomushi', id: 'album-1' },
  durationSec: 200,
  explicit: false,
  thumbnail: null,
  index: null,
  plays: null,
};

function makeCandidate(overrides: Partial<SourceCandidateTrack> = {}): SourceCandidateTrack {
  return {
    id: 'trk-1',
    sourceId: 'addon:hires',
    sourceName: 'Hi-Res Lossless',
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
    bitrateKbps: 1100,
    sampleRateHz: 48000,
    bitDepth: 24,
    lossless: true,
    ...overrides,
  };
}

describe('sourceResolver & Track length tolerance', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    useSources.setState({
      loaded: true,
      addons: [BASE_ADDON],
      jiosaavnEnabled: false,
      trackLengthToleranceSec: 5,
    });
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it('rejects candidates exceeding trackLengthToleranceSec and accepts inside tolerance', () => {
    const target = buildMatchTargetFromTrack(TARGET_TRACK);
    const drifted = makeCandidate({ id: 'drifted', durationSec: 207 });

    expect(pickMatchingCandidate([drifted], target, 5)).toBeNull();
    expect(pickMatchingCandidate([drifted], target, 8)?.id).toBe('drifted');
  });

  it('treats Bluetooth shared output as non-lossless for checkValidLossless addons', () => {
    expect(
      hasLosslessOutputCapability('shared', {
        id: 'bt-1',
        name: 'WH-1000XM5',
        isDefault: true,
        backend: 'WASAPI',
        supportsExclusive: false,
        maxSampleRateHz: 48000,
        kind: 'bluetooth',
        isUsbDac: false,
      }),
    ).toBe(false);

    expect(
      hasLosslessOutputCapability('wasapi_exclusive', {
        id: 'dac-1',
        name: 'USB DAC',
        isDefault: true,
        backend: 'WASAPI',
        supportsExclusive: true,
        maxSampleRateHz: 384000,
        kind: 'usb_dac',
        isUsbDac: true,
      }),
    ).toBe(true);
  });

  it('walks Addons in order and falls back to JioSaavn when earlier addon misses tolerance', async () => {
    useSources.setState({
      loaded: true,
      addons: [BASE_ADDON],
      jiosaavnEnabled: true,
      trackLengthToleranceSec: 3,
    });

    const searchSpy = vi.spyOn(desktopApi, 'sourcesSearchSource').mockImplementation(async (sourceId) => {
      if (sourceId === BASE_ADDON.id) {
        return [makeCandidate({ id: 'slow-master', durationSec: 210 })];
      }
      if (sourceId === 'jiosaavn') {
        return [
          makeCandidate({
            id: 'saavn-1',
            sourceId: 'jiosaavn',
            sourceName: 'JioSaavn',
            durationSec: 202,
            format: 'mp4',
            codec: 'AAC',
            bitrateKbps: 320,
            lossless: false,
            streamUrl: 'https://aac.saavncdn.com/song_320.mp4',
          }),
        ];
      }
      return [];
    });

    const resolveSpy = vi.spyOn(desktopApi, 'sourcesResolveCandidate').mockResolvedValue({
      proxyUrl: 'http://127.0.0.1:4444/tok/remote/src-1',
      proxyKey: 'src-1',
      stream: {
        sourceId: 'jiosaavn',
        sourceName: 'JioSaavn',
        trackId: 'saavn-1',
        url: 'https://aac.saavncdn.com/song_320.mp4',
        headers: {},
        mimeType: 'audio/mp4',
        format: 'mp4',
        codec: 'AAC',
        bitrateKbps: 320,
        sampleRateHz: 44100,
        bitDepth: null,
        lossless: false,
      },
    });

    const resolved = await resolveReplacementSource(TARGET_TRACK, {
      streamingQuality: 'lossless',
      outputMode: 'shared',
      activeDevice: null,
    });

    expect(searchSpy).toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolved?.payload.stream.sourceId).toBe('jiosaavn');
    expect(resolved?.payload.proxyUrl).toContain('remote/src-1');
  });
});
