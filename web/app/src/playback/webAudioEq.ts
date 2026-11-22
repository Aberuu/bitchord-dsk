import type { AudioSettings, EqualizerPresetId } from '@/desktop/tauriBridge';

export type EqConfig = AudioSettings['eq'];

export const BAND_LABELS = ['60 Hz', '150 Hz', '400 Hz', '1 kHz', '2.5 kHz', '6 kHz', '14 kHz'] as const;
export const MANUAL_BANDS_HZ = [60, 150, 400, 1000, 2500, 6000, 14000] as const;

export const PRESET_MAP: Record<
  EqualizerPresetId,
  { label: string; bands: [number, number, number, number, number, number, number] | null }
> = {
  flat: { label: 'Flat', bands: [0, 0, 0, 0, 0, 0, 0] },
  acoustic: { label: 'Acoustic', bands: [3, 1.5, 0, 1.5, 2.5, 2, 1] },
  bass_boost: { label: 'Bass Boost', bands: [6, 4, 1.5, 0, 0, 0, 0] },
  bass_cut: { label: 'Bass Cut', bands: [-6, -4, -1.5, 0, 0, 0, 0] },
  vocal: { label: 'Vocal', bands: [-3, -1.5, 1, 3.5, 3, 1, -1] },
  treble_boost: { label: 'Treble Boost', bands: [0, 0, 0, 0, 1.5, 3.5, 5] },
  treble_cut: { label: 'Treble Cut', bands: [0, 0, 0, 0, -1.5, -3.5, -5] },
  loudness: { label: 'Loudness', bands: [6, 3.5, 0, -1.5, -1, 2, 5] },
  spoken_word: { label: 'Spoken Word', bands: [-5, -2.5, 1.5, 4, 3.5, 1.5, -2] },
  electronic: { label: 'Electronic', bands: [5, 3, -1, 0, 1, 3, 4] },
  rock: { label: 'Rock', bands: [4, 2.5, -1, -1.5, 1, 3, 3.5] },
  hip_hop: { label: 'Hip Hop', bands: [6, 4, 0.5, -1, 0.5, 2, 2.5] },
  jazz: { label: 'Jazz', bands: [3, 1.5, 0, 1, 1.5, 2, 2.5] },
  classical: { label: 'Classical', bands: [3, 2, 0, 0, 1, 2.5, 3] },
  small_speakers: { label: 'Small Speakers', bands: [5, 4, 2, 0.5, 0, -1, -2] },
  late_night: { label: 'Late Night', bands: [3, 1, 0, 1.5, 1, -1, -3] },
  custom: { label: 'Custom', bands: null },
};

export const DEFAULT_EQ_CONFIG: EqConfig = {
  enabled: false,
  mode: 'manual',
  preset: 'flat',
  bandsDb: [0, 0, 0, 0, 0, 0, 0],
  toneX: 0,
  toneY: 0,
  toneFocused: false,
};

type FilterKind = 'bell' | 'lowshelf' | 'highshelf';

interface FilterSlot {
  kind: FilterKind;
  frequencyHz: number;
}

export const EQ_SLOTS: readonly FilterSlot[] = [
  { kind: 'lowshelf', frequencyHz: 60 },
  { kind: 'bell', frequencyHz: 150 },
  { kind: 'bell', frequencyHz: 400 },
  { kind: 'bell', frequencyHz: 1000 },
  { kind: 'bell', frequencyHz: 2500 },
  { kind: 'bell', frequencyHz: 6000 },
  { kind: 'highshelf', frequencyHz: 14000 },
  { kind: 'lowshelf', frequencyHz: 250 },
  { kind: 'bell', frequencyHz: 1000 },
  { kind: 'highshelf', frequencyHz: 4000 },
];

const MANUAL_Q = 1.0;
const MANUAL_RANGE_DB = 12.0;
const TONE_STEPS = 5;
const TONE_DB_PER_STEP = 1.2;
const MAKEUP_FRACTION = 0.5;
const RESPONSE_POINTS = 96;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function responseFrequency(point: number): number {
  const fraction = point / (RESPONSE_POINTS - 1);
  return 20 * Math.pow(1000, fraction);
}

export function sectionGainDb(slot: FilterSlot, gainDb: number, q: number, hz: number): number {
  if (Math.abs(gainDb) < 0.01) return 0;
  const a = Math.pow(10, gainDb / 40);
  const a2 = a * a;
  const x = hz / slot.frequencyHz;
  const x2 = x * x;
  const qq = q * q;
  let mag = 1;
  if (slot.kind === 'bell') {
    const flat = (1 - x2) * (1 - x2);
    mag = Math.sqrt((flat + (x2 * a2) / qq) / (flat + x2 / (a2 * qq)));
  } else if (slot.kind === 'lowshelf') {
    const common = (x2 * a) / qq;
    mag = a * Math.sqrt(((a - x2) * (a - x2) + common) / ((1 - a * x2) * (1 - a * x2) + common));
  } else {
    const common = (x2 * a) / qq;
    mag = a * Math.sqrt(((1 - a * x2) * (1 - a * x2) + common) / ((a - x2) * (a - x2) + common));
  }
  return 20 * Math.log10(mag);
}

export interface ComputedEqCurve {
  gainsDb: number[];
  qs: number[];
  preampDb: number;
  points: [number, number][];
}

export function computeEqCurve(cfg: EqConfig): ComputedEqCurve {
  const gainsDb = Array.from({ length: EQ_SLOTS.length }, () => 0);
  const qs = Array.from({ length: EQ_SLOTS.length }, () => 0.707);

  if (cfg.enabled) {
    if (cfg.mode === 'tone') {
      const tilt = clamp(cfg.toneX, -TONE_STEPS, TONE_STEPS) * TONE_DB_PER_STEP;
      const contour = clamp(cfg.toneY, -TONE_STEPS, TONE_STEPS) * TONE_DB_PER_STEP;
      gainsDb[7] = -tilt;
      gainsDb[8] = contour;
      gainsDb[9] = tilt;
      const shelfQ = cfg.toneFocused ? 0.9 : 0.5;
      const bellQ = cfg.toneFocused ? 2.2 : 0.7;
      qs[7] = shelfQ;
      qs[8] = bellQ;
      qs[9] = shelfQ;
    } else {
      for (let i = 0; i < 7; i++) {
        gainsDb[i] = clamp(cfg.bandsDb[i] ?? 0, -MANUAL_RANGE_DB, MANUAL_RANGE_DB);
        qs[i] = MANUAL_Q;
      }
    }
  }

  let peak = 0;
  const points: [number, number][] = [];
  for (let p = 0; p < RESPONSE_POINTS; p++) {
    const hz = responseFrequency(p);
    let sum = 0;
    for (let slot = 0; slot < EQ_SLOTS.length; slot++) {
      sum += sectionGainDb(EQ_SLOTS[slot]!, gainsDb[slot]!, qs[slot]!, hz);
    }
    if (sum > peak) peak = sum;
    points.push([hz, sum]);
  }

  const preampDb = cfg.enabled ? -peak * MAKEUP_FRACTION : 0;
  return { gainsDb, qs, preampDb, points };
}

export function computeEqCurvePoints(cfg: EqConfig): [number, number][] {
  return computeEqCurve(cfg).points;
}

export class WebAudioEqualizer {
  readonly input: GainNode;
  private readonly preamp: GainNode;
  private readonly filters: BiquadFilterNode[];
  private readonly limiter: DynamicsCompressorNode;

  constructor(ctx: AudioContext) {
    this.input = new GainNode(ctx, { gain: 1 });
    this.preamp = new GainNode(ctx, { gain: 1 });
    this.filters = EQ_SLOTS.map((slot) => {
      const filter = new BiquadFilterNode(ctx, {
        type: slot.kind === 'bell' ? 'peaking' : slot.kind,
        frequency: slot.frequencyHz,
        Q: 0.707,
        gain: 0,
      });
      return filter;
    });
    this.limiter = new DynamicsCompressorNode(ctx, {
      threshold: -0.5,
      knee: 0,
      ratio: 20,
      attack: 0.001,
      release: 0.1,
    });

    this.input.connect(this.preamp);
    let prev: AudioNode = this.preamp;
    for (const f of this.filters) {
      prev.connect(f);
      prev = f;
    }
    prev.connect(this.limiter);
    this.limiter.connect(ctx.destination);
  }

  applyConfig(cfg: EqConfig): void {
    const curve = computeEqCurve(cfg);
    this.preamp.gain.value = cfg.enabled ? Math.pow(10, curve.preampDb / 20) : 1;
    for (let i = 0; i < this.filters.length; i++) {
      this.filters[i]!.gain.value = cfg.enabled ? curve.gainsDb[i]! : 0;
      this.filters[i]!.Q.value = curve.qs[i]!;
    }
  }
}
