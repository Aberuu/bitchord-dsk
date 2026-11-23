import { describe, expect, it } from 'vitest';
import { DEFAULT_EQ_CONFIG, PRESET_MAP } from '@/playback/webAudioEq';
import { buildAudioPipelineData, formatSampleRate } from './audioPipelineData';

describe('audioPipelineData', () => {
  it('formats sample rates cleanly', () => {
    expect(formatSampleRate(48000)).toBe('48 kHz');
    expect(formatSampleRate(44100)).toBe('44.1 kHz');
    expect(formatSampleRate(96000)).toBe('96 kHz');
    expect(formatSampleRate(null)).toBe('-');
  });

  it('produces all 5 signal path stages for a streaming Opus track', () => {
    const summary = buildAudioPipelineData({
      nowPlaying: {
        videoId: 'abc123',
        streamInfo: '251 opus 133kbps via VISIONOS',
        stream: { codec: 'Opus', sampleRateHz: 48000, bitrateKbps: 133, channels: 2 },
      },
      eq: DEFAULT_EQ_CONFIG,
      balance: 0,
      spatialAudio: false,
      loudnessNormalization: false,
      outputPrecision: 'float32',
      bitPerfect: null,
      nativeSnapshot: null,
      devices: [],
      webAudioSampleRateHz: 48000,
      desktop: true,
    });

    expect(summary.stages.map((s) => s.id)).toEqual(['track', 'decoder', 'resampler', 'dsp', 'output']);
    expect(summary.shortSubtitle).toBe('32-bit float · 48 kHz');
    const trackStage = summary.stages[0]!;
    expect(trackStage.rows.find((r) => r.label === 'Format')?.value).toBe('Opus');
    expect(trackStage.rows.find((r) => r.label === 'Bitrate')?.value).toBe('133 kbps');
    const resamplerStage = summary.stages[2]!;
    expect(resamplerStage.rows.find((r) => r.label === 'Quality')?.value).toBe('Passthrough');
    const dspStage = summary.stages[3]!;
    expect(dspStage.rows.find((r) => r.label === 'Bit-exact')?.value).toContain('Yes');
  });

  it('reports non-bit-exact verdict honestly when equalizer or spatial audio is active', () => {
    const summary = buildAudioPipelineData({
      nowPlaying: {
        videoId: 'abc123',
        streamInfo: null,
        stream: { codec: 'Opus', sampleRateHz: 48000, bitrateKbps: 128, channels: 2 },
      },
      eq: {
        ...DEFAULT_EQ_CONFIG,
        enabled: true,
        preset: 'bass_boost',
        bandsDb: [...PRESET_MAP.bass_boost.bands!],
      },
      balance: 0,
      spatialAudio: true,
      loudnessNormalization: true,
      outputPrecision: 'pcm16',
      bitPerfect: null,
      nativeSnapshot: null,
      devices: [],
      webAudioSampleRateHz: 48000,
      desktop: true,
    });

    const dspStage = summary.stages[3]!;
    expect(dspStage.rows.find((r) => r.label === 'EQ Preset')?.value).toBe('Bass Boost');
    expect(dspStage.rows.find((r) => r.label === 'Stereo Expand')?.value).toBe('250%');
    expect(dspStage.rows.find((r) => r.label === 'Bit-exact')?.value).toBe('No (equalizer active)');
  });

  it('reports Audio Tap route and selected IEM/Headphones sample rate honestly for streaming tracks', () => {
    const summary = buildAudioPipelineData({
      nowPlaying: {
        videoId: 'yt123',
        streamInfo: '251 opus',
        stream: { codec: 'Opus', sampleRateHz: 48000, bitrateKbps: 140, channels: 2 },
      },
      eq: DEFAULT_EQ_CONFIG,
      balance: 0,
      spatialAudio: false,
      loudnessNormalization: false,
      outputPrecision: 'float32',
      bitPerfect: {
        active: false,
        driver: 'WASAPI Shared Tap',
        deviceName: 'Headphones (Realtek(R) Audio)',
        sampleRateHz: 96000,
        outputBits: 32,
        sourceBits: 32,
        sourceRateHz: 48000,
        exact: false,
        dacLimited: false,
        fallbackReason: null,
      },
      nativeSnapshot: {
        active: false,
        tapActive: true,
        status: 'playing',
        trackId: null,
        positionSec: 0,
        durationSec: 0,
        volume: 1,
        playbackRate: 1,
        codec: 'PCM Tap',
        sampleRateHz: 48000,
        bitDepth: 32,
        channels: 2,
        bitPerfect: {
          active: false,
          driver: 'WASAPI Shared Tap',
          deviceName: 'Headphones (Realtek(R) Audio)',
          sampleRateHz: 96000,
          outputBits: 32,
          sourceBits: 32,
          sourceRateHz: 48000,
          exact: false,
          dacLimited: false,
          fallbackReason: null,
        },
        asioAvailable: false,
        eqCurvePoints: [],
        settings: {
          outputMode: 'shared',
          deviceId: 'wasapi_id:hp-1',
          playbackRate: 1,
          sleepTimerEndEpochMs: null,
          sleepAfterTrack: false,
          eq: DEFAULT_EQ_CONFIG,
        },
      },
      devices: [
        {
          id: 'wasapi_id:spk-1',
          name: 'Speakers (Realtek(R) Audio)',
          isDefault: true,
          backend: 'WASAPI',
          supportsExclusive: true,
          maxSampleRateHz: 48000,
          kind: 'speakers',
          isUsbDac: false,
        },
        {
          id: 'wasapi_id:hp-1',
          name: 'Headphones (Realtek(R) Audio)',
          isDefault: false,
          backend: 'WASAPI',
          supportsExclusive: true,
          maxSampleRateHz: 96000,
          kind: 'headphones',
          isUsbDac: false,
        },
      ],
      webAudioSampleRateHz: 48000,
      desktop: true,
    });

    expect(summary.activeDeviceName).toBe('Headphones (Realtek(R) Audio)');
    const outputStage = summary.stages[4]!;
    expect(outputStage.rows.find((r) => r.label === 'Route')?.value).toBe('DESKTOP (Audio Tap)');
    expect(outputStage.rows.find((r) => r.label === 'Transport')?.value).toBe('WASAPI Shared Tap');
    expect(summary.stages[2]!.rows.find((r) => r.label === 'Type')?.value).toBe('Desktop Tap Resampler');
  });
});
