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
});
