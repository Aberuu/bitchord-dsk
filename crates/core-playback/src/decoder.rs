use anyhow::{anyhow, Context, Result};
use std::fs::File;
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
}

pub fn decode_file_to_stereo_f32(path: &Path) -> Result<DecodedAudio> {
    let file = File::open(path).with_context(|| format!("open audio file {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
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
        .ok_or_else(|| anyhow!("No decodable audio track in {}", path.display()))?;

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
    })
}
