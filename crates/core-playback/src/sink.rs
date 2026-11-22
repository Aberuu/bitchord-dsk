use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutputMode {
    Shared,
    WasapiExclusive,
    Asio,
}

impl Default for OutputMode {
    fn default() -> Self {
        Self::Shared
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDeviceInfo {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub backend: String,
    pub supports_exclusive: bool,
    pub max_sample_rate_hz: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BitPerfectStatus {
    pub active: bool,
    pub driver: Option<String>,
    pub device_name: Option<String>,
    pub sample_rate_hz: u32,
    pub output_bits: u32,
    pub source_bits: u32,
    pub source_rate_hz: u32,
    pub exact: bool,
    pub dac_limited: bool,
    pub fallback_reason: Option<String>,
}

pub fn asio_available() -> bool {
    cfg!(feature = "asio")
}

pub fn list_output_devices() -> Vec<AudioDeviceInfo> {
    let mut devices = Vec::new();
    let host = cpal::default_host();
    let default_name = host
        .default_output_device()
        .and_then(|d| d.name().ok())
        .unwrap_or_default();

    if let Ok(iter) = host.output_devices() {
        for (idx, dev) in iter.enumerate() {
            let Ok(name) = dev.name() else { continue };
            let max_sr = dev
                .supported_output_configs()
                .ok()
                .and_then(|cfgs| cfgs.map(|c| c.max_sample_rate().0).max())
                .unwrap_or(48_000);
            devices.push(AudioDeviceInfo {
                id: format!("wasapi:{idx}:{name}"),
                is_default: name == default_name,
                name,
                backend: "WASAPI".into(),
                supports_exclusive: cfg!(windows),
                max_sample_rate_hz: max_sr,
            });
        }
    }

    #[cfg(feature = "asio")]
    {
        if let Ok(asio_host) = cpal::host_from_id(cpal::HostId::Asio) {
            if let Ok(iter) = asio_host.output_devices() {
                for (idx, dev) in iter.enumerate() {
                    let Ok(name) = dev.name() else { continue };
                    let max_sr = dev
                        .supported_output_configs()
                        .ok()
                        .and_then(|cfgs| cfgs.map(|c| c.max_sample_rate().0).max())
                        .unwrap_or(192_000);
                    devices.push(AudioDeviceInfo {
                        id: format!("asio:{idx}:{name}"),
                        is_default: false,
                        name,
                        backend: "ASIO".into(),
                        supports_exclusive: true,
                        max_sample_rate_hz: max_sr,
                    });
                }
            }
        }
    }

    devices
}

pub fn find_cpal_device(device_id: Option<&str>) -> Result<(cpal::Device, String)> {
    let host = cpal::default_host();
    if let Some(wanted) = device_id {
        let wanted_name = wanted.splitn(3, ':').nth(2).unwrap_or(wanted);
        if let Ok(iter) = host.output_devices() {
            for dev in iter {
                if let Ok(name) = dev.name() {
                    if name == wanted_name {
                        return Ok((dev, name));
                    }
                }
            }
        }
    }
    let dev = host
        .default_output_device()
        .ok_or_else(|| anyhow!("No Windows audio output device available"))?;
    let name = dev.name().unwrap_or_else(|_| "Default Output".into());
    Ok((dev, name))
}

#[cfg(windows)]
pub fn probe_wasapi_exclusive_format(
    device_name: Option<&str>,
    source_rate_hz: u32,
    source_bits: u32,
    channels: usize,
) -> Result<(u32, u32, u32, bool, String)> {
    use wasapi::{
        get_default_device, DeviceCollection, Direction, SampleType, ShareMode, WaveFormat,
    };

    let _ = wasapi::initialize_mta();
    let device = if let Some(wanted) = device_name {
        let wanted_clean = wanted.splitn(3, ':').nth(2).unwrap_or(wanted);
        DeviceCollection::new(&Direction::Render)
            .map_err(|e| anyhow!("WASAPI collection: {e}"))?
            .get_device_with_name(wanted_clean)
            .map_err(|e| anyhow!("Selected WASAPI device not found: {e}"))?
    } else {
        get_default_device(&Direction::Render)
            .map_err(|e| anyhow!("Default WASAPI device: {e}"))?
    };

    let friendly = device
        .get_friendlyname()
        .unwrap_or_else(|_| "WASAPI Device".into());
    let client = device
        .get_iaudioclient()
        .map_err(|e| anyhow!("WASAPI IAudioClient: {e}"))?;

    let preferred_bits = source_bits.clamp(16, 32);
    let candidates: &[(u32, usize, usize)] = match preferred_bits {
        16 => &[
            (source_rate_hz, 16, 16),
            (source_rate_hz, 24, 24),
            (source_rate_hz, 24, 32),
            (source_rate_hz, 32, 32),
        ],
        24 => &[
            (source_rate_hz, 24, 24),
            (source_rate_hz, 24, 32),
            (source_rate_hz, 32, 32),
            (source_rate_hz, 16, 16),
        ],
        _ => &[
            (source_rate_hz, 32, 32),
            (source_rate_hz, 24, 32),
            (source_rate_hz, 24, 24),
            (source_rate_hz, 16, 16),
        ],
    };

    for &(rate, valid, container) in candidates {
        let fmt = WaveFormat::new(container, valid, &SampleType::Int, rate as usize, channels, None);
        if matches!(client.is_supported(&fmt, &ShareMode::Exclusive), Ok(None)) {
            let exact = rate == source_rate_hz && valid as u32 >= preferred_bits;
            return Ok((rate, valid as u32, container as u32, exact, friendly));
        }
    }

    // DAC rejected the source sample rate; fall back to the highest standard rate it accepts.
    for &rate in &[192_000u32, 96_000, 48_000, 44_100] {
        for &(valid, container) in &[(24usize, 32usize), (24, 24), (16, 16)] {
            let fmt =
                WaveFormat::new(container, valid, &SampleType::Int, rate as usize, channels, None);
            if matches!(client.is_supported(&fmt, &ShareMode::Exclusive), Ok(None)) {
                return Ok((rate, valid as u32, container as u32, false, friendly));
            }
        }
    }

    Err(anyhow!(
        "Device '{friendly}' did not accept WASAPI Exclusive PCM formats"
    ))
}

#[cfg(not(windows))]
pub fn probe_wasapi_exclusive_format(
    _device_name: Option<&str>,
    _source_rate_hz: u32,
    _source_bits: u32,
    _channels: usize,
) -> Result<(u32, u32, u32, bool, String)> {
    Err(anyhow!("WASAPI Exclusive is Windows-only"))
}
