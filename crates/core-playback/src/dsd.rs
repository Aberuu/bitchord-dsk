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

    pub fn dsd_label(&self) -> &'static str {
        match self.bit_rate {
            2_822_400 => "DSD64",
            5_644_800 => "DSD128",
            11_289_600 => "DSD256",
            22_579_200 => "DSD512",
            45_158_400 => "DSD1024",
            _ => "DSD",
        }
    }
}

#[derive(Debug, Clone)]
pub struct RawDsdStream {
    pub bit_rate: u32,
    pub lsb_first: bool,
    pub left_bytes: Vec<u8>,
    pub right_bytes: Vec<u8>,
    pub duration_sec: f64,
    pub label: String,
}

pub fn reverse_bits_u8(byte: u8) -> u8 {
    byte.reverse_bits()
}

/// Parses a complete DSF file buffer into separated stereo 1-bit DSD byte planes.
pub fn parse_dsf_bytes(bytes: &[u8]) -> Result<RawDsdStream> {
    if bytes.len() < 92 || &bytes[0..4] != b"DSD " {
        return Err(anyhow!("Not a valid DSF container"));
    }
    let dsd_chunk_size = u64::from_le_bytes(bytes[4..12].try_into()?) as usize;
    if dsd_chunk_size < 28 || bytes.len() < dsd_chunk_size + 52 {
        return Err(anyhow!("Truncated DSF header"));
    }
    let fmt_offset = dsd_chunk_size;
    if &bytes[fmt_offset..fmt_offset + 4] != b"fmt " {
        return Err(anyhow!("Missing DSF fmt chunk"));
    }
    let fmt_size = u64::from_le_bytes(bytes[fmt_offset + 4..fmt_offset + 12].try_into()?) as usize;
    if fmt_size < 52 || bytes.len() < fmt_offset + fmt_size + 12 {
        return Err(anyhow!("Truncated DSF fmt chunk"));
    }
    let data_chunk_offset = fmt_offset + fmt_size;
    if &bytes[data_chunk_offset..data_chunk_offset + 4] != b"data" {
        return Err(anyhow!("Missing DSF data chunk"));
    }
    let data_chunk_size =
        u64::from_le_bytes(bytes[data_chunk_offset + 4..data_chunk_offset + 12].try_into()?);
    let data_start = data_chunk_offset + 12;
    let payload_len = data_chunk_size.saturating_sub(12) as usize;
    let avail = bytes.len().saturating_sub(data_start).min(payload_len);

    let fmt = DsdFormat::parse_dsf(
        &bytes[fmt_offset + 12..fmt_offset + 52],
        data_start as u64,
        avail as u64,
    )?;

    let block = fmt.block_bytes as usize;
    let channels = fmt.channels as usize;
    let group = block * channels;
    let data = &bytes[data_start..data_start + avail];
    let total_bytes_per_ch = ((fmt.sample_count + 7) / 8) as usize;
    let mut left = Vec::with_capacity(total_bytes_per_ch);
    let mut right = Vec::with_capacity(total_bytes_per_ch);

    for chunk in data.chunks(group) {
        if channels == 1 {
            left.extend_from_slice(chunk);
            right.extend_from_slice(chunk);
        } else if chunk.len() >= group {
            left.extend_from_slice(&chunk[0..block]);
            right.extend_from_slice(&chunk[block..block * 2]);
        }
    }

    if total_bytes_per_ch > 0 {
        left.truncate(total_bytes_per_ch);
        right.truncate(total_bytes_per_ch);
    }
    let len = left.len().min(right.len());
    left.truncate(len);
    right.truncate(len);
    let duration_sec = (len as f64 * 8.0) / fmt.bit_rate.max(1) as f64;

    Ok(RawDsdStream {
        bit_rate: fmt.bit_rate,
        lsb_first: fmt.lsb_first,
        left_bytes: left,
        right_bytes: right,
        duration_sec,
        label: fmt.dsd_label().to_string(),
    })
}

/// Decimates a 1-bit stereo DSD stream into 176.4 kHz stereo f32 PCM for WASAPI/PCM fallback.
pub fn decimate_dsd_to_pcm_f32(stream: &RawDsdStream) -> (Vec<f32>, u32) {
    let out_rate = DSD_PCM_DECIMATION_RATE;
    let ratio = (stream.bit_rate / out_rate).max(8) as usize;
    let total_bits = stream.left_bytes.len().min(stream.right_bytes.len()) * 8;
    let out_frames = total_bits / ratio;
    let mut pcm = Vec::with_capacity(out_frames * 2);
    let inv = 1.0f32 / ratio as f32;

    for frame in 0..out_frames {
        let start_bit = frame * ratio;
        let mut acc_l = 0.0f32;
        let mut acc_r = 0.0f32;
        for b in 0..ratio {
            let bit_idx = start_bit + b;
            let byte_idx = bit_idx >> 3;
            let bit_pos = if stream.lsb_first {
                bit_idx & 7
            } else {
                7 - (bit_idx & 7)
            };
            let bl = (stream.left_bytes[byte_idx] >> bit_pos) & 1;
            let br = (stream.right_bytes[byte_idx] >> bit_pos) & 1;
            acc_l += if bl != 0 { 1.0 } else { -1.0 };
            acc_r += if br != 0 { 1.0 } else { -1.0 };
        }
        // Apply -6 dB headroom standard for DSD-to-PCM conversion.
        pcm.push(acc_l * inv * 0.5);
        pcm.push(acc_r * inv * 0.5);
    }
    (pcm, out_rate)
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
