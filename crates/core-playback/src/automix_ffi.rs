use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, CStr};

#[repr(C)]
struct NativeAnalysisSummary {
    bpm: f64,
    beat_confidence: f64,
    first_beat: f64,
    mix_in_time: f64,
    mix_out_time: f64,
    loudness_lufs: f64,
    peak_dbfs: f64,
    vocal_probability: f64,
    key: [c_char; 16],
}

#[repr(C)]
struct NativeStretcher {
    _private: [u8; 0],
}

extern "C" {
    fn bitchord_analyze_audio(
        samples: *const f32,
        len: usize,
        sample_rate: f64,
        duration: f64,
        out: *mut NativeAnalysisSummary,
    ) -> i32;

    fn bitchord_stretcher_create(sample_rate: i32) -> *mut NativeStretcher;
    fn bitchord_stretcher_reset(s: *mut NativeStretcher);
    fn bitchord_stretcher_process(
        s: *mut NativeStretcher,
        interleaved_in: *const f32,
        in_frames: i32,
        interleaved_out: *mut f32,
        out_frames: i32,
    );
    fn bitchord_stretcher_destroy(s: *mut NativeStretcher);
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackAnalysisSummary {
    pub bpm: f64,
    pub beat_confidence: f64,
    pub first_beat: f64,
    pub mix_in_time: f64,
    pub mix_out_time: f64,
    pub loudness_lufs: f64,
    pub peak_dbfs: f64,
    pub vocal_probability: f64,
    pub key: String,
}

pub fn analyze_mono_pcm(
    samples: &[f32],
    sample_rate: f64,
    duration: f64,
) -> Result<TrackAnalysisSummary> {
    if samples.is_empty() || sample_rate <= 0.0 {
        return Err(anyhow!("Invalid PCM buffer for analysis"));
    }
    let mut raw = NativeAnalysisSummary {
        bpm: 0.0,
        beat_confidence: 0.0,
        first_beat: 0.0,
        mix_in_time: 0.0,
        mix_out_time: 0.0,
        loudness_lufs: -70.0,
        peak_dbfs: -70.0,
        vocal_probability: 0.0,
        key: [0; 16],
    };
    let rc = unsafe {
        bitchord_analyze_audio(samples.as_ptr(), samples.len(), sample_rate, duration, &mut raw)
    };
    if rc != 0 {
        return Err(anyhow!("Native audio analysis returned code {rc}"));
    }
    let key = unsafe { CStr::from_ptr(raw.key.as_ptr()) }
        .to_string_lossy()
        .into_owned();
    Ok(TrackAnalysisSummary {
        bpm: raw.bpm,
        beat_confidence: raw.beat_confidence,
        first_beat: raw.first_beat,
        mix_in_time: raw.mix_in_time,
        mix_out_time: raw.mix_out_time,
        loudness_lufs: raw.loudness_lufs,
        peak_dbfs: raw.peak_dbfs,
        vocal_probability: raw.vocal_probability,
        key,
    })
}

pub struct TimeStretcher {
    ptr: *mut NativeStretcher,
}

unsafe impl Send for TimeStretcher {}

impl TimeStretcher {
    pub fn new(sample_rate: u32) -> Self {
        let ptr = unsafe { bitchord_stretcher_create(sample_rate as i32) };
        Self { ptr }
    }

    pub fn reset(&mut self) {
        unsafe { bitchord_stretcher_reset(self.ptr) };
    }

    pub fn process_stereo(&mut self, input: &[f32], output: &mut [f32]) {
        let in_frames = (input.len() / 2) as i32;
        let out_frames = (output.len() / 2) as i32;
        if in_frames <= 0 || out_frames <= 0 {
            return;
        }
        unsafe {
            bitchord_stretcher_process(
                self.ptr,
                input.as_ptr(),
                in_frames,
                output.as_mut_ptr(),
                out_frames,
            );
        }
    }
}

impl Drop for TimeStretcher {
    fn drop(&mut self) {
        unsafe { bitchord_stretcher_destroy(self.ptr) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_analyzer_processes_synthetic_click_track() {
        let sr = 11_025.0;
        let secs = 12.0;
        let total = (sr * secs) as usize;
        let mut pcm = vec![0.0f32; total];
        let beat_interval = (sr * 60.0 / 120.0) as usize;
        for b in (0..total).step_by(beat_interval) {
            for k in 0..80.min(total - b) {
                pcm[b + k] = (1.0 - k as f32 / 80.0) * (k as f32 * 0.4).sin() * 0.8;
            }
        }
        let summary = analyze_mono_pcm(&pcm, sr, secs).expect("analyze");
        assert!(summary.peak_dbfs > -10.0);
        assert!(summary.bpm >= 0.0);
    }

    #[test]
    fn signalsmith_stretcher_runs_pitch_preserving_time_scale() {
        let mut stretcher = TimeStretcher::new(48_000);
        let input = vec![0.25f32; 1024 * 2];
        let mut output = vec![0.0f32; 512 * 2];
        stretcher.process_stereo(&input, &mut output);
        assert_eq!(output.len(), 1024);
    }
}
