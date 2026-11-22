import { describe, expect, it } from 'vitest';
import {
  computeEqCurve,
  computeEqCurvePoints,
  DEFAULT_EQ_CONFIG,
  formatBalanceLabel,
  PRESET_MAP,
  presetLabel,
  type EqConfig,
} from './webAudioEq';

describe('webAudioEq', () => {
  it('returns flat 0 dB curve when equalizer is disabled', () => {
    const pts = computeEqCurvePoints(DEFAULT_EQ_CONFIG);
    expect(pts).toHaveLength(96);
    expect(pts[0]![0]).toBeCloseTo(20, 1);
    expect(pts[95]![0]).toBeCloseTo(20000, 0);
    for (const [, db] of pts) {
      expect(db).toBe(0);
    }
  });

  it('computes bass boost curve and half-peak negative preamp attenuation when enabled', () => {
    const cfg: EqConfig = {
      ...DEFAULT_EQ_CONFIG,
      enabled: true,
      mode: 'manual',
      preset: 'bass_boost',
      bandsDb: [...PRESET_MAP.bass_boost.bands!],
    };
    const curve = computeEqCurve(cfg);
    expect(curve.preampDb).toBeLessThan(-2.5);
    expect(curve.preampDb).toBeGreaterThan(-6.0);
    expect(curve.points[0]![1]).toBeGreaterThan(4.5);
    expect(curve.points[95]![1]).toBeLessThan(0.5);
  });

  it('computes tone pad tilt and contour response', () => {
    const cfg: EqConfig = {
      ...DEFAULT_EQ_CONFIG,
      enabled: true,
      mode: 'tone',
      toneX: 4,
      toneY: -2,
      toneFocused: true,
    };
    const curve = computeEqCurve(cfg);
    const lowGain = curve.points[0]![1];
    const highGain = curve.points[95]![1];
    expect(lowGain).toBeLessThan(-3);
    expect(highGain).toBeGreaterThan(3);
  });

  it('formats channel balance labels and preset labels accurately', () => {
    expect(formatBalanceLabel(0)).toBe('Center');
    expect(formatBalanceLabel(-0.35)).toBe('35% Left');
    expect(formatBalanceLabel(0.5)).toBe('50% Right');
    expect(presetLabel('bass_boost')).toBe('Bass Boost');
    expect(presetLabel('flat')).toBe('Flat');
  });
});
