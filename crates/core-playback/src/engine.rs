use crate::automix_ffi::TimeStretcher;
use crate::converter::DacFormatConverter;
use crate::decoder::{decode_bytes_to_stereo_f32, decode_file_to_stereo_f32, DecodedAudio};
use crate::eq::{EqConfig, EqCurve, EqualizerProcessor};
use crate::sink::{
    asio_available, find_cpal_device, list_output_devices, probe_wasapi_exclusive_format,
    AudioDeviceInfo, BitPerfectStatus, OutputMode,
};
use crate::tap::AudioTapBuffer;
use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
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
    pub tap_active: bool,
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
    tap_active: bool,
    bit_perfect: BitPerfectStatus,
    eq_dirty: bool,
    crossfade_sec: f32,
}

struct WorkerHandle {
    stop: Arc<AtomicBool>,
    join: thread::JoinHandle<()>,
}

pub struct NativeAudioEngine {
    shared: Arc<Mutex<SharedState>>,
    tap: Arc<AudioTapBuffer>,
    route_lock: Mutex<()>,
    worker: Mutex<Option<WorkerHandle>>,
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
            tap_active: false,
            bit_perfect: BitPerfectStatus::default(),
            eq_dirty: true,
            crossfade_sec: 0.0,
        }));
        Self {
            shared,
            tap: Arc::new(AudioTapBuffer::new()),
            route_lock: Mutex::new(()),
            worker: Mutex::new(None),
            on_ended,
        }
    }

    pub fn tap_buffer(&self) -> Arc<AudioTapBuffer> {
        Arc::clone(&self.tap)
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
            None if guard.tap_active => (
                None,
                0.0,
                0.0,
                Some("PCM Tap".into()),
                self.tap.input_sample_rate_hz(),
                32,
                2,
            ),
            None => (None, 0.0, 0.0, None, 0, 0, 0),
        };
        let eq_curve = EqCurve::from_config(&guard.settings.eq).response_points();
        NativePlaybackSnapshot {
            active: guard.track.is_some(),
            tap_active: guard.tap_active,
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
        let _route = self.route_lock.lock();
        let next_settings = AudioSettings {
            playback_rate: settings.playback_rate.clamp(0.5, 2.0),
            ..settings
        };

        let (route_changed, has_local, tap_active, uses_default_shared) = {
            let mut guard = self.shared.lock();
            let changed = guard.settings.output_mode != next_settings.output_mode
                || guard.settings.device_id != next_settings.device_id;
            guard.settings = next_settings;
            guard.eq_dirty = true;
            if changed {
                guard.bit_perfect.fallback_reason = None;
            }
            let default_shared = guard.settings.device_id.is_none()
                && guard.settings.output_mode == OutputMode::Shared;
            (
                changed,
                guard.track.is_some(),
                guard.tap_active,
                default_shared,
            )
        };

        if tap_active && uses_default_shared {
            return self.stop_tap_mode_locked();
        }

        if route_changed && (has_local || tap_active) {
            self.stop_worker_locked();
            if let Err(err) = self.spawn_worker_for_active_source_locked() {
                tracing::error!("Failed to switch audio output route: {err}");
                let mut guard = self.shared.lock();
                guard.status = "error".into();
                guard.bit_perfect.fallback_reason = Some(err.to_string());
            }
        }

        self.snapshot()
    }

    pub fn handle_devices_changed(&self) {
        // Enumerate active endpoints outside route_lock so UI switch requests are not delayed behind MMDevAPI probing.
        let active_devices = list_output_devices();
        let _route = self.route_lock.lock();
        let current_device_id = self.shared.lock().settings.device_id.clone();

        if let Some(ref wanted_id) = current_device_id {
            let still_present = active_devices.iter().any(|d| &d.id == wanted_id);
            if !still_present {
                let (has_local, tap_active, mode) = {
                    let mut guard = self.shared.lock();
                    guard.settings.device_id = None;
                    guard.bit_perfect.fallback_reason =
                        Some("Selected output device disconnected; switched to Windows default".into());
                    (
                        guard.track.is_some(),
                        guard.tap_active,
                        guard.settings.output_mode,
                    )
                };
                if tap_active && mode == OutputMode::Shared {
                    let _ = self.stop_tap_mode_locked();
                } else if has_local || tap_active {
                    self.stop_worker_locked();
                    let _ = self.spawn_worker_for_active_source_locked();
                }
                return;
            }
        }

        // Follow OS default endpoint changes when playing via Windows Default Output.
        if current_device_id.is_none() {
            let (has_local, tap_active) = {
                let guard = self.shared.lock();
                (guard.track.is_some(), guard.tap_active)
            };
            if has_local || tap_active {
                self.stop_worker_locked();
                let _ = self.spawn_worker_for_active_source_locked();
            }
        }
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
        if guard.track.is_some() || guard.tap_active {
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
        let _route = self.route_lock.lock();
        self.stop_worker_locked();
        self.tap.flush();
        let mut guard = self.shared.lock();
        guard.track = None;
        guard.tap_active = false;
        guard.status = "idle".into();
        guard.bit_perfect = BitPerfectStatus::default();
    }

    pub fn start_tap_mode(&self) -> Result<NativePlaybackSnapshot> {
        let _route = self.route_lock.lock();
        // Drop the shared lock before querying worker liveness or reading snapshot() to avoid reentrant Mutex deadlock.
        let tap_active = self.shared.lock().tap_active;
        if tap_active && self.has_live_worker() {
            return Ok(self.snapshot());
        }

        self.stop_worker_locked();
        self.tap.flush();
        {
            let mut guard = self.shared.lock();
            guard.track = None;
            guard.tap_active = true;
            guard.status = "playing".into();
            guard.bit_perfect.fallback_reason = None;
        }
        self.spawn_worker_for_active_source_locked()?;
        Ok(self.snapshot())
    }

    pub fn stop_tap_mode(&self) -> NativePlaybackSnapshot {
        let _route = self.route_lock.lock();
        self.stop_tap_mode_locked()
    }

    fn stop_tap_mode_locked(&self) -> NativePlaybackSnapshot {
        let was_tap = self.shared.lock().tap_active;
        if was_tap {
            self.stop_worker_locked();
            self.tap.flush();
            let mut guard = self.shared.lock();
            guard.tap_active = false;
            if guard.track.is_none() {
                guard.status = "idle".into();
                guard.bit_perfect = BitPerfectStatus::default();
            }
        }
        self.snapshot()
    }

    pub fn flush_tap(&self) {
        self.tap.flush();
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
        self.play_decoded_audio(track_id, decoded)
    }

    pub fn play_encoded_bytes(
        &self,
        track_id: String,
        bytes: Vec<u8>,
        ext: Option<&str>,
    ) -> Result<NativePlaybackSnapshot> {
        let decoded = Arc::new(decode_bytes_to_stereo_f32(bytes, ext, &track_id)?);
        self.play_decoded_audio(track_id, decoded)
    }

    fn play_decoded_audio(
        &self,
        track_id: String,
        decoded: Arc<DecodedAudio>,
    ) -> Result<NativePlaybackSnapshot> {
        let _route = self.route_lock.lock();
        self.stop_worker_locked();
        self.tap.flush();

        {
            let mut guard = self.shared.lock();
            guard.tap_active = false;
            guard.track = Some(ActiveTrack {
                id: track_id,
                audio: Arc::clone(&decoded),
                frame_cursor: 0.0,
                next_audio: None,
            });
            guard.status = "playing".into();
            guard.eq_dirty = true;
            guard.bit_perfect.fallback_reason = None;
        }

        self.spawn_worker_for_active_source_locked()?;
        Ok(self.snapshot())
    }

    fn has_live_worker(&self) -> bool {
        self.worker
            .lock()
            .as_ref()
            .is_some_and(|w| !w.join.is_finished())
    }

    fn spawn_worker_for_active_source_locked(&self) -> Result<()> {
        let (mode, device_id, tap_source, source_rate_hz, source_bits) = {
            let guard = self.shared.lock();
            if guard.tap_active {
                (
                    guard.settings.output_mode,
                    guard.settings.device_id.clone(),
                    Some(Arc::clone(&self.tap)),
                    self.tap.input_sample_rate_hz(),
                    32,
                )
            } else if let Some(t) = guard.track.as_ref() {
                (
                    guard.settings.output_mode,
                    guard.settings.device_id.clone(),
                    None,
                    t.audio.sample_rate_hz,
                    t.audio.bit_depth,
                )
            } else {
                return Ok(());
            }
        };

        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop_flag);
        let shared = Arc::clone(&self.shared);
        let on_ended = Arc::clone(&self.on_ended);
        let (ready_tx, ready_rx) = mpsc::sync_channel::<()>(1);

        let handle = thread::Builder::new()
            .name("bitchord-audio-out".into())
            .spawn(move || {
                let mut ready = Some(ready_tx);
                if mode == OutputMode::WasapiExclusive {
                    match run_wasapi_exclusive_loop(
                        device_id.as_deref(),
                        source_rate_hz,
                        source_bits,
                        tap_source.clone(),
                        Arc::clone(&shared),
                        Arc::clone(&worker_stop),
                        Arc::clone(&on_ended),
                        &mut ready,
                    ) {
                        Ok(()) => return,
                        Err(err) => {
                            let mut guard = shared.lock();
                            guard.bit_perfect = BitPerfectStatus {
                                active: false,
                                driver: Some(if tap_source.is_some() {
                                    "WASAPI Shared Tap".into()
                                } else {
                                    "WASAPI Shared".into()
                                }),
                                device_name: None,
                                sample_rate_hz: source_rate_hz,
                                output_bits: 32,
                                source_bits,
                                source_rate_hz,
                                exact: false,
                                dac_limited: false,
                                fallback_reason: Some(err.to_string()),
                            };
                        }
                    }
                }
                if let Err(err) = run_cpal_shared_loop(
                    device_id.as_deref(),
                    tap_source,
                    Arc::clone(&shared),
                    worker_stop,
                    on_ended,
                    &mut ready,
                ) {
                    tracing::error!("Shared audio output failed: {err}");
                    let mut guard = shared.lock();
                    guard.status = "error".into();
                    guard.bit_perfect.fallback_reason = Some(err.to_string());
                }
                signal_ready(&mut ready);
            })?;

        *self.worker.lock() = Some(WorkerHandle {
            stop: stop_flag,
            join: handle,
        });
        // Briefly await endpoint format initialization so the returned snapshot matches the new device.
        let _ = ready_rx.recv_timeout(Duration::from_millis(650));
        Ok(())
    }

    fn stop_worker_locked(&self) {
        let entry = self.worker.lock().take();
        if let Some(worker) = entry {
            worker.stop.store(true, Ordering::SeqCst);
            let _ = worker.join.join();
        }
    }
}

impl Drop for NativeAudioEngine {
    fn drop(&mut self) {
        let _route = self.route_lock.lock();
        self.stop_worker_locked();
    }
}

fn signal_ready(ready_tx: &mut Option<mpsc::SyncSender<()>>) {
    if let Some(tx) = ready_tx.take() {
        let _ = tx.try_send(());
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
        } else if bypass_dsp && (src_rate - output_rate.max(1) as f64).abs() < 1e-6 {
            let mut idx = track.frame_cursor.round() as usize;
            for i in 0..out_frames {
                if idx < total_frames {
                    out_stereo[i * 2] = samples[idx * 2];
                    out_stereo[i * 2 + 1] = samples[idx * 2 + 1];
                    idx += 1;
                    track.frame_cursor = idx as f64;
                } else if let Some((next_id, next_audio)) = track.next_audio.take() {
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
    tap_source: Option<Arc<AudioTapBuffer>>,
    shared: Arc<Mutex<SharedState>>,
    stop_flag: Arc<AtomicBool>,
    on_ended: Arc<dyn Fn(String) + Send + Sync>,
    ready_tx: &mut Option<mpsc::SyncSender<()>>,
) -> Result<()> {
    let (device, device_name) = find_cpal_device(device_id)?;
    let default_cfg = device.default_output_config()?;
    let output_rate = default_cfg.sample_rate().0;
    let out_channels = default_cfg.channels() as usize;

    {
        let mut guard = shared.lock();
        let (src_rate, src_bits) = if let Some(ref tap) = tap_source {
            (tap.input_sample_rate_hz(), 32)
        } else {
            guard
                .track
                .as_ref()
                .map(|t| (t.audio.sample_rate_hz, t.audio.bit_depth))
                .unwrap_or((output_rate, 16))
        };
        guard.bit_perfect = BitPerfectStatus {
            active: false,
            driver: Some(if tap_source.is_some() {
                "WASAPI Shared Tap".into()
            } else {
                "WASAPI Shared".into()
            }),
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
    let stream_broken = Arc::new(AtomicBool::new(false));
    let stream_broken_cb = Arc::clone(&stream_broken);

    let stream = device.build_output_stream(
        &default_cfg.into(),
        move |data: &mut [f32], _| {
            let frames = data.len() / out_channels.max(1);
            let mut stereo = vec![0.0f32; frames * 2];
            if let Some(ref tap) = tap_source {
                tap.pop_resampled(&mut stereo, output_rate);
            } else {
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
                    data[f * out_channels + ch] = if ch == 0 {
                        l
                    } else if ch == 1 {
                        r
                    } else {
                        0.0
                    };
                }
            }
        },
        move |err| {
            tracing::warn!("cpal output stream error: {err}");
            stream_broken_cb.store(true, Ordering::Relaxed);
        },
        None,
    )?;

    stream.play()?;
    signal_ready(ready_tx);
    while !stop_flag.load(Ordering::Relaxed) && !stream_broken.load(Ordering::Relaxed) {
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

#[cfg(windows)]
fn initialize_exclusive_client(
    device: &wasapi::Device,
    wave_fmt: &wasapi::WaveFormat,
    sample_rate: u32,
) -> Result<wasapi::AudioClient> {
    use wasapi::{Direction, ShareMode, WasapiError};

    // AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED (0x88890019), commonly returned on HDAudio endpoints.
    const AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED: i32 = 0x8889_0019_u32 as i32;

    let mut client = device.get_iaudioclient().map_err(|e| anyhow!("{e}"))?;
    let (def_period, min_period) = client.get_periods().map_err(|e| anyhow!("{e}"))?;
    let desired_period = def_period.max(min_period).max(100_000);
    let aligned_period = client
        .calculate_aligned_period_near(desired_period, Some(128), wave_fmt)
        .unwrap_or(desired_period);

    match client.initialize_client(
        wave_fmt,
        aligned_period,
        &Direction::Render,
        &ShareMode::Exclusive,
        false,
    ) {
        Ok(()) => Ok(client),
        Err(WasapiError::Windows(win_err))
            if win_err.code().0 == AUDCLNT_E_BUFFER_SIZE_NOT_ALIGNED =>
        {
            let buffer_frames = client.get_bufferframecount().map_err(|e| anyhow!("{e}"))?;
            let exact_period =
                ((10_000_000.0 * buffer_frames as f64 / sample_rate.max(1) as f64) + 0.5) as i64;
            let mut retry_client = device.get_iaudioclient().map_err(|e| anyhow!("{e}"))?;
            retry_client
                .initialize_client(
                    wave_fmt,
                    exact_period,
                    &Direction::Render,
                    &ShareMode::Exclusive,
                    false,
                )
                .map_err(|e| anyhow!("WASAPI Exclusive init failed: {e}"))?;
            Ok(retry_client)
        }
        Err(err) => Err(anyhow!("WASAPI Exclusive init failed: {err}")),
    }
}

#[cfg(windows)]
fn run_wasapi_exclusive_loop(
    device_id: Option<&str>,
    source_rate_hz: u32,
    source_bits: u32,
    tap_source: Option<Arc<AudioTapBuffer>>,
    shared: Arc<Mutex<SharedState>>,
    stop_flag: Arc<AtomicBool>,
    on_ended: Arc<dyn Fn(String) + Send + Sync>,
    ready_tx: &mut Option<mpsc::SyncSender<()>>,
) -> Result<()> {
    use crate::sink::{open_wasapi_device, ComMtaGuard};
    use std::collections::VecDeque;
    use wasapi::{SampleType, WaveFormat};

    let _com = ComMtaGuard::acquire();
    let (out_rate, valid_bits, container_bits, exact, friendly) =
        probe_wasapi_exclusive_format(device_id, source_rate_hz, source_bits, 2)?;

    let device = open_wasapi_device(device_id)?;
    let wave_fmt = WaveFormat::new(
        container_bits as usize,
        valid_bits as usize,
        &SampleType::Int,
        out_rate as usize,
        2,
        None,
    );
    let client = initialize_exclusive_client(&device, &wave_fmt, out_rate)?;

    let h_event = client.set_get_eventhandle().map_err(|e| anyhow!("{e}"))?;
    let render_client = client.get_audiorenderclient().map_err(|e| anyhow!("{e}"))?;
    let buffer_frames = client.get_bufferframecount().map_err(|e| anyhow!("{e}"))? as usize;

    let is_tap = tap_source.is_some();
    {
        let mut guard = shared.lock();
        guard.bit_perfect = BitPerfectStatus {
            active: true,
            driver: Some(if is_tap {
                "WASAPI Exclusive Tap".into()
            } else {
                "WASAPI Exclusive".into()
            }),
            device_name: Some(friendly),
            sample_rate_hz: out_rate,
            output_bits: valid_bits,
            source_bits,
            source_rate_hz,
            exact: !is_tap && exact,
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

    // Prime one silent buffer so event-driven Exclusive drivers start signaling immediately.
    let initial_silence = vec![0u8; buffer_frames * frame_bytes];
    let _ = render_client.write_to_device(buffer_frames, &initial_silence, None);

    client.start_stream().map_err(|e| anyhow!("{e}"))?;
    signal_ready(ready_tx);
    let mut last_event = Instant::now();
    while !stop_flag.load(Ordering::Relaxed) {
        if h_event.wait_for_event(100).is_err() {
            if last_event.elapsed() > Duration::from_secs(2) {
                break;
            }
            continue;
        }
        last_event = Instant::now();
        let needed_bytes = buffer_frames * frame_bytes;
        while pending_bytes.len() < needed_bytes {
            if let Some(ref tap) = tap_source {
                tap.pop_resampled(&mut float_block, source_rate_hz);
            } else {
                render_next_block(
                    &shared,
                    &mut float_block,
                    source_rate_hz,
                    &mut eq,
                    &mut stretcher,
                    true,
                    &on_ended,
                );
            }
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
    _tap_source: Option<Arc<AudioTapBuffer>>,
    _shared: Arc<Mutex<SharedState>>,
    _stop_flag: Arc<AtomicBool>,
    _on_ended: Arc<dyn Fn(String) + Send + Sync>,
    _ready_tx: &mut Option<mpsc::SyncSender<()>>,
) -> Result<()> {
    Err(anyhow!("WASAPI Exclusive is Windows-only"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_settings_stops_tap_when_switching_back_to_default_shared() {
        let engine = NativeAudioEngine::new(Arc::new(|_| {}));
        {
            let mut guard = engine.shared.lock();
            guard.tap_active = true;
            guard.status = "playing".into();
            guard.settings.device_id = Some("wasapi_id:test".into());
        }
        let next = AudioSettings {
            output_mode: OutputMode::Shared,
            device_id: None,
            ..AudioSettings::default()
        };
        let snap = engine.update_settings(next);
        assert!(!snap.tap_active);
        assert_eq!(snap.status, "idle");
        assert!(snap.settings.device_id.is_none());
    }

    #[test]
    fn handle_devices_changed_clears_disconnected_selected_device() {
        let engine = NativeAudioEngine::new(Arc::new(|_| {}));
        {
            let mut guard = engine.shared.lock();
            guard.settings.device_id = Some("wasapi_id:{0.0.0.00000000}.{nonexistent-guid}".into());
        }
        engine.handle_devices_changed();
        let snap = engine.snapshot();
        assert!(snap.settings.device_id.is_none());
        assert!(snap.bit_perfect.fallback_reason.is_some());
    }

    #[test]
    fn start_tap_mode_after_route_switch_never_deadlocks() {
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            let devices = list_output_devices();
            let first = devices.first().map(|d| d.id.clone());
            let second = devices.get(1).or_else(|| devices.first()).map(|d| d.id.clone());

            let engine = NativeAudioEngine::new(Arc::new(|_| {}));
            engine.update_settings(AudioSettings {
                output_mode: OutputMode::Shared,
                device_id: second,
                ..AudioSettings::default()
            });
            let _ = engine.start_tap_mode();

            // Switching to another endpoint and calling start_tap_mode again previously self-deadlocked.
            let _ = engine.update_settings(AudioSettings {
                output_mode: OutputMode::Shared,
                device_id: first,
                ..AudioSettings::default()
            });
            let snap = engine.start_tap_mode().expect("second start_tap_mode must succeed");
            assert!(snap.tap_active);
            let _ = engine.stop_tap_mode();
            let _ = done_tx.send(());
        });

        done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("start_tap_mode after route switch timed out (deadlock)");
    }

    #[test]
    fn concurrent_route_switches_and_hotplug_never_deadlock() {
        let (done_tx, done_rx) = mpsc::channel();
        thread::spawn(move || {
            let devices = list_output_devices();
            let a = devices.first().map(|d| d.id.clone());
            let b = devices.get(1).or_else(|| devices.first()).map(|d| d.id.clone());

            let engine = Arc::new(NativeAudioEngine::new(Arc::new(|_| {})));
            let _ = engine.start_tap_mode();

            let eng_hotplug = Arc::clone(&engine);
            let hotplug = thread::spawn(move || {
                for _ in 0..4 {
                    eng_hotplug.handle_devices_changed();
                }
            });

            for i in 0..6 {
                let id = if i % 2 == 0 { a.clone() } else { b.clone() };
                engine.update_settings(AudioSettings {
                    output_mode: OutputMode::Shared,
                    device_id: id,
                    ..AudioSettings::default()
                });
                let _ = engine.start_tap_mode();
            }

            hotplug.join().expect("hotplug worker panicked");
            let _ = engine.stop_tap_mode();
            let _ = done_tx.send(());
        });

        done_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("concurrent route switches and hotplug deadlocked");
    }

    #[test]
    fn bypass_dsp_passes_source_pcm_bit_for_bit_despite_eq_speed_and_volume() {
        let engine = NativeAudioEngine::new(Arc::new(|_| {}));
        let source_pcm = vec![0.125f32, -0.25, 0.5, -0.75, 0.333, -0.444, 0.0, 0.875];
        {
            let mut guard = engine.shared.lock();
            guard.status = "playing".into();
            guard.volume = 0.2;
            guard.muted = true;
            guard.settings.playback_rate = 1.75;
            guard.settings.eq = EqConfig {
                enabled: true,
                bands_db: [9.0, -6.0, 6.0, -3.0, 6.0, 3.0, -6.0],
                ..EqConfig::default()
            };
            guard.eq_dirty = true;
            guard.track = Some(ActiveTrack {
                id: "local:test".into(),
                audio: Arc::new(DecodedAudio {
                    samples_stereo_f32: source_pcm.clone(),
                    sample_rate_hz: 96_000,
                    bit_depth: 24,
                    channels: 2,
                    duration_sec: 4.0 / 96_000.0,
                    codec: "FLAC".into(),
                }),
                frame_cursor: 0.0,
                next_audio: None,
            });
        }

        let mut eq = EqualizerProcessor::new(96_000);
        let mut stretcher = TimeStretcher::new(96_000);
        let mut out = vec![0.0f32; source_pcm.len()];
        let on_ended: Arc<dyn Fn(String) + Send + Sync> = Arc::new(|_| {});

        render_next_block(
            &engine.shared,
            &mut out,
            96_000,
            &mut eq,
            &mut stretcher,
            true,
            &on_ended,
        );

        assert_eq!(out, source_pcm);
    }
}
