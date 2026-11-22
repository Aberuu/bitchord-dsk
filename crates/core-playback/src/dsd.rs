use anyhow::{anyhow, Result};
use std::f64::consts::PI;

pub const DSD_PCM_DECIMATION_RATE: u32 = 176_400;
pub const DSD_LOWPASS_CUTOFF_HZ: f64 = 48_000.0;
const SUPPORTED_RATES: &[u32] = &[2_822_400, 5_644_800, 11_289_600, 22_579_200, 45_158_400];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DsdContainer {
    Dsf,
    Dff,
}

#[derive(Debug, Clone)]
pub struct DsdFormat {
    pub container: DsdContainer,
    pub bit_rate: u32,
    pub channels: u32,
    pub sample_count: u64,
    pub data_offset: u64,
    pub data_bytes: u64,
    pub lsb_first: bool,
    pub block_bytes: u32,
}

impl DsdFormat {
    pub fn parse_dsf(header_40: &[u8], data_offset: u64, data_bytes: u64) -> Result<Self> {
        if header_40.len() < 40 {
            return Err(anyhow!("Incomplete DSF fmt chunk"));
        }
        let version = u32::from_le_bytes(header_40[0..4].try_into()?);
        let format_id = u32::from_le_bytes(header_40[4..8].try_into()?);
        let channel_type = u32::from_le_bytes(header_40[8..12].try_into()?);
        let channels = u32::from_le_bytes(header_40[12..16].try_into()?);
        let bit_rate = u32::from_le_bytes(header_40[16..20].try_into()?);
        let bits_per_sample = u32::from_le_bytes(header_40[20..24].try_into()?);
        let sample_count = u64::from_le_bytes(header_40[24..32].try_into()?);
        let block_bytes = u32::from_le_bytes(header_40[32..36].try_into()?);
        let reserved = u32::from_le_bytes(header_40[36..40].try_into()?);

        if version != 1 || format_id != 0 || reserved != 0 {
            return Err(anyhow!("Unsupported DSF header fields"));
        }
        if channel_type != channels || !(1..=2).contains(&channels) {
            return Err(anyhow!("Only mono or stereo DSF is supported"));
        }
        if !SUPPORTED_RATES.contains(&bit_rate) {
            return Err(anyhow!("Unsupported DSD bit rate: {bit_rate}"));
        }
        if bits_per_sample != 1 && bits_per_sample != 8 {
            return Err(anyhow!("Invalid DSF bit order"));
        }
        if block_bytes != 4096 {
            return Err(anyhow!("Unsupported DSF block size: {block_bytes}"));
        }
        Ok(Self {
            container: DsdContainer::Dsf,
            bit_rate,
            channels,
            sample_count,
            data_offset,
            data_bytes,
            lsb_first: bits_per_sample == 1,
            block_bytes,
        })
    }

    pub fn dop_pcm_rate(&self) -> Option<u32> {
        match self.bit_rate {
            2_822_400 => Some(176_400),
            5_644_800 => Some(352_800),
            11_289_600 => Some(705_600),
            _ => None,
        }
    }

    pub fn filter_taps(&self) -> usize {
        512 * (self.bit_rate as usize / 2_822_400)
    }
}

pub fn dsd_decimation_coefficients(bit_rate: u32) -> Vec<f64> {
    let taps = 512 * (bit_rate as usize / 2_822_400).max(1);
    let cutoff = DSD_LOWPASS_CUTOFF_HZ / bit_rate as f64;
    let mut coeffs: Vec<f64> = (0..taps)
        .map(|i| {
            let x = i as f64 - (taps - 1) as f64 / 2.0;
            let sinc = if x.abs() < 1e-9 {
                2.0 * cutoff
            } else {
                (2.0 * PI * cutoff * x).sin() / (PI * x)
            };
            let w = 0.42
                - 0.5 * (2.0 * PI * i as f64 / (taps - 1) as f64).cos()
                + 0.08 * (4.0 * PI * i as f64 / (taps - 1) as f64).cos();
            sinc * w
        })
        .collect();
    let sum: f64 = coeffs.iter().sum();
    if sum.abs() > 1e-12 {
        for c in &mut coeffs {
            *c /= sum;
        }
    }
    coeffs
}

// Packs pairs of stereo DSD bytes into 24-bit DoP PCM frames alternating 0x05 and 0xFA markers.
pub struct DopPacker {
    marker_toggle: bool,
}

impl DopPacker {
    pub fn new() -> Self {
        Self {
            marker_toggle: false,
        }
    }

    pub fn pack_stereo_24le(&mut self, left_dsd: &[u8], right_dsd: &[u8], out: &mut Vec<u8>) {
        let pairs = left_dsd.len().min(right_dsd.len()) / 2;
        out.reserve(pairs * 6);
        for i in 0..pairs {
            let marker = if self.marker_toggle { 0xFAu8 } else { 0x05u8 };
            self.marker_toggle = !self.marker_toggle;
            // DoP v1.1 places marker in MSB, older DSD byte in middle byte, newer in LSB.
            out.push(left_dsd[i * 2 + 1]);
            out.push(left_dsd[i * 2]);
            out.push(marker);
            out.push(right_dsd[i * 2 + 1]);
            out.push(right_dsd[i * 2]);
            out.push(marker);
        }
    }
}

impl Default for DopPacker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dop_packer_alternates_0x05_and_0xfa_markers() {
        let mut packer = DopPacker::new();
        let left = [0xAA, 0xBB, 0xCC, 0xDD];
        let right = [0x11, 0x22, 0x33, 0x44];
        let mut out = Vec::new();
        packer.pack_stereo_24le(&left, &right, &mut out);
        assert_eq!(out, vec![0xBB, 0xAA, 0x05, 0x22, 0x11, 0x05, 0xDD, 0xCC, 0xFA, 0x44, 0x33, 0xFA]);
    }

    #[test]
    fn dsd_decimation_filter_sums_to_unity() {
        let coeffs = dsd_decimation_coefficients(2_822_400);
        assert_eq!(coeffs.len(), 512);
        let sum: f64 = coeffs.iter().sum();
        assert!((sum - 1.0).abs() < 1e-6);
    }
}
