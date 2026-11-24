use crate::dsd::{decimate_dsd_to_pcm_f32, parse_dsf_bytes, RawDsdStream};
use anyhow::{anyhow, Context, Result};
use std::fs::File;
use std::io::Cursor;
use std::path::Path;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

#[derive(Debug, Clone)]
pub struct DecodedAudio {
    pub samples_stereo_f32: Vec<f32>,
    pub sample_rate_hz: u32,
    pub bit_depth: u32,
    pub channels: usize,
    pub duration_sec: f64,
    pub codec: String,
    pub raw_dsd: Option<RawDsdStream>,
}

fn try_decode_dsf_bytes(bytes: &[u8]) -> Result<DecodedAudio> {
    let raw = parse_dsf_bytes(bytes)?;
    let (pcm, pcm_rate) = decimate_dsd_to_pcm_f32(&raw);
    let duration_sec = raw.duration_sec;
    let codec = raw.label.clone();
    Ok(DecodedAudio {
        samples_stereo_f32: pcm,
        sample_rate_hz: pcm_rate,
        bit_depth: 24,
        channels: 2,
        duration_sec,
        codec,
        raw_dsd: Some(raw),
    })
}

pub fn decode_file_to_stereo_f32(path: &Path) -> Result<DecodedAudio> {
    let ext = path.extension().and_then(|e| e.to_str());
    if ext.is_some_and(|e| e.eq_ignore_ascii_case("dsf")) {
        let bytes = std::fs::read(path).with_context(|| format!("read DSF file {}", path.display()))?;
        return try_decode_dsf_bytes(&bytes);
    }
    let file = File::open(path).with_context(|| format!("open audio file {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    decode_source_to_stereo_f32(mss, ext, &path.display().to_string())
}

pub fn decode_bytes_to_stereo_f32(
    bytes: Vec<u8>,
    ext: Option<&str>,
    label: &str,
) -> Result<DecodedAudio> {
    if ext.is_some_and(|e| e.eq_ignore_ascii_case("dsf")) || bytes.starts_with(b"DSD ") {
        return try_decode_dsf_bytes(&bytes);
    }
    let mss = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    decode_source_to_stereo_f32(mss, ext, label)
}

fn decode_source_to_stereo_f32(
    mss: MediaSourceStream,
    ext: Option<&str>,
    label: &str,
) -> Result<DecodedAudio> {
    let mut hint = Hint::new();
    if let Some(ext) = ext.filter(|s| !s.trim().is_empty()) {
        hint.with_extension(ext.trim().trim_start_matches('.'));
    }

    let probed = symphonia::default::get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .context("probe audio container")?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("No decodable audio track in {label}"))?;

    let track_id = track.id;
    let params = track.codec_params.clone();
    let sample_rate_hz = params.sample_rate.unwrap_or(48_000);
    let bit_depth = params.bits_per_sample.unwrap_or(16);
    let src_channels = params.channels.map(|c| c.count()).unwrap_or(2);
    let codec = format!("{:?}", params.codec);

    let mut decoder = symphonia::default::get_codecs()
        .make(&params, &DecoderOptions::default())
        .context("create symphonia decoder")?;

    let mut samples_stereo_f32 = Vec::new();
    let mut sample_buf: Option<SampleBuffer<f32>> = None;

    loop {
        let packet = match format.next_packet() {
            Ok(pkt) => pkt,
            Err(SymphoniaError::IoError(err))
                if err.kind() == std::io::ErrorKind::UnexpectedEof =>
            {
                break;
            }
            Err(SymphoniaError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => break,
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(_) => break,
        };
        let spec = *decoded.spec();
        let ch = spec.channels.count().max(1);
        let frames = decoded.frames();
        let buf = sample_buf.get_or_insert_with(|| SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
        if buf.capacity() < frames * ch {
            *buf = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
        }
        buf.copy_interleaved_ref(decoded);
        let interleaved = buf.samples();

        samples_stereo_f32.reserve(frames * 2);
        match ch {
            1 => {
                for &mono in interleaved {
                    samples_stereo_f32.push(mono);
                    samples_stereo_f32.push(mono);
                }
            }
            2 => {
                samples_stereo_f32.extend_from_slice(interleaved);
            }
            n => {
                for frame in interleaved.chunks_exact(n) {
                    samples_stereo_f32.push(frame[0]);
                    samples_stereo_f32.push(frame[1]);
                }
            }
        }
    }

    let total_frames = samples_stereo_f32.len() / 2;
    let duration_sec = total_frames as f64 / sample_rate_hz.max(1) as f64;
    Ok(DecodedAudio {
        samples_stereo_f32,
        sample_rate_hz,
        bit_depth,
        channels: src_channels,
        duration_sec,
        codec,
        raw_dsd: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_in_memory_wav_bytes_to_stereo_f32() {
        let mut wav = Vec::new();
        let sample_rate: u32 = 44_100;
        let channels: u16 = 2;
        let bits: u16 = 16;
        let num_frames: u32 = 64;
        let data_bytes = num_frames * channels as u32 * (bits as u32 / 8);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&(sample_rate * channels as u32 * (bits as u32 / 8)).to_le_bytes());
        wav.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
        wav.extend_from_slice(&bits.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        for i in 0..(num_frames * channels as u32) {
            let sample = ((i as i16).wrapping_mul(256)).to_le_bytes();
            wav.extend_from_slice(&sample);
        }

        let decoded = decode_bytes_to_stereo_f32(wav, Some("wav"), "mem:test.wav").unwrap();
        assert_eq!(decoded.sample_rate_hz, 44_100);
        assert_eq!(decoded.bit_depth, 16);
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.samples_stereo_f32.len(), (num_frames * 2) as usize);
    }
}
