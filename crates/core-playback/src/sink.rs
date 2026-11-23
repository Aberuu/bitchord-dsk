use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioDeviceKind {
    Speakers,
    Headphones,
    UsbDac,
    Bluetooth,
    Hdmi,
    Other,
}

impl Default for AudioDeviceKind {
    fn default() -> Self {
        Self::Other
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
    pub kind: AudioDeviceKind,
    pub is_usb_dac: bool,
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

pub fn classify_endpoint(
    name: &str,
    interface_name: &str,
    enumerator: &str,
    form_factor: Option<u32>,
) -> AudioDeviceKind {
    let lower_name = name.to_ascii_lowercase();
    let lower_iface = interface_name.to_ascii_lowercase();
    let lower_enum = enumerator.to_ascii_lowercase();

    if lower_enum.starts_with("bth")
        || lower_name.contains("bluetooth")
        || lower_name.contains("hands-free")
        || lower_name.contains("airpods")
        || lower_name.contains("buds")
    {
        return AudioDeviceKind::Bluetooth;
    }

    if lower_enum == "usb"
        || lower_iface.contains("usb audio")
        || lower_name.contains("usb dac")
        || lower_name.contains("usb audio")
    {
        return AudioDeviceKind::UsbDac;
    }

    // Windows EndpointFormFactor: 7=UnknownDigitalPassthrough, 8=SPDIF, 9=DigitalAudioDisplayDevice.
    if matches!(form_factor, Some(7 | 8 | 9))
        || lower_name.contains("hdmi")
        || lower_name.contains("displayport")
        || lower_iface.contains("nvidia high definition")
        || lower_iface.contains("amd high definition")
    {
        return AudioDeviceKind::Hdmi;
    }

    // Windows EndpointFormFactor: 3=Headphones, 5=Headset.
    if matches!(form_factor, Some(3 | 5))
        || lower_name.contains("headphone")
        || lower_name.contains("headset")
        || lower_name.contains("earphone")
        || lower_name.contains("iem")
    {
        return AudioDeviceKind::Headphones;
    }

    // Windows EndpointFormFactor: 1=Speakers, 2=LineLevel.
    if matches!(form_factor, Some(1 | 2)) || lower_name.contains("speaker") {
        return AudioDeviceKind::Speakers;
    }

    AudioDeviceKind::Other
}

fn cpal_output_sample_rates() -> HashMap<String, u32> {
    let mut rates = HashMap::new();
    let host = cpal::default_host();
    if let Ok(iter) = host.output_devices() {
        for dev in iter {
            let Ok(name) = dev.name() else { continue };
            let max_sr = dev
                .supported_output_configs()
                .ok()
                .and_then(|cfgs| cfgs.map(|c| c.max_sample_rate().0).max())
                .unwrap_or(48_000);
            rates.insert(name, max_sr);
        }
    }
    rates
}

#[cfg(windows)]
fn read_mmdevice_metadata(
    mm_dev: &windows::Win32::Media::Audio::IMMDevice,
) -> (Option<String>, String, Option<u32>) {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_DeviceInterface_FriendlyName;
    use windows::Win32::Media::Audio::PKEY_AudioEndpoint_FormFactor;
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc, PropVariantToUInt32,
    };
    use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};
    use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;

    // DEVPKEY_Device_EnumeratorName ({a45c254e-df1c-4efd-8020-67d146a850e0}, pid 24).
    const PKEY_ENUMERATOR_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 24,
    };

    let Ok(store) = (unsafe { mm_dev.OpenPropertyStore(STGM_READ) }) else {
        return (None, String::new(), None);
    };

    let read_string = |key: &PROPERTYKEY| -> String {
        let Ok(mut prop) = (unsafe { store.GetValue(key) }) else {
            return String::new();
        };
        let value = unsafe {
            let s = PropVariantToStringAlloc(&prop)
                .ok()
                .map(|pw| {
                    let text = pw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(pw.0.cast()));
                    text
                })
                .unwrap_or_default();
            let _ = PropVariantClear(&mut prop);
            s
        };
        value
    };

    let form_factor = unsafe {
        store.GetValue(&PKEY_AudioEndpoint_FormFactor).ok().and_then(|mut prop| {
            let val = PropVariantToUInt32(&prop).ok();
            let _ = PropVariantClear(&mut prop);
            val
        })
    };

    let interface_name = read_string(&PKEY_DeviceInterface_FriendlyName);
    let enumerator = read_string(&PKEY_ENUMERATOR_NAME);

    (
        (!interface_name.is_empty()).then_some(interface_name),
        enumerator,
        form_factor,
    )
}

#[cfg(windows)]
fn mmdevice_mix_sample_rate(mm_dev: &windows::Win32::Media::Audio::IMMDevice) -> Option<u32> {
    use windows::Win32::Media::Audio::IAudioClient;
    use windows::Win32::System::Com::{CoTaskMemFree, CLSCTX_ALL};

    unsafe {
        let client: IAudioClient = mm_dev.Activate(CLSCTX_ALL, None).ok()?;
        let fmt_ptr = client.GetMixFormat().ok()?;
        let rate = (!fmt_ptr.is_null()).then(|| (*fmt_ptr).nSamplesPerSec);
        CoTaskMemFree(Some(fmt_ptr.cast()));
        rate
    }
}

#[cfg(windows)]
pub(crate) struct ComMtaGuard(bool);

#[cfg(windows)]
impl ComMtaGuard {
    pub(crate) fn acquire() -> Self {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        // Pair CoUninitialize only when this call initialized COM (S_OK / S_FALSE), never on RPC_E_CHANGED_MODE.
        Self(hr.is_ok())
    }
}

#[cfg(windows)]
impl Drop for ComMtaGuard {
    fn drop(&mut self) {
        if self.0 {
            unsafe {
                windows::Win32::System::Com::CoUninitialize();
            }
        }
    }
}

#[cfg(windows)]
fn list_windows_wasapi_devices(cpal_rates: &HashMap<String, u32>) -> Result<Vec<AudioDeviceInfo>> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::StructuredStorage::{PropVariantClear, PropVariantToStringAlloc};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};

    let _com = ComMtaGuard::acquire();
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)? };

    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .ok()
        .and_then(|dev| unsafe {
            dev.GetId().ok().map(|pw| {
                let s = pw.to_string().unwrap_or_default();
                CoTaskMemFree(Some(pw.0.cast()));
                s
            })
        });

    let collection = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE)? };
    let count = unsafe { collection.GetCount()? };
    let mut devices = Vec::with_capacity(count as usize);

    for idx in 0..count {
        let Ok(dev) = (unsafe { collection.Item(idx) }) else {
            continue;
        };
        let mm_id = unsafe {
            let Ok(pw) = dev.GetId() else { continue };
            let s = pw.to_string().unwrap_or_default();
            CoTaskMemFree(Some(pw.0.cast()));
            s
        };
        if mm_id.is_empty() {
            continue;
        }

        let name = unsafe {
            let Ok(store) = dev.OpenPropertyStore(STGM_READ) else {
                continue;
            };
            let Ok(mut prop) = store.GetValue(&PKEY_Device_FriendlyName) else {
                continue;
            };
            let text = PropVariantToStringAlloc(&prop)
                .ok()
                .map(|pw| {
                    let s = pw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(pw.0.cast()));
                    s
                })
                .unwrap_or_default();
            let _ = PropVariantClear(&mut prop);
            text
        };
        if name.is_empty() {
            continue;
        }

        let (interface_name, enumerator_name, form_factor) = read_mmdevice_metadata(&dev);
        let kind = classify_endpoint(
            &name,
            interface_name.as_deref().unwrap_or(""),
            &enumerator_name,
            form_factor,
        );
        let max_sr = cpal_rates
            .get(&name)
            .copied()
            .or_else(|| mmdevice_mix_sample_rate(&dev))
            .unwrap_or(48_000);

        devices.push(AudioDeviceInfo {
            id: format!("wasapi_id:{mm_id}"),
            is_default: default_id.as_deref() == Some(mm_id.as_str()),
            name,
            backend: "WASAPI".into(),
            supports_exclusive: true,
            max_sample_rate_hz: max_sr,
            kind,
            is_usb_dac: kind == AudioDeviceKind::UsbDac,
        });
    }

    Ok(devices)
}

pub fn list_output_devices() -> Vec<AudioDeviceInfo> {
    let mut devices = Vec::new();
    let cpal_rates = cpal_output_sample_rates();

    #[cfg(windows)]
    let enumerated_windows = match list_windows_wasapi_devices(&cpal_rates) {
        Ok(list) if !list.is_empty() => {
            devices.extend(list);
            true
        }
        _ => false,
    };
    #[cfg(not(windows))]
    let enumerated_windows = false;

    if !enumerated_windows {
        let host = cpal::default_host();
        let default_name = host
            .default_output_device()
            .and_then(|d| d.name().ok())
            .unwrap_or_default();

        if let Ok(iter) = host.output_devices() {
            for (idx, dev) in iter.enumerate() {
                let Ok(name) = dev.name() else { continue };
                let max_sr = cpal_rates.get(&name).copied().unwrap_or(48_000);
                let kind = classify_endpoint(&name, "", "", None);
                devices.push(AudioDeviceInfo {
                    id: format!("wasapi:{idx}:{name}"),
                    is_default: name == default_name,
                    name,
                    backend: "WASAPI".into(),
                    supports_exclusive: cfg!(windows),
                    max_sample_rate_hz: max_sr,
                    kind,
                    is_usb_dac: kind == AudioDeviceKind::UsbDac,
                });
            }
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
                    let kind = classify_endpoint(&name, "", "asio", None);
                    devices.push(AudioDeviceInfo {
                        id: format!("asio:{idx}:{name}"),
                        is_default: false,
                        name,
                        backend: "ASIO".into(),
                        supports_exclusive: true,
                        max_sample_rate_hz: max_sr,
                        kind,
                        is_usb_dac: kind == AudioDeviceKind::UsbDac,
                    });
                }
            }
        }
    }

    devices
}

/// Resolves a stored device id (`wasapi_id:<mmdevice_id>`, legacy `wasapi:<idx>:<name>`, or raw name)
/// to an active endpoint friendly name on Windows.
pub fn resolve_target_endpoint_name(wanted: &str) -> Result<String> {
    if let Some(mm_id) = wanted.strip_prefix("wasapi_id:") {
        #[cfg(windows)]
        {
            let _com = ComMtaGuard::acquire();
            let col = wasapi::DeviceCollection::new(&wasapi::Direction::Render)
                .map_err(|e| anyhow!("WASAPI collection: {e}"))?;
            let count = col.get_nbr_devices().map_err(|e| anyhow!("{e}"))?;
            for i in 0..count {
                if let Ok(dev) = col.get_device_at_index(i) {
                    if dev.get_id().ok().as_deref() == Some(mm_id) {
                        return dev.get_friendlyname().map_err(|e| anyhow!("{e}"));
                    }
                }
            }
            return Err(anyhow!("Selected audio output device is disconnected"));
        }
        #[cfg(not(windows))]
        {
            let _ = mm_id;
        }
    }

    let wanted_name = wanted.splitn(3, ':').nth(2).unwrap_or(wanted);
    Ok(wanted_name.to_string())
}

pub fn find_cpal_device(device_id: Option<&str>) -> Result<(cpal::Device, String)> {
    let host = cpal::default_host();
    if let Some(wanted) = device_id {
        let wanted_name = resolve_target_endpoint_name(wanted)?;
        if let Ok(iter) = host.output_devices() {
            for dev in iter {
                if let Ok(name) = dev.name() {
                    if name == wanted_name {
                        return Ok((dev, name));
                    }
                }
            }
        }
        return Err(anyhow!("Audio output device '{wanted_name}' is unavailable"));
    }
    let dev = host
        .default_output_device()
        .ok_or_else(|| anyhow!("No Windows audio output device available"))?;
    let name = dev.name().unwrap_or_else(|_| "Default Output".into());
    Ok((dev, name))
}

#[cfg(windows)]
pub fn open_wasapi_device(device_id: Option<&str>) -> Result<wasapi::Device> {
    use wasapi::{get_default_device, DeviceCollection, Direction};

    let _com = ComMtaGuard::acquire();
    let Some(wanted) = device_id else {
        return get_default_device(&Direction::Render)
            .map_err(|e| anyhow!("Default WASAPI device: {e}"));
    };

    let collection = DeviceCollection::new(&Direction::Render)
        .map_err(|e| anyhow!("WASAPI collection: {e}"))?;

    if let Some(mm_id) = wanted.strip_prefix("wasapi_id:") {
        let count = collection.get_nbr_devices().map_err(|e| anyhow!("{e}"))?;
        for i in 0..count {
            if let Ok(dev) = collection.get_device_at_index(i) {
                if dev.get_id().ok().as_deref() == Some(mm_id) {
                    return Ok(dev);
                }
            }
        }
        return Err(anyhow!("Selected WASAPI device is disconnected"));
    }

    let wanted_clean = wanted.splitn(3, ':').nth(2).unwrap_or(wanted);
    collection
        .get_device_with_name(wanted_clean)
        .map_err(|e| anyhow!("Selected WASAPI device not found: {e}"))
}

#[cfg(windows)]
pub fn probe_wasapi_exclusive_format(
    device_name: Option<&str>,
    source_rate_hz: u32,
    source_bits: u32,
    channels: usize,
) -> Result<(u32, u32, u32, bool, String)> {
    use wasapi::{SampleType, ShareMode, WaveFormat};

    let device = open_wasapi_device(device_name)?;

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_windows_endpoints_by_form_factor_and_bus() {
        assert_eq!(
            classify_endpoint("Speakers (Realtek(R) Audio)", "Realtek(R) Audio", "HDAUDIO", Some(1)),
            AudioDeviceKind::Speakers
        );
        assert_eq!(
            classify_endpoint("Headphones (Realtek(R) Audio)", "Realtek(R) Audio", "HDAUDIO", Some(3)),
            AudioDeviceKind::Headphones
        );
        assert_eq!(
            classify_endpoint("Speakers (FiiO KA11)", "FiiO KA11", "USB", Some(1)),
            AudioDeviceKind::UsbDac
        );
        assert_eq!(
            classify_endpoint("Headphones (Space Travel 2)", "Space Travel 2", "BTHENUM", Some(3)),
            AudioDeviceKind::Bluetooth
        );
        assert_eq!(
            classify_endpoint("DELL U2723QE (NVIDIA High Definition Audio)", "NVIDIA High Definition Audio", "HDAUDIO", Some(9)),
            AudioDeviceKind::Hdmi
        );
    }

    #[test]
    fn parses_legacy_device_id_formats() {
        assert_eq!(
            resolve_target_endpoint_name("wasapi:1:Speakers (Realtek(R) Audio)").unwrap(),
            "Speakers (Realtek(R) Audio)"
        );
        assert_eq!(
            resolve_target_endpoint_name("Headphones (Realtek(R) Audio)").unwrap(),
            "Headphones (Realtek(R) Audio)"
        );
    }
}
