use crate::automix_ffi::TimeStretcher;
use crate::converter::DacFormatConverter;
use crate::decoder::{decode_file_to_stereo_f32, DecodedAudio};
use crate::eq::{EqConfig, EqCurve, EqualizerProcessor};
use crate::sink::{
    asio_available, find_cpal_device, list_output_devices, probe_wasapi_exclusive_format,
    AudioDeviceInfo, BitPerfectStatus, OutputMode,
};
use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSettings {
    pub output_mode: OutputMode,
    pub device_id: Option<String>,
    pub playback_rate: f32,
    pub sleep_timer_end_epoch_ms: Option<u64>,
    pub sleep_after_track: bool,
    pub eq: EqConfig,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            output_mode: OutputMode::Shared,
            device_id: None,
            playback_rate: 1.0,
            sleep_timer_end_epoch_ms: None,
            sleep_after_track: false,
            eq: EqConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePlaybackSnapshot {
    pub active: bool,
    pub status: String,
    pub track_id: Option<String>,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub volume: f32,
    pub playback_rate: f32,
    pub codec: Option<String>,
    pub sample_rate_hz: u32,
    pub bit_depth: u32,
    pub channels: usize,
    pub bit_perfect: BitPerfectStatus,
    pub asio_available: bool,
    pub eq_curve_points: Vec<(f32, f32)>,
    pub settings: AudioSettings,
}

struct ActiveTrack {
    id: String,
    audio: Arc<DecodedAudio>,
    frame_cursor: f64,
    next_audio: Option<(String, Arc<DecodedAudio>)>,
}

struct SharedState {
    settings: AudioSettings,
    status: String,
    volume: f32,
    muted: bool,
    track: Option<ActiveTrack>,
    bit_perfect: BitPerfectStatus,
    eq_dirty: bool,
    crossfade_sec: f32,
}

pub struct NativeAudioEngine {
    shared: Arc<Mutex<SharedState>>,
    stop_flag: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    on_ended: Arc<dyn Fn(String) + Send + Sync>,
}

impl NativeAudioEngine {
    pub fn new(on_ended: Arc<dyn Fn(String) + Send + Sync>) -> Self {
        let shared = Arc::new(Mutex::new(SharedState {
            settings: AudioSettings::default(),
            status: "idle".into(),
            volume: 1.0,
            muted: false,
            track: None,
            bit_perfect: BitPerfectStatus::default(),
            eq_dirty: true,
            crossfade_sec: 0.0,
        }));
        Self {
            shared,
            stop_flag: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
            on_ended,
        }
    }

    pub fn devices(&self) -> Vec<AudioDeviceInfo> {
        list_output_devices()
    }

    pub fn snapshot(&self) -> NativePlaybackSnapshot {
        let guard = self.shared.lock();
        let (track_id, pos, dur, codec, sr, bits, ch) = match &guard.track {
            Some(t) => (
                Some(t.id.clone()),
                t.frame_cursor / t.audio.sample_rate_hz.max(1) as f64,
                t.audio.duration_sec,
                Some(t.audio.codec.clone()),
                t.audio.sample_rate_hz,
                t.audio.bit_depth,
                t.audio.channels,
            ),
            None => (None, 0.0, 0.0, None, 0, 0, 0),
        };
        let eq_curve = EqCurve::from_config(&guard.settings.eq).response_points();
        NativePlaybackSnapshot {
            active: guard.track.is_some(),
            status: guard.status.clone(),
            track_id,
            position_sec: pos,
            duration_sec: dur,
            volume: if guard.muted { 0.0 } else { guard.volume },
            playback_rate: guard.settings.playback_rate,
            codec,
            sample_rate_hz: sr,
            bit_depth: bits,
            channels: ch,
            bit_perfect: guard.bit_perfect.clone(),
            asio_available: asio_available(),
            eq_curve_points: eq_curve,
            settings: guard.settings.clone(),
        }
    }

    pub fn update_settings(&self, settings: AudioSettings) -> NativePlaybackSnapshot {
        let mut guard = self.shared.lock();
        guard.settings = AudioSettings {
            playback_rate: settings.playback_rate.clamp(0.5, 2.0),
            ..settings
        };
        guard.eq_dirty = true;
        drop(guard);
        self.snapshot()
    }

    pub fn set_volume(&self, volume: f32, muted: bool) {
        let mut guard = self.shared.lock();
        guard.volume = volume.clamp(0.0, 1.0);
        guard.muted = muted;
    }

    pub fn set_crossfade(&self, seconds: f32) {
        self.shared.lock().crossfade_sec = seconds.clamp(0.0, 12.0);
    }

    pub fn pause(&self) {
        let mut guard = self.shared.lock();
        if guard.status == "playing" {
            guard.status = "paused".into();
        }
    }

    pub fn resume(&self) {
        let mut guard = self.shared.lock();
        if guard.track.is_some() {
            guard.status = "playing".into();
        }
    }

    pub fn seek(&self, seconds: f64) {
        let mut guard = self.shared.lock();
        if let Some(t) = guard.track.as_mut() {
            let max_frames = (t.audio.samples_stereo_f32.len() / 2) as f64;
            t.frame_cursor = (seconds.max(0.0) * t.audio.sample_rate_hz as f64).min(max_frames);
        }
    }

    pub fn stop(&self) {
        self.stop_worker();
        let mut guard = self.shared.lock();
        guard.track = None;
        guard.status = "idle".into();
        guard.bit_perfect = BitPerfectStatus::default();
    }

    pub fn queue_gapless_next(&self, track_id: String, path: PathBuf) -> Result<()> {
        let decoded = Arc::new(decode_file_to_stereo_f32(&path)?);
        let mut guard = self.shared.lock();
        if let Some(t) = guard.track.as_mut() {
            t.next_audio = Some((track_id, decoded));
        }
        Ok(())
    }

    pub fn play_local_file(&self, track_id: String, path: PathBuf) -> Result<NativePlaybackSnapshot> {
        let decoded = Arc::new(decode_file_to_stereo_f32(&path)?);
        self.stop_worker();

        let (mode, device_id) = {
            let mut guard = self.shared.lock();
            guard.track = Some(ActiveTrack {
                id: track_id,
                audio: Arc::clone(&decoded),
                frame_cursor: 0.0,
                next_audio: None,
            });
            guard.status = "playing".into();
            guard.eq_dirty = true;
            (guard.settings.output_mode, guard.settings.device_id.clone())
        };

        self.stop_flag.store(false, Ordering::SeqCst);
        let shared = Arc::clone(&self.shared);
        let stop_flag = Arc::clone(&self.stop_flag);
        let on_ended = Arc::clone(&self.on_ended);

        let handle = thread::Builder::new()
            .name("bitchord-audio-out".into())
            .spawn(move || {
                if mode == OutputMode::WasapiExclusive {
                    match run_wasapi_exclusive_loop(
                        device_id.as_deref(),
                        decoded.sample_rate_hz,
                        decoded.bit_depth,
                        Arc::clone(&shared),
                        Arc::clone(&stop_flag),
                        Arc::clone(&on_ended),
                    ) {
                        Ok(()) => return,
                        Err(err) => {
                            let mut guard = shared.lock();
                            guard.bit_perfect = BitPerfectStatus {
                                active: false,
                                driver: Some("WASAPI Shared".into()),
                                device_name: None,
                                sample_rate_hz: decoded.sample_rate_hz,
                                output_bits: 32,
                                source_bits: decoded.bit_depth,
                                source_rate_hz: decoded.sample_rate_hz,
                                exact: false,
                                dac_limited: false,
                                fallback_reason: Some(err.to_string()),
                            };
                        }
                    }
                }
                if let Err(err) = run_cpal_shared_loop(
                    device_id.as_deref(),
                    Arc::clone(&shared),
                    stop_flag,
                    on_ended,
                ) {
                    tracing::error!("Shared audio output failed: {err}");
                    shared.lock().status = "error".into();
                }
            })?;

        *self.worker.lock() = Some(handle);
        Ok(self.snapshot())
    }

    fn stop_worker(&self) {
        self.stop_flag.store(true, Ordering::SeqCst);
        if let Some(handle) = self.worker.lock().take() {
            let _ = handle.join();
        }
    }
}

impl Drop for NativeAudioEngine {
    fn drop(&mut self) {
        self.stop_worker();
    }
}

fn render_next_block(
    shared: &Arc<Mutex<SharedState>>,
    out_stereo: &mut [f32],
    output_rate: u32,
    eq: &mut EqualizerProcessor,
    stretcher: &mut TimeStretcher,
    bypass_dsp: bool,
    on_ended: &Arc<dyn Fn(String) + Send + Sync>,
) {
    out_stereo.fill(0.0);
    let mut finished_track_id: Option<String> = None;
    let out_frames = out_stereo.len() / 2;

    let (playing, rate, vol, eq_cfg, eq_dirty) = {
        let mut guard = shared.lock();
        let dirty = guard.eq_dirty;
        guard.eq_dirty = false;
        let playing = guard.status == "playing";
        let vol = if guard.muted { 0.0 } else { guard.volume };
        (
            playing,
            guard.settings.playback_rate,
            vol,
            guard.settings.eq.clone(),
            dirty,
        )
    };

    if eq_dirty {
        eq.set_sample_rate(output_rate, &eq_cfg);
    }
    if !playing {
        return;
    }

    let mut scratch = Vec::new();
    {
        let mut guard = shared.lock();
        let Some(track) = guard.track.as_mut() else {
            return;
        };
        let src_rate = track.audio.sample_rate_hz.max(1) as f64;
        let samples = &track.audio.samples_stereo_f32;
        let total_frames = samples.len() / 2;

        if !bypass_dsp && (rate - 1.0).abs() > 0.01 {
            let in_frames = ((out_frames as f64 * rate as f64 * (src_rate / output_rate as f64))
                .round() as usize)
                .max(1);
            scratch.resize(in_frames * 2, 0.0);
            for i in 0..in_frames {
                let idx = track.frame_cursor as usize;
                if idx < total_frames {
                    scratch[i * 2] = samples[idx * 2];
                    scratch[i * 2 + 1] = samples[idx * 2 + 1];
                    track.frame_cursor += 1.0;
                } else {
                    break;
                }
            }
            stretcher.process_stereo(&scratch, out_stereo);
        } else {
            let step = src_rate / output_rate.max(1) as f64;
            for i in 0..out_frames {
                let idx = track.frame_cursor as usize;
                if idx < total_frames {
                    let frac = (track.frame_cursor - idx as f64) as f32;
                    let next_idx = (idx + 1).min(total_frames.saturating_sub(1));
                    let l0 = samples[idx * 2];
                    let r0 = samples[idx * 2 + 1];
                    let l1 = samples[next_idx * 2];
                    let r1 = samples[next_idx * 2 + 1];
                    out_stereo[i * 2] = l0 + (l1 - l0) * frac;
                    out_stereo[i * 2 + 1] = r0 + (r1 - r0) * frac;
                    track.frame_cursor += step;
                } else if let Some((next_id, next_audio)) = track.next_audio.take() {
                    // Sample-accurate gapless transition onto the pre-decoded next track.
                    track.id = next_id;
                    track.audio = next_audio;
                    track.frame_cursor = 0.0;
                    break;
                } else {
                    finished_track_id = Some(track.id.clone());
                    guard.status = "idle".into();
                    break;
                }
            }
        }
    }

    if !bypass_dsp {
        eq.process_stereo_interleaved(out_stereo);
        for s in out_stereo.iter_mut() {
            *s *= vol;
        }
    }

    if let Some(id) = finished_track_id {
        on_ended(id);
    }
}

fn run_cpal_shared_loop(
    device_id: Option<&str>,
    shared: Arc<Mutex<SharedState>>,
    stop_flag: Arc<AtomicBool>,
    on_ended: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<()> {
    let (device, device_name) = find_cpal_device(device_id)?;
    let default_cfg = device.default_output_config()?;
    let output_rate = default_cfg.sample_rate().0;
    let out_channels = default_cfg.channels() as usize;

    {
        let mut guard = shared.lock();
        let (src_rate, src_bits) = guard
            .track
            .as_ref()
            .map(|t| (t.audio.sample_rate_hz, t.audio.bit_depth))
            .unwrap_or((output_rate, 16));
        guard.bit_perfect = BitPerfectStatus {
            active: false,
            driver: Some("WASAPI Shared".into()),
            device_name: Some(device_name),
            sample_rate_hz: output_rate,
            output_bits: 32,
            source_bits: src_bits,
            source_rate_hz: src_rate,
            exact: false,
            dac_limited: false,
            fallback_reason: guard.bit_perfect.fallback_reason.clone(),
        };
    }

    let eq = Arc::new(Mutex::new(EqualizerProcessor::new(output_rate)));
    let stretcher = Arc::new(Mutex::new(TimeStretcher::new(output_rate)));
    let shared_cb = Arc::clone(&shared);
    let ended_cb = Arc::clone(&on_ended);

    let stream = device.build_output_stream(
        &default_cfg.into(),
        move |data: &mut [f32], _| {
            let frames = data.len() / out_channels.max(1);
            let mut stereo = vec![0.0f32; frames * 2];
            {
                let mut eq_guard = eq.lock();
                let mut st_guard = stretcher.lock();
                render_next_block(
                    &shared_cb,
                    &mut stereo,
                    output_rate,
                    &mut eq_guard,
                    &mut st_guard,
                    false,
                    &ended_cb,
                );
            }
            for f in 0..frames {
                let l = stereo[f * 2];
                let r = stereo[f * 2 + 1];
                for ch in 0..out_channels {
                    data[f * out_channels + ch] = if ch == 0 { l } else if ch == 1 { r } else { 0.0 };
                }
            }
        },
        |err| tracing::warn!("cpal output stream error: {err}"),
        None,
    )?;

    stream.play()?;
    while !stop_flag.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

#[cfg(windows)]
fn run_wasapi_exclusive_loop(
    device_id: Option<&str>,
    source_rate_hz: u32,
    source_bits: u32,
    shared: Arc<Mutex<SharedState>>,
    stop_flag: Arc<AtomicBool>,
    on_ended: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<()> {
    use std::collections::VecDeque;
    use wasapi::{
        get_default_device, DeviceCollection, Direction, SampleType, ShareMode, WaveFormat,
    };

    let (out_rate, valid_bits, container_bits, exact, friendly) =
        probe_wasapi_exclusive_format(device_id, source_rate_hz, source_bits, 2)?;

    let _ = wasapi::initialize_mta();
    let device = if let Some(wanted) = device_id {
        let wanted_clean = wanted.splitn(3, ':').nth(2).unwrap_or(wanted);
        DeviceCollection::new(&Direction::Render)
            .map_err(|e| anyhow!("{e}"))?
            .get_device_with_name(wanted_clean)
            .map_err(|e| anyhow!("WASAPI device disconnected: {e}"))?
    } else {
        get_default_device(&Direction::Render).map_err(|e| anyhow!("{e}"))?
    };

    let mut client = device.get_iaudioclient().map_err(|e| anyhow!("{e}"))?;
    let wave_fmt = WaveFormat::new(
        container_bits as usize,
        valid_bits as usize,
        &SampleType::Int,
        out_rate as usize,
        2,
        None,
    );
    let (_def_period, min_period) = client.get_periods().map_err(|e| anyhow!("{e}"))?;
    let period = min_period.max(100_000);
    client
        .initialize_client(&wave_fmt, period, &Direction::Render, &ShareMode::Exclusive, true)
        .map_err(|e| anyhow!("WASAPI Exclusive init failed: {e}"))?;

    let h_event = client.set_get_eventhandle().map_err(|e| anyhow!("{e}"))?;
    let render_client = client.get_audiorenderclient().map_err(|e| anyhow!("{e}"))?;
    let buffer_frames = client.get_bufferframecount().map_err(|e| anyhow!("{e}"))? as usize;

    {
        let mut guard = shared.lock();
        guard.bit_perfect = BitPerfectStatus {
            active: true,
            driver: Some("WASAPI Exclusive".into()),
            device_name: Some(friendly),
            sample_rate_hz: out_rate,
            output_bits: valid_bits,
            source_bits,
            source_rate_hz,
            exact,
            dac_limited: !exact,
            fallback_reason: None,
        };
    }

    let mut converter = DacFormatConverter::new(
        2,
        source_rate_hz,
        out_rate,
        valid_bits,
        container_bits,
    );
    let mut eq = EqualizerProcessor::new(source_rate_hz);
    let mut stretcher = TimeStretcher::new(source_rate_hz);
    let frame_bytes = (container_bits as usize / 8) * 2;
    let mut pending_bytes: VecDeque<u8> = VecDeque::new();
    let mut float_block = vec![0.0f32; buffer_frames.max(256) * 2];
    let mut pcm_scratch = Vec::new();

    client.start_stream().map_err(|e| anyhow!("{e}"))?;
    let mut last_event = Instant::now();
    while !stop_flag.load(Ordering::Relaxed) {
        if h_event.wait_for_event(100).is_err() && last_event.elapsed() > Duration::from_secs(2) {
            break;
        }
        last_event = Instant::now();
        let needed_bytes = buffer_frames * frame_bytes;
        while pending_bytes.len() < needed_bytes {
            // Bypass EQ/volume when bit-exact exclusive mode is active to keep PCM untouched.
            render_next_block(
                &shared,
                &mut float_block,
                source_rate_hz,
                &mut eq,
                &mut stretcher,
                exact,
                &on_ended,
            );
            pcm_scratch.clear();
            converter.process_f32_to_pcm_bytes(&float_block, &mut pcm_scratch);
            pending_bytes.extend(pcm_scratch.iter().copied());
            if pcm_scratch.is_empty() {
                pending_bytes.resize(needed_bytes, 0);
                break;
            }
        }
        if render_client
            .write_to_device_from_deque(buffer_frames, &mut pending_bytes, None)
            .is_err()
        {
            break;
        }
    }
    let _ = client.stop_stream();
    Ok(())
}

#[cfg(not(windows))]
fn run_wasapi_exclusive_loop(
    _device_id: Option<&str>,
    _source_rate_hz: u32,
    _source_bits: u32,
    _shared: Arc<Mutex<SharedState>>,
    _stop_flag: Arc<AtomicBool>,
    _on_ended: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<()> {
    Err(anyhow!("WASAPI Exclusive is Windows-only"))
}
