use rand::rngs::StdRng;
use rand::{Rng, SeedableRng};
use std::f64::consts::PI;

// Port of BitChord Android's DacFormatConverter.kt: windowed-sinc rational resampler + TPDF dither.
pub struct DacFormatConverter {
    channels: usize,
    resampler: Option<SincResampler>,
    rng: StdRng,
    valid_bits: u32,
    container_bits: u32,
}

impl DacFormatConverter {
    pub fn new(
        channels: usize,
        input_rate: u32,
        output_rate: u32,
        valid_bits: u32,
        container_bits: u32,
    ) -> Self {
        let resampler = if input_rate != output_rate {
            Some(SincResampler::new(input_rate, output_rate, channels))
        } else {
            None
        };
        Self {
            channels,
            resampler,
            rng: StdRng::seed_from_u64(0),
            valid_bits,
            container_bits,
        }
    }

    pub fn process_f32_to_pcm_bytes(&mut self, input: &[f32], output: &mut Vec<u8>) {
        if self.resampler.is_none() {
            for frame in input.chunks_exact(self.channels) {
                self.write_frame_f32(frame, output);
            }
            return;
        }
        let mut pulled = vec![0.0f64; self.channels];
        for frame in input.chunks_exact(self.channels) {
            self.resampler.as_mut().unwrap().push(frame);
            while self.resampler.as_ref().unwrap().ready() {
                self.resampler.as_mut().unwrap().pull(&mut pulled);
                self.write_frame_f64(&pulled, output);
            }
        }
    }

    pub fn drain_to_pcm_bytes(&mut self, output: &mut Vec<u8>) {
        if self.resampler.is_none() {
            return;
        }
        let mut pulled = vec![0.0f64; self.channels];
        let silence = vec![0.0f32; self.channels];
        loop {
            let done = {
                let rs = self.resampler.as_mut().unwrap();
                if rs.drained() {
                    true
                } else {
                    while !rs.ready() {
                        rs.push(&silence);
                    }
                    rs.pull(&mut pulled);
                    false
                }
            };
            if done {
                break;
            }
            self.write_frame_f64(&pulled, output);
        }
    }

    fn write_frame_f32(&mut self, frame: &[f32], output: &mut Vec<u8>) {
        let scale = (1i64 << (self.valid_bits - 1)) as f64;
        let shift = 32 - self.valid_bits;
        for &s in frame {
            let sample = s as f64;
            // Digital silence remains exact zero so DACs that mute on zero stay quiet.
            let scaled = if sample == 0.0 {
                0.0
            } else {
                sample * scale + self.rng.random::<f64>() - self.rng.random::<f64>()
            };
            let rounded = (scaled + 0.5).floor().clamp(-scale, scale - 1.0) as i64;
            let shifted = (rounded << shift) as i32;
            put_pcm_sample(output, shifted, self.container_bits);
        }
    }

    fn write_frame_f64(&mut self, frame: &[f64], output: &mut Vec<u8>) {
        let scale = (1i64 << (self.valid_bits - 1)) as f64;
        let shift = 32 - self.valid_bits;
        for &sample in frame {
            let scaled = if sample == 0.0 {
                0.0
            } else {
                sample * scale + self.rng.random::<f64>() - self.rng.random::<f64>()
            };
            let rounded = (scaled + 0.5).floor().clamp(-scale, scale - 1.0) as i64;
            let shifted = (rounded << shift) as i32;
            put_pcm_sample(output, shifted, self.container_bits);
        }
    }
}

fn put_pcm_sample(out: &mut Vec<u8>, sample_msb32: i32, container_bits: u32) {
    match container_bits {
        16 => {
            let s16 = (sample_msb32 >> 16) as i16;
            out.extend_from_slice(&s16.to_le_bytes());
        }
        24 => {
            let b = sample_msb32.to_le_bytes();
            out.extend_from_slice(&b[1..4]);
        }
        _ => {
            out.extend_from_slice(&sample_msb32.to_le_bytes());
        }
    }
}

struct SincResampler {
    channels: usize,
    up: u64,
    down: u64,
    half_wing: usize,
    cutoff: f64,
    ring: Vec<f64>,
    ring_frames: usize,
    written: u64,
    out_index: u64,
    drain_target: Option<u64>,
}

impl SincResampler {
    fn new(input_rate: u32, output_rate: u32, channels: usize) -> Self {
        let d = gcd(input_rate as u64, output_rate as u64);
        let up = output_rate as u64 / d;
        let down = input_rate as u64 / d;
        let ratio = (output_rate as f64 / input_rate as f64).min(1.0);
        let half_wing = ((16.0 / ratio).ceil() as usize).clamp(16, 64);
        let ring_frames = (half_wing * 2 + 16).next_power_of_two();
        Self {
            channels,
            up,
            down,
            half_wing,
            cutoff: ratio * 0.92,
            ring: vec![0.0; ring_frames * channels],
            ring_frames,
            written: 0,
            out_index: 0,
            drain_target: None,
        }
    }

    fn push(&mut self, frame: &[f32]) {
        let slot = (self.written as usize) & (self.ring_frames - 1);
        for ch in 0..self.channels {
            self.ring[slot * self.channels + ch] = frame[ch] as f64;
        }
        self.written += 1;
    }

    fn center_input_frame(&self) -> f64 {
        (self.out_index as f64 * self.down as f64) / self.up as f64
    }

    fn ready(&self) -> bool {
        let needed = self.center_input_frame().floor() as u64 + self.half_wing as u64 + 1;
        self.written > needed
    }

    fn drained(&mut self) -> bool {
        let target = *self
            .drain_target
            .get_or_insert_with(|| (self.written * self.up + self.down - 1) / self.down);
        self.out_index >= target
    }

    fn pull(&mut self, dest: &mut [f64]) {
        dest.fill(0.0);
        let center = self.center_input_frame();
        let start = (center.floor() as i64) - self.half_wing as i64;
        let end = (center.floor() as i64) + self.half_wing as i64;
        let wing = self.half_wing as f64;
        let mut weight_sum = 0.0;

        for idx in start..=end {
            let x = idx as f64 - center;
            if x.abs() >= wing {
                continue;
            }
            let sinc = if x.abs() < 1e-9 {
                1.0
            } else {
                let px = PI * self.cutoff * x;
                px.sin() / px
            };
            let window = 0.42 + 0.5 * (PI * x / wing).cos() + 0.08 * (2.0 * PI * x / wing).cos();
            let w = sinc * window;
            weight_sum += w;
            if idx >= 0 && (idx as u64) < self.written {
                let slot = (idx as usize) & (self.ring_frames - 1);
                for ch in 0..self.channels {
                    dest[ch] += self.ring[slot * self.channels + ch] * w;
                }
            }
        }
        if weight_sum.abs() > 1e-9 {
            for val in dest.iter_mut() {
                *val /= weight_sum;
            }
        }
        self.out_index += 1;
    }
}

fn gcd(mut a: u64, mut b: u64) -> u64 {
    while b != 0 {
        let t = a % b;
        a = b;
        b = t;
    }
    a.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_stays_digital_zero_with_dither_enabled() {
        let mut conv = DacFormatConverter::new(2, 48_000, 48_000, 16, 16);
        let input = vec![0.0f32; 128];
        let mut out = Vec::new();
        conv.process_f32_to_pcm_bytes(&input, &mut out);
        assert_eq!(out.len(), 256);
        assert!(out.iter().all(|&b| b == 0));
    }

    #[test]
    fn resamples_96khz_to_48khz_with_expected_frame_ratio() {
        let mut conv = DacFormatConverter::new(2, 96_000, 48_000, 24, 24);
        let mut input = Vec::with_capacity(960 * 2);
        for i in 0..960 {
            let v = (2.0 * PI * 1000.0 * i as f64 / 96_000.0).sin() as f32 * 0.5;
            input.push(v);
            input.push(v);
        }
        let mut out = Vec::new();
        conv.process_f32_to_pcm_bytes(&input, &mut out);
        conv.drain_to_pcm_bytes(&mut out);
        let out_frames = out.len() / 6;
        assert!((out_frames as i64 - 480).abs() <= 4);
    }
}
