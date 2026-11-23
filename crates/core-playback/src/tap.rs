use anyhow::Result;
use futures_util::StreamExt;
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::{Response as HttpResponse, StatusCode};
use tokio_tungstenite::tungstenite::Message;

const DEFAULT_SAMPLE_RATE_HZ: u32 = 48_000;
const TARGET_BUFFER_MS: usize = 55;
const PREBUFFER_MS: usize = 20;
const MAX_BUFFER_MS: usize = 220;

struct TapInner {
    samples: VecDeque<f32>,
    input_rate_hz: u32,
    primed: bool,
    phase: f64,
    prev_l: f32,
    prev_r: f32,
    cur_l: f32,
    cur_r: f32,
    generation: u64,
}

pub struct AudioTapBuffer {
    inner: Mutex<TapInner>,
}

impl Default for AudioTapBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioTapBuffer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(TapInner {
                samples: VecDeque::with_capacity(DEFAULT_SAMPLE_RATE_HZ as usize),
                input_rate_hz: DEFAULT_SAMPLE_RATE_HZ,
                primed: false,
                phase: 0.0,
                prev_l: 0.0,
                prev_r: 0.0,
                cur_l: 0.0,
                cur_r: 0.0,
                generation: 0,
            }),
        }
    }

    pub fn input_sample_rate_hz(&self) -> u32 {
        self.inner.lock().input_rate_hz
    }

    pub fn flush(&self) {
        let mut guard = self.inner.lock();
        guard.samples.clear();
        guard.primed = false;
        guard.phase = 0.0;
        guard.prev_l = 0.0;
        guard.prev_r = 0.0;
        guard.cur_l = 0.0;
        guard.cur_r = 0.0;
        guard.generation = guard.generation.wrapping_add(1);
    }

    pub fn push_stereo(&self, sample_rate_hz: u32, interleaved_stereo: &[f32]) {
        if interleaved_stereo.is_empty() {
            return;
        }
        let rate = sample_rate_hz.clamp(8_000, 384_000);
        let mut guard = self.inner.lock();
        if guard.input_rate_hz != rate {
            guard.samples.clear();
            guard.input_rate_hz = rate;
            guard.primed = false;
            guard.phase = 0.0;
        }

        let usable = interleaved_stereo.len() - (interleaved_stereo.len() % 2);
        guard.samples.extend(&interleaved_stereo[..usable]);

        let max_samples = ((rate as usize * MAX_BUFFER_MS) / 1000) * 2;
        if guard.samples.len() > max_samples {
            let keep_samples = ((rate as usize * (TARGET_BUFFER_MS + 25)) / 1000) * 2;
            let drop_count = (guard.samples.len() - keep_samples) & !1;
            guard.samples.drain(..drop_count);
        }
    }

    pub fn push_packet(&self, payload: &[u8]) {
        // Binary wire format: [u32le sample_rate_hz][u32le channels][f32le PCM samples...].
        if payload.len() < 8 {
            return;
        }
        let rate = u32::from_le_bytes(payload[0..4].try_into().unwrap());
        let channels = u32::from_le_bytes(payload[4..8].try_into().unwrap());
        let pcm_bytes = &payload[8..];
        let float_count = pcm_bytes.len() / 4;
        if float_count == 0 {
            return;
        }

        if channels == 1 {
            let mut stereo = Vec::with_capacity(float_count * 2);
            for chunk in pcm_bytes.chunks_exact(4) {
                let s = f32::from_le_bytes(chunk.try_into().unwrap());
                stereo.push(s);
                stereo.push(s);
            }
            self.push_stereo(rate, &stereo);
            return;
        }

        if channels == 2 {
            let frame_count = float_count / 2;
            let mut stereo = Vec::with_capacity(frame_count * 2);
            for chunk in pcm_bytes[..frame_count * 8].chunks_exact(4) {
                stereo.push(f32::from_le_bytes(chunk.try_into().unwrap()));
            }
            self.push_stereo(rate, &stereo);
        }
    }

    pub fn pop_resampled(&self, out_stereo: &mut [f32], output_rate_hz: u32) {
        out_stereo.fill(0.0);
        let out_frames = out_stereo.len() / 2;
        if out_frames == 0 {
            return;
        }

        let mut guard = self.inner.lock();
        let in_rate = guard.input_rate_hz.max(1);
        let prebuffer_frames = (in_rate as usize * PREBUFFER_MS) / 1000;
        let target_frames = (in_rate as usize * TARGET_BUFFER_MS) / 1000;

        if !guard.primed {
            if guard.samples.len() / 2 < prebuffer_frames {
                return;
            }
            guard.prev_l = guard.samples.pop_front().unwrap_or(0.0);
            guard.prev_r = guard.samples.pop_front().unwrap_or(0.0);
            guard.cur_l = guard.samples.pop_front().unwrap_or(guard.prev_l);
            guard.cur_r = guard.samples.pop_front().unwrap_or(guard.prev_r);
            guard.phase = 0.0;
            guard.primed = true;
        }

        let avail_frames = guard.samples.len() / 2;
        let drift_factor = if avail_frames > target_frames * 2 {
            1.002
        } else if avail_frames > 0 && avail_frames < target_frames / 2 {
            0.998
        } else {
            1.0
        };

        let step = (in_rate as f64 / output_rate_hz.max(1) as f64) * drift_factor;
        let exact_match = (step - 1.0).abs() < 1e-9 && guard.phase == 0.0;

        for i in 0..out_frames {
            if exact_match {
                if !guard.primed {
                    guard.prev_l *= 0.85;
                    guard.prev_r *= 0.85;
                    out_stereo[i * 2] = guard.prev_l;
                    out_stereo[i * 2 + 1] = guard.prev_r;
                    continue;
                }
                out_stereo[i * 2] = guard.prev_l;
                out_stereo[i * 2 + 1] = guard.prev_r;
                guard.prev_l = guard.cur_l;
                guard.prev_r = guard.cur_r;
                if let (Some(l), Some(r)) = (guard.samples.pop_front(), guard.samples.pop_front()) {
                    guard.cur_l = l;
                    guard.cur_r = r;
                } else {
                    guard.cur_l = 0.0;
                    guard.cur_r = 0.0;
                    guard.primed = false;
                }
                continue;
            }

            if !guard.primed {
                guard.prev_l *= 0.85;
                guard.prev_r *= 0.85;
                out_stereo[i * 2] = guard.prev_l;
                out_stereo[i * 2 + 1] = guard.prev_r;
                continue;
            }

            let t = guard.phase as f32;
            out_stereo[i * 2] = guard.prev_l + (guard.cur_l - guard.prev_l) * t;
            out_stereo[i * 2 + 1] = guard.prev_r + (guard.cur_r - guard.prev_r) * t;
            guard.phase += step;

            while guard.phase >= 1.0 {
                guard.phase -= 1.0;
                guard.prev_l = guard.cur_l;
                guard.prev_r = guard.cur_r;
                if let (Some(l), Some(r)) = (guard.samples.pop_front(), guard.samples.pop_front()) {
                    guard.cur_l = l;
                    guard.cur_r = r;
                } else {
                    guard.cur_l = 0.0;
                    guard.cur_r = 0.0;
                    guard.primed = false;
                    guard.phase = 0.0;
                    break;
                }
            }
        }
    }
}

pub struct AudioTapServer {
    ws_url: String,
    token: String,
}

impl AudioTapServer {
    pub async fn start(buffer: Arc<AudioTapBuffer>) -> Result<Self> {
        let token = format!("{:032x}", rand::random::<u128>());
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let port = listener.local_addr()?.port();
        let ws_url = format!("ws://127.0.0.1:{port}/{token}");
        let expected_path = format!("/{token}");

        tokio::spawn(async move {
            loop {
                let Ok((stream, _peer)) = listener.accept().await else {
                    break;
                };
                let buf = Arc::clone(&buffer);
                let path = expected_path.clone();
                tokio::spawn(async move {
                    let _ = handle_tap_socket(stream, buf, path).await;
                });
            }
        });

        Ok(Self { ws_url, token })
    }

    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

async fn handle_tap_socket(
    stream: TcpStream,
    buffer: Arc<AudioTapBuffer>,
    expected_path: String,
) -> Result<()> {
    let ws = tokio_tungstenite::accept_hdr_async(
        stream,
        |req: &Request, res: Response| -> std::result::Result<Response, ErrorResponse> {
            if req.uri().path() == expected_path {
                Ok(res)
            } else {
                let mut err = HttpResponse::new(Some("Unauthorized audio tap path".into()));
                *err.status_mut() = StatusCode::FORBIDDEN;
                Err(err)
            }
        },
    )
    .await?;

    buffer.flush();
    let (_, mut read) = ws.split();
    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Binary(bytes)) => buffer.push_packet(&bytes),
            Ok(Message::Text(text)) if text == "flush" => buffer.flush(),
            Ok(Message::Close(_)) => break,
            Err(_) => break,
            _ => {}
        }
    }
    buffer.flush();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tap_buffer_prebuffers_pushes_and_flushes_cleanly() {
        let buf = AudioTapBuffer::new();
        let one_chunk = vec![0.25f32; 512 * 2];
        // Under 20 ms prebuffer -> outputs silence until enough audio arrives.
        buf.push_stereo(48_000, &one_chunk);
        let mut out = vec![1.0f32; 128 * 2];
        buf.pop_resampled(&mut out, 48_000);
        assert!(out.iter().all(|&s| s == 0.0));

        // Pushing another chunk crosses 20 ms -> yields live PCM samples.
        buf.push_stereo(48_000, &one_chunk);
        buf.pop_resampled(&mut out, 48_000);
        assert!(out.iter().any(|&s| (s - 0.25).abs() < 1e-6));

        buf.flush();
        buf.pop_resampled(&mut out, 48_000);
        assert!(out.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn tap_buffer_resamples_48khz_to_96khz_and_decodes_binary_packet() {
        let buf = AudioTapBuffer::new();
        let mut packet = Vec::new();
        packet.extend_from_slice(&48_000u32.to_le_bytes());
        packet.extend_from_slice(&2u32.to_le_bytes());
        for _ in 0..1500 {
            packet.extend_from_slice(&0.5f32.to_le_bytes());
            packet.extend_from_slice(&(-0.5f32).to_le_bytes());
        }
        buf.push_packet(&packet);

        let mut out = vec![0.0f32; 256 * 2];
        buf.pop_resampled(&mut out, 96_000);
        assert!((out[4] - 0.5).abs() < 1e-4);
        assert!((out[5] + 0.5).abs() < 1e-4);
    }
}
