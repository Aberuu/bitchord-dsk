use serde::{Deserialize, Serialize};
use std::f64::consts::PI;

pub const MANUAL_BANDS_HZ: [f32; 7] = [60.0, 150.0, 400.0, 1_000.0, 2_500.0, 6_000.0, 14_000.0];
pub const MANUAL_Q: f32 = 1.0;
pub const MANUAL_RANGE_DB: f32 = 12.0;
pub const TONE_STEPS: i32 = 5;
pub const TONE_DB_PER_STEP: f32 = 1.2;
pub const SLOTS: usize = 10;
const MAKEUP_FRACTION: f32 = 0.5;
const RESPONSE_POINTS: usize = 96;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterKind {
    Bell,
    LowShelf,
    HighShelf,
}

#[derive(Debug, Clone, Copy)]
pub struct FilterSlot {
    pub kind: FilterKind,
    pub frequency_hz: f32,
}

pub const EQ_SLOTS: [FilterSlot; SLOTS] = [
    FilterSlot { kind: FilterKind::LowShelf, frequency_hz: 60.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 150.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 400.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 1_000.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 2_500.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 6_000.0 },
    FilterSlot { kind: FilterKind::HighShelf, frequency_hz: 14_000.0 },
    FilterSlot { kind: FilterKind::LowShelf, frequency_hz: 250.0 },
    FilterSlot { kind: FilterKind::Bell, frequency_hz: 1_000.0 },
    FilterSlot { kind: FilterKind::HighShelf, frequency_hz: 4_000.0 },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EqualizerPreset {
    Flat,
    Acoustic,
    BassBoost,
    BassCut,
    Vocal,
    TrebleBoost,
    TrebleCut,
    Loudness,
    SpokenWord,
    Electronic,
    Rock,
    HipHop,
    Jazz,
    Classical,
    SmallSpeakers,
    LateNight,
    Custom,
}

impl EqualizerPreset {
    pub fn bands_db(self) -> Option<[f32; 7]> {
        match self {
            Self::Flat => Some([0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
            Self::Acoustic => Some([3.0, 1.5, 0.0, 1.5, 2.5, 2.0, 1.0]),
            Self::BassBoost => Some([6.0, 4.0, 1.5, 0.0, 0.0, 0.0, 0.0]),
            Self::BassCut => Some([-6.0, -4.0, -1.5, 0.0, 0.0, 0.0, 0.0]),
            Self::Vocal => Some([-3.0, -1.5, 1.0, 3.5, 3.0, 1.0, -1.0]),
            Self::TrebleBoost => Some([0.0, 0.0, 0.0, 0.0, 1.5, 3.5, 5.0]),
            Self::TrebleCut => Some([0.0, 0.0, 0.0, 0.0, -1.5, -3.5, -5.0]),
            Self::Loudness => Some([6.0, 3.5, 0.0, -1.5, -1.0, 2.0, 5.0]),
            Self::SpokenWord => Some([-5.0, -2.5, 1.5, 4.0, 3.5, 1.5, -2.0]),
            Self::Electronic => Some([5.0, 3.0, -1.0, 0.0, 1.0, 3.0, 4.0]),
            Self::Rock => Some([4.0, 2.5, -1.0, -1.5, 1.0, 3.0, 3.5]),
            Self::HipHop => Some([6.0, 4.0, 0.5, -1.0, 0.5, 2.0, 2.5]),
            Self::Jazz => Some([3.0, 1.5, 0.0, 1.0, 1.5, 2.0, 2.5]),
            Self::Classical => Some([3.0, 2.0, 0.0, 0.0, 1.0, 2.5, 3.0]),
            Self::SmallSpeakers => Some([5.0, 4.0, 2.0, 0.5, 0.0, -1.0, -2.0]),
            Self::LateNight => Some([3.0, 1.0, 0.0, 1.5, 1.0, -1.0, -3.0]),
            Self::Custom => None,
        }
    }

    pub fn matching(bands: &[f32; 7]) -> Self {
        let all = [
            Self::Flat,
            Self::Acoustic,
            Self::BassBoost,
            Self::BassCut,
            Self::Vocal,
            Self::TrebleBoost,
            Self::TrebleCut,
            Self::Loudness,
            Self::SpokenWord,
            Self::Electronic,
            Self::Rock,
            Self::HipHop,
            Self::Jazz,
            Self::Classical,
            Self::SmallSpeakers,
            Self::LateNight,
        ];
        for preset in all {
            if let Some(target) = preset.bands_db() {
                if target
                    .iter()
                    .zip(bands.iter())
                    .all(|(a, b)| (a - b).abs() < 0.05)
                {
                    return preset;
                }
            }
        }
        Self::Custom
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqConfig {
    pub enabled: bool,
    pub mode: String,
    pub preset: EqualizerPreset,
    pub bands_db: [f32; 7],
    pub tone_x: i32,
    pub tone_y: i32,
    pub tone_focused: bool,
}

impl Default for EqConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "manual".into(),
            preset: EqualizerPreset::Flat,
            bands_db: [0.0; 7],
            tone_x: 0,
            tone_y: 0,
            tone_focused: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct EqCurve {
    pub gains_db: [f32; SLOTS],
    pub qs: [f32; SLOTS],
    pub preamp_db: f32,
}

impl EqCurve {
    pub fn flat() -> Self {
        Self::of([0.0; SLOTS], [0.707; SLOTS])
    }

    pub fn of(gains_db: [f32; SLOTS], qs: [f32; SLOTS]) -> Self {
        let preamp_db = preamp_for(&gains_db, &qs);
        Self {
            gains_db,
            qs,
            preamp_db,
        }
    }

    pub fn from_config(cfg: &EqConfig) -> Self {
        if !cfg.enabled {
            return Self::flat();
        }
        if cfg.mode == "tone" {
            tone_curve(cfg.tone_x, cfg.tone_y, cfg.tone_focused)
        } else {
            manual_curve(&cfg.bands_db)
        }
    }

    pub fn response_points(&self) -> Vec<(f32, f32)> {
        (0..RESPONSE_POINTS)
            .map(|p| {
                let hz = response_frequency(p);
                let mut sum = 0.0f32;
                for slot in 0..SLOTS {
                    sum += section_gain_db(EQ_SLOTS[slot], self.gains_db[slot], self.qs[slot], hz);
                }
                (hz, sum)
            })
            .collect()
    }
}

pub fn manual_curve(bands_db: &[f32; 7]) -> EqCurve {
    let mut gains = [0.0f32; SLOTS];
    let mut qs = [0.707f32; SLOTS];
    for (i, &g) in bands_db.iter().enumerate() {
        gains[i] = g.clamp(-MANUAL_RANGE_DB, MANUAL_RANGE_DB);
        qs[i] = MANUAL_Q;
    }
    EqCurve::of(gains, qs)
}

pub fn tone_curve(x: i32, y: i32, focused: bool) -> EqCurve {
    let mut gains = [0.0f32; SLOTS];
    let mut qs = [0.707f32; SLOTS];
    let tilt = x.clamp(-TONE_STEPS, TONE_STEPS) as f32 * TONE_DB_PER_STEP;
    let contour = y.clamp(-TONE_STEPS, TONE_STEPS) as f32 * TONE_DB_PER_STEP;
    gains[7] = -tilt;
    gains[8] = contour;
    gains[9] = tilt;
    let shelf_q = if focused { 0.9 } else { 0.5 };
    let bell_q = if focused { 2.2 } else { 0.7 };
    qs[7] = shelf_q;
    qs[8] = bell_q;
    qs[9] = shelf_q;
    EqCurve::of(gains, qs)
}

fn response_frequency(point: usize) -> f32 {
    let fraction = point as f64 / (RESPONSE_POINTS - 1) as f64;
    (20.0 * 1_000.0f64.powf(fraction)) as f32
}

fn preamp_for(gains_db: &[f32; SLOTS], qs: &[f32; SLOTS]) -> f32 {
    let mut peak = 0.0f32;
    for p in 0..RESPONSE_POINTS {
        let hz = response_frequency(p);
        let mut sum = 0.0f32;
        for slot in 0..SLOTS {
            sum += section_gain_db(EQ_SLOTS[slot], gains_db[slot], qs[slot], hz);
        }
        if sum > peak {
            peak = sum;
        }
    }
    -peak * MAKEUP_FRACTION
}

pub fn section_gain_db(slot: FilterSlot, gain_db: f32, q: f32, hz: f32) -> f32 {
    if gain_db.abs() < 0.01 {
        return 0.0;
    }
    let a = 10.0f64.powf(gain_db as f64 / 40.0);
    let a2 = a * a;
    let x = hz as f64 / slot.frequency_hz as f64;
    let x2 = x * x;
    let qq = (q as f64) * (q as f64);
    let mag = match slot.kind {
        FilterKind::Bell => {
            let flat = (1.0 - x2) * (1.0 - x2);
            ((flat + x2 * a2 / qq) / (flat + x2 / (a2 * qq))).sqrt()
        }
        FilterKind::LowShelf => {
            let common = x2 * a / qq;
            a * (((a - x2) * (a - x2) + common) / ((1.0 - a * x2) * (1.0 - a * x2) + common))
                .sqrt()
        }
        FilterKind::HighShelf => {
            let common = x2 * a / qq;
            a * (((1.0 - a * x2) * (1.0 - a * x2) + common) / ((a - x2) * (a - x2) + common))
                .sqrt()
        }
    };
    (20.0 * mag.log10()) as f32
}

#[derive(Debug, Clone, Copy)]
struct BiquadSection {
    active: bool,
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
    z1: [f64; 2],
    z2: [f64; 2],
}

impl Default for BiquadSection {
    fn default() -> Self {
        Self {
            active: false,
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1: [0.0; 2],
            z2: [0.0; 2],
        }
    }
}

impl BiquadSection {
    fn configure(&mut self, slot: FilterSlot, gain_db: f32, q: f32, sample_rate: f64) {
        if gain_db.abs() < 0.01 || sample_rate <= 0.0 {
            self.active = false;
            return;
        }
        let freq = (slot.frequency_hz as f64).min(sample_rate * 0.45);
        let a = 10.0f64.powf(gain_db as f64 / 40.0);
        let w0 = 2.0 * PI * freq / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * (q as f64).max(0.1));

        let (b0, b1, b2, a0, a1, a2) = match slot.kind {
            FilterKind::Bell => (
                1.0 + alpha * a,
                -2.0 * cos_w0,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos_w0,
                1.0 - alpha / a,
            ),
            FilterKind::LowShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w0),
                    a * ((a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                    (a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos_w0),
                    (a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
                )
            }
            FilterKind::HighShelf => {
                let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0),
                    a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha),
                    (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos_w0),
                    (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha,
                )
            }
        };

        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
        self.active = true;
    }

    #[inline]
    fn tick(&mut self, ch: usize, x: f64) -> f64 {
        let y = self.b0 * x + self.z1[ch];
        self.z1[ch] = self.b1 * x - self.a1 * y + self.z2[ch];
        self.z2[ch] = self.b2 * x - self.a2 * y;
        y
    }

    fn reset(&mut self) {
        self.z1 = [0.0; 2];
        self.z2 = [0.0; 2];
    }
}

pub struct PeakLimiter {
    release_coef: f32,
    reduction: f32,
}

impl PeakLimiter {
    pub const CEILING: f32 = 0.985;
    const RELEASE_SECONDS: f64 = 0.1;

    pub fn new(sample_rate: u32) -> Self {
        let mut l = Self {
            release_coef: 1.0,
            reduction: 1.0,
        };
        l.configure(sample_rate);
        l
    }

    pub fn configure(&mut self, sample_rate: u32) {
        self.release_coef = if sample_rate == 0 {
            1.0
        } else {
            (1.0 - (-1.0 / (Self::RELEASE_SECONDS * sample_rate as f64)).exp()) as f32
        };
        self.reduction = 1.0;
    }

    pub fn reset(&mut self) {
        self.reduction = 1.0;
    }

    #[inline]
    pub fn gain_for(&mut self, peak: f32) -> f32 {
        let wanted = if peak > Self::CEILING {
            Self::CEILING / peak
        } else {
            1.0
        };
        self.reduction = if wanted < self.reduction {
            wanted
        } else {
            self.reduction + (wanted - self.reduction) * self.release_coef
        };
        self.reduction
    }
}

pub struct EqualizerProcessor {
    sections: [BiquadSection; SLOTS],
    preamp_linear: f32,
    limiter: PeakLimiter,
    sample_rate: u32,
    enabled: bool,
}

impl EqualizerProcessor {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sections: [BiquadSection::default(); SLOTS],
            preamp_linear: 1.0,
            limiter: PeakLimiter::new(sample_rate),
            sample_rate,
            enabled: false,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: u32, cfg: &EqConfig) {
        self.sample_rate = sample_rate;
        self.limiter.configure(sample_rate);
        self.apply_config(cfg);
    }

    pub fn apply_config(&mut self, cfg: &EqConfig) {
        self.enabled = cfg.enabled;
        let curve = EqCurve::from_config(cfg);
        self.preamp_linear = 10.0f32.powf(curve.preamp_db / 20.0);
        for (i, slot) in EQ_SLOTS.iter().enumerate() {
            self.sections[i].configure(
                *slot,
                curve.gains_db[i],
                curve.qs[i],
                self.sample_rate as f64,
            );
        }
    }

    pub fn reset(&mut self) {
        for s in &mut self.sections {
            s.reset();
        }
        self.limiter.reset();
    }

    pub fn process_stereo_interleaved(&mut self, samples: &mut [f32]) {
        if !self.enabled {
            return;
        }
        for frame in samples.chunks_exact_mut(2) {
            let mut l = (frame[0] * self.preamp_linear) as f64;
            let mut r = (frame[1] * self.preamp_linear) as f64;
            for sec in &mut self.sections {
                if sec.active {
                    l = sec.tick(0, l);
                    r = sec.tick(1, r);
                }
            }
            let lf = l as f32;
            let rf = r as f32;
            let gain = self.limiter.gain_for(lf.abs().max(rf.abs()));
            frame[0] = lf * gain;
            frame[1] = rf * gain;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bass_boost_applies_half_peak_preamp_attenuation() {
        let bands = EqualizerPreset::BassBoost.bands_db().unwrap();
        let curve = manual_curve(&bands);
        assert!(curve.preamp_db < -2.5 && curve.preamp_db > -6.0);
        assert_eq!(EqualizerPreset::matching(&bands), EqualizerPreset::BassBoost);
    }

    #[test]
    fn peak_limiter_caps_overs_to_ceiling() {
        let mut limiter = PeakLimiter::new(48_000);
        let gain = limiter.gain_for(2.0);
        assert!((2.0 * gain - PeakLimiter::CEILING).abs() < 1e-4);
    }
}
