use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsioDriverEntry {
    pub id: String,
    pub name: String,
    pub clsid: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsioClockSourceInfo {
    pub index: i32,
    pub name: String,
    pub is_current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsioDriverCapabilities {
    pub id: String,
    pub name: String,
    pub min_buffer_samples: i32,
    pub max_buffer_samples: i32,
    pub preferred_buffer_samples: i32,
    pub granularity: i32,
    pub current_sample_rate_hz: u32,
    pub max_sample_rate_hz: u32,
    pub supported_sample_rates: Vec<u32>,
    pub supports_native_dsd: bool,
    pub max_dsd_rate_hz: u32,
    pub output_channels: i32,
    pub sample_type_name: String,
    pub clock_sources: Vec<AsioClockSourceInfo>,
}

#[derive(Debug, Clone)]
pub struct AsioSessionInfo {
    pub driver_name: String,
    pub sample_rate_hz: u32,
    pub output_bits: u32,
    pub buffer_samples: i32,
    pub native_dsd: bool,
    pub sample_type_name: String,
    pub clock_sources: Vec<AsioClockSourceInfo>,
    pub active_clock_source: Option<i32>,
}

pub enum AsioRenderMode<'a> {
    PcmStereoF32(&'a mut [f32]),
    DsdRaw {
        left: &'a mut [u8],
        right: &'a mut [u8],
        driver_lsb_first: bool,
    },
}

pub const STANDARD_PCM_RATES: &[u32] = &[
    44_100, 48_000, 88_200, 96_000, 176_400, 192_000, 352_800, 384_000, 705_600, 768_000,
];

pub const STANDARD_DSD_RATES: &[u32] = &[
    2_822_400,  // DSD64
    5_644_800,  // DSD128
    11_289_600, // DSD256
    22_579_200, // DSD512
    45_158_400, // DSD1024
];

pub fn clamp_asio_buffer_size(
    requested: Option<u32>,
    min_size: i32,
    max_size: i32,
    preferred: i32,
    granularity: i32,
) -> i32 {
    let lo = min_size.max(32);
    let hi = max_size.max(lo);
    let pref = preferred.clamp(lo, hi);
    let Some(req) = requested.map(|v| v as i32) else {
        return pref;
    };
    let clamped = req.clamp(lo, hi);
    if granularity == -1 {
        // Power-of-two buffer sizes.
        let mut p = (lo as u32).next_power_of_two().min(i32::MAX as u32) as i32;
        if p < lo {
            p = lo;
        }
        while p < clamped && p.saturating_mul(2) <= hi {
            p *= 2;
        }
        p.clamp(lo, hi)
    } else if granularity > 0 {
        let steps = (clamped - lo) / granularity;
        (lo + steps * granularity).clamp(lo, hi)
    } else {
        pref
    }
}

pub fn asio_driver_id(name: &str) -> String {
    format!("asio:{name}")
}

pub fn parse_asio_driver_name(device_id: &str) -> Option<&str> {
    let rest = device_id.strip_prefix("asio:")?;
    if rest.is_empty() {
        return None;
    }
    // Support both "asio:<name>" and legacy "asio:<idx>:<name>".
    if let Some((first, tail)) = rest.split_once(':') {
        if !tail.is_empty() && first.chars().all(|c| c.is_ascii_digit()) {
            return Some(tail);
        }
    }
    Some(rest)
}

#[cfg(windows)]
mod imp {
    use super::*;
    use parking_lot::Mutex;
    use std::ffi::{c_char, c_void};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;
    use windows::core::{GUID, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Com::{
        CLSIDFromString, CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetDesktopWindow, PeekMessageW, TranslateMessage, MSG, PM_REMOVE,
    };

    const CLSCTX_INPROC_SERVER_RAW: u32 = 0x1;

    const ASE_OK: i32 = 0;
    const ASE_SUCCESS: i32 = 0x3f4847a0;

    // ASIO sample types (Steinberg ASIO 2.3 specification).
    const ASIOST_INT16_LSB: i32 = 16;
    const ASIOST_INT24_LSB: i32 = 17;
    const ASIOST_INT32_LSB: i32 = 18;
    const ASIOST_FLOAT32_LSB: i32 = 19;
    const ASIOST_FLOAT64_LSB: i32 = 20;
    const ASIOST_INT32_LSB16: i32 = 24;
    const ASIOST_INT32_LSB18: i32 = 25;
    const ASIOST_INT32_LSB20: i32 = 26;
    const ASIOST_INT32_LSB24: i32 = 27;
    const ASIOST_DSD_INT8_LSB1: i32 = 32;
    const ASIOST_DSD_INT8_MSB1: i32 = 33;

    // ASIOFuture selectors for Native DSD format negotiation.
    const K_ASIO_SET_IO_FORMAT: i32 = 0x23111961;
    const K_ASIO_CAN_DO_IO_FORMAT: i32 = 0x23112004;
    const K_ASIO_PCM_FORMAT: i32 = 0;
    const K_ASIO_DSD_FORMAT: i32 = 1;

    // ASIO message callback selectors.
    const K_ASIO_SELECTOR_SUPPORTED: i32 = 1;
    const K_ASIO_ENGINE_VERSION: i32 = 2;
    const K_ASIO_RESET_REQUEST: i32 = 3;
    const K_ASIO_BUFFER_SIZE_CHANGE: i32 = 4;
    const K_ASIO_RESYNC_REQUEST: i32 = 5;
    const K_ASIO_LATENCIES_CHANGED: i32 = 6;
    const K_ASIO_SUPPORTS_TIME_INFO: i32 = 7;
    const K_ASIO_SUPPORTS_TIME_CODE: i32 = 8;

    #[link(name = "ole32")]
    extern "system" {
        fn CoCreateInstance(
            rclsid: *const GUID,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> HRESULT;
    }

    #[repr(C)]
    struct AsioClockSourceRaw {
        index: i32,
        associated_channel: i32,
        associated_group: i32,
        is_current_source: i32,
        name: [c_char; 32],
    }

    #[repr(C)]
    struct AsioChannelInfoRaw {
        channel: i32,
        is_input: i32,
        is_active: i32,
        channel_group: i32,
        sample_type: i32,
        name: [c_char; 32],
    }

    #[repr(C)]
    struct AsioBufferInfoRaw {
        is_input: i32,
        channel_num: i32,
        buffers: [*mut c_void; 2],
    }

    #[repr(C)]
    struct AsioCallbacksRaw {
        buffer_switch: extern "C" fn(double_buffer_index: i32, direct_process: i32),
        sample_rate_did_change: extern "C" fn(s_rate: f64),
        asio_message: extern "C" fn(
            selector: i32,
            value: i32,
            message: *mut c_void,
            opt: *mut f64,
        ) -> i32,
        buffer_switch_time_info: extern "C" fn(
            params: *mut c_void,
            double_buffer_index: i32,
            direct_process: i32,
        ) -> *mut c_void,
    }

    #[repr(C)]
    struct AsioIoFormatRaw {
        format_type: i32,
        future: [u8; 508],
    }

    #[repr(C)]
    struct IAsioVtbl {
        query_interface:
            unsafe extern "system" fn(*mut IAsio, *const GUID, *mut *mut c_void) -> HRESULT,
        add_ref: unsafe extern "system" fn(*mut IAsio) -> u32,
        release: unsafe extern "system" fn(*mut IAsio) -> u32,
        init: unsafe extern "system" fn(*mut IAsio, *mut c_void) -> i32,
        get_driver_name: unsafe extern "system" fn(*mut IAsio, *mut c_char),
        get_driver_version: unsafe extern "system" fn(*mut IAsio) -> i32,
        get_error_message: unsafe extern "system" fn(*mut IAsio, *mut c_char),
        start: unsafe extern "system" fn(*mut IAsio) -> i32,
        stop: unsafe extern "system" fn(*mut IAsio) -> i32,
        get_channels: unsafe extern "system" fn(*mut IAsio, *mut i32, *mut i32) -> i32,
        get_latencies: unsafe extern "system" fn(*mut IAsio, *mut i32, *mut i32) -> i32,
        get_buffer_size:
            unsafe extern "system" fn(*mut IAsio, *mut i32, *mut i32, *mut i32, *mut i32) -> i32,
        can_sample_rate: unsafe extern "system" fn(*mut IAsio, f64) -> i32,
        get_sample_rate: unsafe extern "system" fn(*mut IAsio, *mut f64) -> i32,
        set_sample_rate: unsafe extern "system" fn(*mut IAsio, f64) -> i32,
        get_clock_sources:
            unsafe extern "system" fn(*mut IAsio, *mut AsioClockSourceRaw, *mut i32) -> i32,
        set_clock_source: unsafe extern "system" fn(*mut IAsio, i32) -> i32,
        get_sample_position:
            unsafe extern "system" fn(*mut IAsio, *mut [u32; 2], *mut [u32; 2]) -> i32,
        get_channel_info: unsafe extern "system" fn(*mut IAsio, *mut AsioChannelInfoRaw) -> i32,
        create_buffers: unsafe extern "system" fn(
            *mut IAsio,
            *mut AsioBufferInfoRaw,
            i32,
            i32,
            *const AsioCallbacksRaw,
        ) -> i32,
        dispose_buffers: unsafe extern "system" fn(*mut IAsio) -> i32,
        control_panel: unsafe extern "system" fn(*mut IAsio) -> i32,
        future: unsafe extern "system" fn(*mut IAsio, i32, *mut c_void) -> i32,
        output_ready: unsafe extern "system" fn(*mut IAsio) -> i32,
    }

    #[repr(C)]
    struct IAsio {
        vtbl: *const IAsioVtbl,
    }

    struct ComStaGuard {
        should_uninit: bool,
    }

    impl ComStaGuard {
        fn acquire() -> Self {
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            Self {
                should_uninit: hr.is_ok(),
            }
        }
    }

    impl Drop for ComStaGuard {
        fn drop(&mut self) {
            if self.should_uninit {
                unsafe { CoUninitialize() };
            }
        }
    }

    struct AsioDriverHandle {
        ptr: *mut IAsio,
        started: bool,
        buffers_created: bool,
    }

    impl AsioDriverHandle {
        fn open(clsid_str: &str) -> Result<Self> {
            let wide: Vec<u16> = clsid_str.encode_utf16().chain(std::iter::once(0)).collect();
            let clsid = unsafe { CLSIDFromString(PCWSTR(wide.as_ptr())) }
                .map_err(|e| anyhow!("Invalid ASIO CLSID {clsid_str}: {e}"))?;
            let mut raw: *mut c_void = std::ptr::null_mut();
            let hr = unsafe {
                CoCreateInstance(
                    &clsid,
                    std::ptr::null_mut(),
                    CLSCTX_INPROC_SERVER_RAW,
                    &clsid,
                    &mut raw,
                )
            };
            if hr.is_err() || raw.is_null() {
                return Err(anyhow!(
                    "CoCreateInstance failed for ASIO CLSID {clsid_str}: 0x{:08x}",
                    hr.0 as u32
                ));
            }
            let handle = Self {
                ptr: raw as *mut IAsio,
                started: false,
                buffers_created: false,
            };
            let hwnd = unsafe { GetDesktopWindow() }.0 as *mut c_void;
            let ok = unsafe { ((*(*handle.ptr).vtbl).init)(handle.ptr, hwnd) };
            if ok == 0 {
                let msg = handle.error_message();
                return Err(anyhow!(
                    "ASIO driver init failed: {}",
                    if msg.is_empty() { "device not connected or busy" } else { &msg }
                ));
            }
            Ok(handle)
        }

        fn vtbl(&self) -> &IAsioVtbl {
            unsafe { &*(*self.ptr).vtbl }
        }

        fn error_message(&self) -> String {
            let mut buf = [0 as c_char; 128];
            unsafe { (self.vtbl().get_error_message)(self.ptr, buf.as_mut_ptr()) };
            c_buf_to_string(&buf)
        }

        fn channels(&self) -> Result<(i32, i32)> {
            let mut num_in = 0i32;
            let mut num_out = 0i32;
            let err = unsafe { (self.vtbl().get_channels)(self.ptr, &mut num_in, &mut num_out) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOGetChannels failed ({err}): {}", self.error_message()));
            }
            Ok((num_in, num_out))
        }

        fn buffer_size(&self) -> Result<(i32, i32, i32, i32)> {
            let (mut min_s, mut max_s, mut pref_s, mut gran) = (0, 0, 0, 0);
            let err = unsafe {
                (self.vtbl().get_buffer_size)(
                    self.ptr,
                    &mut min_s,
                    &mut max_s,
                    &mut pref_s,
                    &mut gran,
                )
            };
            if err != ASE_OK {
                return Err(anyhow!("ASIOGetBufferSize failed ({err}): {}", self.error_message()));
            }
            Ok((min_s, max_s, pref_s, gran))
        }

        fn can_sample_rate(&self, rate: f64) -> bool {
            unsafe { (self.vtbl().can_sample_rate)(self.ptr, rate) == ASE_OK }
        }

        fn get_sample_rate(&self) -> Result<f64> {
            let mut sr = 0.0f64;
            let err = unsafe { (self.vtbl().get_sample_rate)(self.ptr, &mut sr) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOGetSampleRate failed ({err})"));
            }
            Ok(sr)
        }

        fn set_sample_rate(&self, rate: f64) -> Result<()> {
            let err = unsafe { (self.vtbl().set_sample_rate)(self.ptr, rate) };
            if err != ASE_OK {
                return Err(anyhow!(
                    "ASIOSetSampleRate({rate}) failed ({err}): {}",
                    self.error_message()
                ));
            }
            Ok(())
        }

        fn clock_sources(&self) -> Vec<AsioClockSourceInfo> {
            let mut raw: Vec<AsioClockSourceRaw> = (0..16)
                .map(|_| AsioClockSourceRaw {
                    index: 0,
                    associated_channel: 0,
                    associated_group: 0,
                    is_current_source: 0,
                    name: [0; 32],
                })
                .collect();
            let mut count = raw.len() as i32;
            let err = unsafe { (self.vtbl().get_clock_sources)(self.ptr, raw.as_mut_ptr(), &mut count) };
            if err != ASE_OK || count <= 0 {
                return Vec::new();
            }
            raw.into_iter()
                .take(count.min(16) as usize)
                .map(|c| AsioClockSourceInfo {
                    index: c.index,
                    name: c_buf_to_string(&c.name),
                    is_current: c.is_current_source != 0,
                })
                .collect()
        }

        fn set_clock_source(&self, index: i32) -> Result<()> {
            let err = unsafe { (self.vtbl().set_clock_source)(self.ptr, index) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOSetClockSource({index}) failed ({err})"));
            }
            Ok(())
        }

        fn channel_info(&self, channel: i32, is_input: bool) -> Result<AsioChannelInfoRaw> {
            let mut info = AsioChannelInfoRaw {
                channel,
                is_input: if is_input { 1 } else { 0 },
                is_active: 0,
                channel_group: 0,
                sample_type: 0,
                name: [0; 32],
            };
            let err = unsafe { (self.vtbl().get_channel_info)(self.ptr, &mut info) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOGetChannelInfo failed ({err})"));
            }
            Ok(info)
        }

        fn can_io_format(&self, format_type: i32) -> bool {
            let mut fmt = AsioIoFormatRaw {
                format_type,
                future: [0u8; 508],
            };
            let res = unsafe {
                (self.vtbl().future)(
                    self.ptr,
                    K_ASIO_CAN_DO_IO_FORMAT,
                    (&mut fmt as *mut AsioIoFormatRaw) as *mut c_void,
                )
            };
            res == ASE_SUCCESS || res == ASE_OK
        }

        fn set_io_format(&self, format_type: i32) -> bool {
            let mut fmt = AsioIoFormatRaw {
                format_type,
                future: [0u8; 508],
            };
            let res = unsafe {
                (self.vtbl().future)(
                    self.ptr,
                    K_ASIO_SET_IO_FORMAT,
                    (&mut fmt as *mut AsioIoFormatRaw) as *mut c_void,
                )
            };
            res == ASE_SUCCESS || res == ASE_OK
        }

        fn create_buffers(
            &mut self,
            infos: &mut [AsioBufferInfoRaw],
            buffer_size: i32,
            callbacks: &AsioCallbacksRaw,
        ) -> Result<()> {
            let err = unsafe {
                (self.vtbl().create_buffers)(
                    self.ptr,
                    infos.as_mut_ptr(),
                    infos.len() as i32,
                    buffer_size,
                    callbacks as *const AsioCallbacksRaw,
                )
            };
            if err != ASE_OK {
                return Err(anyhow!("ASIOCreateBuffers failed ({err}): {}", self.error_message()));
            }
            self.buffers_created = true;
            Ok(())
        }

        fn start(&mut self) -> Result<()> {
            let err = unsafe { (self.vtbl().start)(self.ptr) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOStart failed ({err}): {}", self.error_message()));
            }
            self.started = true;
            Ok(())
        }

        fn stop(&mut self) {
            if self.started {
                unsafe {
                    (self.vtbl().stop)(self.ptr);
                }
                self.started = false;
            }
        }

        fn dispose_buffers(&mut self) {
            if self.buffers_created {
                unsafe {
                    (self.vtbl().dispose_buffers)(self.ptr);
                }
                self.buffers_created = false;
            }
        }

        fn control_panel(&self) -> Result<()> {
            let err = unsafe { (self.vtbl().control_panel)(self.ptr) };
            if err != ASE_OK {
                return Err(anyhow!("ASIOControlPanel failed ({err}): {}", self.error_message()));
            }
            Ok(())
        }

        fn output_ready(&self) -> bool {
            unsafe { (self.vtbl().output_ready)(self.ptr) == ASE_OK }
        }
    }

    impl Drop for AsioDriverHandle {
        fn drop(&mut self) {
            self.stop();
            self.dispose_buffers();
            if !self.ptr.is_null() {
                unsafe {
                    (self.vtbl().release)(self.ptr);
                }
                self.ptr = std::ptr::null_mut();
            }
        }
    }

    fn c_buf_to_string(buf: &[c_char]) -> String {
        let nul_pos = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let bytes: Vec<u8> = buf[..nul_pos].iter().map(|&b| b as u8).collect();
        String::from_utf8_lossy(&bytes).trim().to_string()
    }

    pub fn sample_type_meta(sample_type: i32) -> (&'static str, u32) {
        match sample_type {
            ASIOST_INT16_LSB => ("Int16LSB", 16),
            ASIOST_INT24_LSB => ("Int24LSB", 24),
            ASIOST_INT32_LSB => ("Int32LSB", 32),
            ASIOST_FLOAT32_LSB => ("Float32LSB", 32),
            ASIOST_FLOAT64_LSB => ("Float64LSB", 64),
            ASIOST_INT32_LSB16 => ("Int32LSB16", 16),
            ASIOST_INT32_LSB18 => ("Int32LSB18", 18),
            ASIOST_INT32_LSB20 => ("Int32LSB20", 20),
            ASIOST_INT32_LSB24 => ("Int32LSB24", 24),
            ASIOST_DSD_INT8_LSB1 => ("DSDInt8LSB1", 1),
            ASIOST_DSD_INT8_MSB1 => ("DSDInt8MSB1", 1),
            _ => ("Unknown", 32),
        }
    }

    fn read_reg_string(hkey: HKEY, value_name: &str) -> Option<String> {
        let wide_name: Vec<u16> = value_name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut val_type = REG_VALUE_TYPE(0);
        let mut byte_len = 0u32;
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(wide_name.as_ptr()),
                None,
                Some(&mut val_type),
                None,
                Some(&mut byte_len),
            )
        };
        if status != ERROR_SUCCESS || byte_len < 2 {
            return None;
        }
        if val_type != REG_SZ && val_type != REG_EXPAND_SZ {
            return None;
        }
        let mut buf = vec![0u16; (byte_len as usize + 1) / 2];
        let status = unsafe {
            RegQueryValueExW(
                hkey,
                PCWSTR(wide_name.as_ptr()),
                None,
                Some(&mut val_type),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut byte_len),
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        let s = String::from_utf16_lossy(&buf[..nul]).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }

    pub fn list_asio_drivers() -> Vec<AsioDriverEntry> {
        let subkey: Vec<u16> = "SOFTWARE\\ASIO"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut root = HKEY::default();
        let open_res = unsafe {
            RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ,
                &mut root,
            )
        };
        if open_res != ERROR_SUCCESS {
            return Vec::new();
        }

        let mut drivers = Vec::new();
        let mut idx = 0u32;
        loop {
            let mut name_buf = [0u16; 256];
            let mut name_len = name_buf.len() as u32;
            let res = unsafe {
                RegEnumKeyExW(
                    root,
                    idx,
                    PWSTR(name_buf.as_mut_ptr()),
                    &mut name_len,
                    None,
                    PWSTR::null(),
                    None,
                    None,
                )
            };
            if res != ERROR_SUCCESS {
                break;
            }
            idx += 1;
            let key_name = String::from_utf16_lossy(&name_buf[..name_len as usize])
                .trim()
                .to_string();
            if key_name.is_empty() {
                continue;
            }

            let mut sub = HKEY::default();
            let sub_wide: Vec<u16> = key_name.encode_utf16().chain(std::iter::once(0)).collect();
            if unsafe { RegOpenKeyExW(root, PCWSTR(sub_wide.as_ptr()), 0, KEY_READ, &mut sub) }
                == ERROR_SUCCESS
            {
                let clsid = read_reg_string(sub, "CLSID");
                let desc = read_reg_string(sub, "Description").unwrap_or_else(|| key_name.clone());
                unsafe {
                    let _ = RegCloseKey(sub);
                }
                if let Some(clsid) = clsid {
                    let display_name = if desc.is_empty() {
                        key_name.clone()
                    } else {
                        desc.clone()
                    };
                    drivers.push(AsioDriverEntry {
                        id: asio_driver_id(&display_name),
                        name: display_name,
                        clsid,
                        description: desc,
                    });
                }
            }
        }

        unsafe {
            let _ = RegCloseKey(root);
        }
        drivers
    }

    pub fn resolve_asio_driver(device_id: Option<&str>) -> Result<AsioDriverEntry> {
        let drivers = list_asio_drivers();
        if drivers.is_empty() {
            return Err(anyhow!("No Windows ASIO drivers found in HKLM\\SOFTWARE\\ASIO"));
        }
        if let Some(id) = device_id {
            if let Some(target_name) = parse_asio_driver_name(id) {
                if let Some(found) = drivers
                    .iter()
                    .find(|d| d.name.eq_ignore_ascii_case(target_name) || d.id == id)
                {
                    return Ok(found.clone());
                }
            }
            if let Some(found) = drivers
                .iter()
                .find(|d| d.name.eq_ignore_ascii_case(id) || d.clsid.eq_ignore_ascii_case(id))
            {
                return Ok(found.clone());
            }
        }
        // Prefer external USB DAC ASIO drivers over onboard Realtek when auto-selecting.
        if let Some(usb) = drivers
            .iter()
            .find(|d| !d.name.to_ascii_lowercase().contains("realtek"))
        {
            return Ok(usb.clone());
        }
        Ok(drivers[0].clone())
    }

    pub fn probe_asio_driver(device_id: Option<&str>) -> Result<AsioDriverCapabilities> {
        let entry = resolve_asio_driver(device_id)?;
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("bitchord-asio-probe".into())
            .spawn(move || {
                let _com = ComStaGuard::acquire();
                let res = probe_driver_on_sta(&entry);
                let _ = tx.send(res);
            })?;
        rx.recv_timeout(Duration::from_secs(4))
            .map_err(|_| anyhow!("ASIO driver probe timed out"))?
    }

    fn probe_driver_on_sta(entry: &AsioDriverEntry) -> Result<AsioDriverCapabilities> {
        let driver = AsioDriverHandle::open(&entry.clsid)?;
        let (_, num_out) = driver.channels()?;
        let (min_b, max_b, pref_b, gran) = driver.buffer_size()?;
        let current_sr = driver.get_sample_rate().unwrap_or(48_000.0).round() as u32;
        let mut supported_rates = Vec::new();
        for &r in STANDARD_PCM_RATES {
            if driver.can_sample_rate(r as f64) {
                supported_rates.push(r);
            }
        }
        if supported_rates.is_empty() && current_sr > 0 {
            supported_rates.push(current_sr);
        }
        let max_pcm_sr = supported_rates
            .iter()
            .copied()
            .max()
            .unwrap_or(current_sr.max(48_000));

        let supports_native_dsd = driver.can_io_format(K_ASIO_DSD_FORMAT);
        let mut max_dsd_rate = 0u32;
        if supports_native_dsd {
            // Query DSD rates without disturbing PCM mode permanently.
            if driver.set_io_format(K_ASIO_DSD_FORMAT) {
                for &r in STANDARD_DSD_RATES {
                    if driver.can_sample_rate(r as f64) {
                        max_dsd_rate = r;
                    }
                }
                let _ = driver.set_io_format(K_ASIO_PCM_FORMAT);
            } else {
                // Driver advertises DSD support; conservative baseline DSD256 unless queried live.
                max_dsd_rate = 11_289_600;
            }
        }

        let sample_type_name = driver
            .channel_info(0, false)
            .map(|ci| sample_type_meta(ci.sample_type).0.to_string())
            .unwrap_or_else(|_| "Int32LSB".into());
        let clock_sources = driver.clock_sources();

        Ok(AsioDriverCapabilities {
            id: entry.id.clone(),
            name: entry.name.clone(),
            min_buffer_samples: min_b,
            max_buffer_samples: max_b,
            preferred_buffer_samples: pref_b,
            granularity: gran,
            current_sample_rate_hz: current_sr,
            max_sample_rate_hz: max_pcm_sr,
            supported_sample_rates: supported_rates,
            supports_native_dsd,
            max_dsd_rate_hz: max_dsd_rate,
            output_channels: num_out,
            sample_type_name,
            clock_sources,
        })
    }

    pub fn open_asio_control_panel_detached(device_id: Option<&str>) -> Result<()> {
        let entry = resolve_asio_driver(device_id)?;
        let (tx, rx) = mpsc::channel();
        thread::Builder::new()
            .name("bitchord-asio-panel".into())
            .spawn(move || {
                let _com = ComStaGuard::acquire();
                match AsioDriverHandle::open(&entry.clsid) {
                    Ok(driver) => {
                        let res = driver.control_panel();
                        let _ = tx.send(res);
                        // Pump Win32 messages briefly so modeless vendor panels finish initializing.
                        for _ in 0..300 {
                            pump_sta_messages();
                            thread::sleep(Duration::from_millis(20));
                        }
                    }
                    Err(err) => {
                        let _ = tx.send(Err(err));
                    }
                }
            })?;
        rx.recv_timeout(Duration::from_secs(4))
            .map_err(|_| anyhow!("Timed out opening ASIO Control Panel"))?
    }

    type RenderFn = Box<dyn FnMut(AsioRenderMode<'_>) + Send>;

    struct ActiveCallbackState {
        left_buffers: [*mut c_void; 2],
        right_buffers: [*mut c_void; 2],
        buffer_samples: usize,
        sample_type: i32,
        native_dsd: bool,
        use_output_ready: bool,
        driver_ptr: *mut IAsio,
        scratch_pcm: Vec<f32>,
        scratch_dsd_l: Vec<u8>,
        scratch_dsd_r: Vec<u8>,
        render: RenderFn,
        reset_requested: Arc<AtomicBool>,
    }

    // SAFETY: Buffer pointers and driver_ptr are valid only while ACTIVE_CALLBACK is populated,
    // which is strictly before disposeBuffers() / stop() on the owning STA thread.
    unsafe impl Send for ActiveCallbackState {}

    static ACTIVE_CALLBACK: Mutex<Option<ActiveCallbackState>> = Mutex::new(None);

    extern "C" fn asio_buffer_switch(double_buffer_index: i32, _direct_process: i32) {
        let buf_idx = if double_buffer_index == 0 { 0usize } else { 1usize };
        let Some(mut guard) = ACTIVE_CALLBACK.try_lock() else {
            return;
        };
        let Some(ctx) = guard.as_mut() else {
            return;
        };

        let left_ptr = ctx.left_buffers[buf_idx];
        let right_ptr = ctx.right_buffers[buf_idx];
        if left_ptr.is_null() || right_ptr.is_null() {
            return;
        }

        if ctx.native_dsd {
            let byte_count = ctx.buffer_samples / 8;
            ctx.scratch_dsd_l.resize(byte_count, 0x69);
            ctx.scratch_dsd_r.resize(byte_count, 0x69);
            ctx.scratch_dsd_l.fill(0x69);
            ctx.scratch_dsd_r.fill(0x69);
            let driver_lsb = ctx.sample_type == ASIOST_DSD_INT8_LSB1;
            (ctx.render)(AsioRenderMode::DsdRaw {
                left: &mut ctx.scratch_dsd_l,
                right: &mut ctx.scratch_dsd_r,
                driver_lsb_first: driver_lsb,
            });
            unsafe {
                std::ptr::copy_nonoverlapping(
                    ctx.scratch_dsd_l.as_ptr(),
                    left_ptr as *mut u8,
                    byte_count,
                );
                std::ptr::copy_nonoverlapping(
                    ctx.scratch_dsd_r.as_ptr(),
                    right_ptr as *mut u8,
                    byte_count,
                );
            }
        } else {
            let frames = ctx.buffer_samples;
            ctx.scratch_pcm.resize(frames * 2, 0.0);
            ctx.scratch_pcm.fill(0.0);
            (ctx.render)(AsioRenderMode::PcmStereoF32(&mut ctx.scratch_pcm));
            unsafe {
                write_pcm_to_asio_planes(
                    &ctx.scratch_pcm,
                    left_ptr,
                    right_ptr,
                    frames,
                    ctx.sample_type,
                );
            }
        }

        if ctx.use_output_ready && !ctx.driver_ptr.is_null() {
            unsafe {
                ((*(*ctx.driver_ptr).vtbl).output_ready)(ctx.driver_ptr);
            }
        }
    }

    extern "C" fn asio_buffer_switch_time_info(
        _params: *mut c_void,
        double_buffer_index: i32,
        direct_process: i32,
    ) -> *mut c_void {
        asio_buffer_switch(double_buffer_index, direct_process);
        std::ptr::null_mut()
    }

    extern "C" fn asio_sample_rate_did_change(_s_rate: f64) {}

    extern "C" fn asio_message_callback(
        selector: i32,
        value: i32,
        _message: *mut c_void,
        _opt: *mut f64,
    ) -> i32 {
        match selector {
            K_ASIO_SELECTOR_SUPPORTED => match value {
                K_ASIO_ENGINE_VERSION
                | K_ASIO_RESET_REQUEST
                | K_ASIO_BUFFER_SIZE_CHANGE
                | K_ASIO_RESYNC_REQUEST
                | K_ASIO_LATENCIES_CHANGED
                | K_ASIO_SUPPORTS_TIME_INFO
                | K_ASIO_SUPPORTS_TIME_CODE => 1,
                _ => 0,
            },
            K_ASIO_ENGINE_VERSION => 2,
            K_ASIO_RESET_REQUEST | K_ASIO_BUFFER_SIZE_CHANGE => {
                if let Some(guard) = ACTIVE_CALLBACK.try_lock() {
                    if let Some(ctx) = guard.as_ref() {
                        ctx.reset_requested.store(true, Ordering::SeqCst);
                    }
                }
                1
            }
            K_ASIO_RESYNC_REQUEST | K_ASIO_LATENCIES_CHANGED => 1,
            K_ASIO_SUPPORTS_TIME_INFO => 1,
            K_ASIO_SUPPORTS_TIME_CODE => 0,
            _ => 0,
        }
    }

    unsafe fn write_pcm_to_asio_planes(
        stereo: &[f32],
        left_ptr: *mut c_void,
        right_ptr: *mut c_void,
        frames: usize,
        sample_type: i32,
    ) {
        match sample_type {
            ASIOST_INT32_LSB => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut i32, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut i32, frames);
                for i in 0..frames {
                    let l = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    let r = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                    l_out[i] = (l * 2_147_483_647.0).round() as i32;
                    r_out[i] = (r * 2_147_483_647.0).round() as i32;
                }
            }
            ASIOST_INT32_LSB24 => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut i32, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut i32, frames);
                for i in 0..frames {
                    let l = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    let r = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                    l_out[i] = (l * 8_388_607.0).round() as i32;
                    r_out[i] = (r * 8_388_607.0).round() as i32;
                }
            }
            ASIOST_INT32_LSB16 => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut i32, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut i32, frames);
                for i in 0..frames {
                    let l = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    let r = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                    l_out[i] = (l * 32_767.0).round() as i32;
                    r_out[i] = (r * 32_767.0).round() as i32;
                }
            }
            ASIOST_INT24_LSB => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut u8, frames * 3);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut u8, frames * 3);
                for i in 0..frames {
                    let l = (stereo[i * 2].clamp(-1.0, 1.0) as f64 * 8_388_607.0).round() as i32;
                    let r =
                        (stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64 * 8_388_607.0).round() as i32;
                    let lb = l.to_le_bytes();
                    let rb = r.to_le_bytes();
                    l_out[i * 3..i * 3 + 3].copy_from_slice(&lb[0..3]);
                    r_out[i * 3..i * 3 + 3].copy_from_slice(&rb[0..3]);
                }
            }
            ASIOST_INT16_LSB => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut i16, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut i16, frames);
                for i in 0..frames {
                    let l = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    let r = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                    l_out[i] = (l * 32_767.0).round() as i16;
                    r_out[i] = (r * 32_767.0).round() as i16;
                }
            }
            ASIOST_FLOAT32_LSB => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut f32, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut f32, frames);
                for i in 0..frames {
                    l_out[i] = stereo[i * 2].clamp(-1.0, 1.0);
                    r_out[i] = stereo[i * 2 + 1].clamp(-1.0, 1.0);
                }
            }
            ASIOST_FLOAT64_LSB => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut f64, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut f64, frames);
                for i in 0..frames {
                    l_out[i] = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    r_out[i] = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                }
            }
            _ => {
                let l_out = std::slice::from_raw_parts_mut(left_ptr as *mut i32, frames);
                let r_out = std::slice::from_raw_parts_mut(right_ptr as *mut i32, frames);
                for i in 0..frames {
                    let l = stereo[i * 2].clamp(-1.0, 1.0) as f64;
                    let r = stereo[i * 2 + 1].clamp(-1.0, 1.0) as f64;
                    l_out[i] = (l * 2_147_483_647.0).round() as i32;
                    r_out[i] = (r * 2_147_483_647.0).round() as i32;
                }
            }
        }
    }

    fn pump_sta_messages() {
        let mut msg = MSG::default();
        unsafe {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
    }

    pub fn run_asio_session<FSetup, FRender>(
        device_id: Option<&str>,
        source_rate_hz: u32,
        dsd_bit_rate: Option<u32>,
        requested_buffer_samples: Option<u32>,
        requested_clock_source: Option<i32>,
        stop_flag: Arc<AtomicBool>,
        open_panel_flag: Arc<AtomicBool>,
        on_ready: FSetup,
        make_render: FRender,
    ) -> Result<()>
    where
        FSetup: FnOnce(AsioSessionInfo),
        FRender: FnOnce(&AsioSessionInfo) -> RenderFn,
    {
        let _com = ComStaGuard::acquire();
        let entry = resolve_asio_driver(device_id)?;
        let mut driver = AsioDriverHandle::open(&entry.clsid)?;
        let (_, num_out) = driver.channels()?;
        if num_out < 2 {
            return Err(anyhow!(
                "ASIO driver '{}' exposes fewer than 2 output channels ({num_out})",
                entry.name
            ));
        }

        if let Some(clock_idx) = requested_clock_source {
            let _ = driver.set_clock_source(clock_idx);
        }

        let mut native_dsd = false;
        let negotiated_rate: u32;

        if let Some(dsd_rate) = dsd_bit_rate {
            if driver.can_io_format(K_ASIO_DSD_FORMAT)
                && driver.set_io_format(K_ASIO_DSD_FORMAT)
                && driver.can_sample_rate(dsd_rate as f64)
                && driver.set_sample_rate(dsd_rate as f64).is_ok()
            {
                native_dsd = true;
                negotiated_rate = dsd_rate;
            } else {
                let _ = driver.set_io_format(K_ASIO_PCM_FORMAT);
                negotiated_rate = negotiate_pcm_rate(&driver, source_rate_hz)?;
            }
        } else {
            let _ = driver.set_io_format(K_ASIO_PCM_FORMAT);
            negotiated_rate = negotiate_pcm_rate(&driver, source_rate_hz)?;
        }

        let (min_b, max_b, pref_b, gran) = driver.buffer_size()?;
        let mut buffer_samples =
            clamp_asio_buffer_size(requested_buffer_samples, min_b, max_b, pref_b, gran);
        if native_dsd {
            buffer_samples = (buffer_samples / 8).max(8) * 8;
        }

        let mut infos = [
            AsioBufferInfoRaw {
                is_input: 0,
                channel_num: 0,
                buffers: [std::ptr::null_mut(); 2],
            },
            AsioBufferInfoRaw {
                is_input: 0,
                channel_num: 1,
                buffers: [std::ptr::null_mut(); 2],
            },
        ];

        let callbacks = AsioCallbacksRaw {
            buffer_switch: asio_buffer_switch,
            sample_rate_did_change: asio_sample_rate_did_change,
            asio_message: asio_message_callback,
            buffer_switch_time_info: asio_buffer_switch_time_info,
        };

        driver.create_buffers(&mut infos, buffer_samples, &callbacks)?;

        let ch_info = driver.channel_info(0, false)?;
        let (sample_type_name, output_bits) = sample_type_meta(ch_info.sample_type);
        let is_dsd_sample_type = matches!(
            ch_info.sample_type,
            ASIOST_DSD_INT8_LSB1 | ASIOST_DSD_INT8_MSB1
        );
        if native_dsd && !is_dsd_sample_type {
            return Err(anyhow!(
                "ASIO driver '{}' did not switch channel format to DSD (got {sample_type_name})",
                entry.name
            ));
        }

        let clock_sources = driver.clock_sources();
        let active_clock_source = clock_sources
            .iter()
            .find(|c| c.is_current)
            .map(|c| c.index);
        let use_output_ready = driver.output_ready();

        let session_info = AsioSessionInfo {
            driver_name: entry.name.clone(),
            sample_rate_hz: negotiated_rate,
            output_bits,
            buffer_samples,
            native_dsd,
            sample_type_name: sample_type_name.to_string(),
            clock_sources,
            active_clock_source,
        };

        let render = make_render(&session_info);
        let reset_requested = Arc::new(AtomicBool::new(false));
        {
            let mut active_cb = ACTIVE_CALLBACK.lock();
            *active_cb = Some(ActiveCallbackState {
                left_buffers: infos[0].buffers,
                right_buffers: infos[1].buffers,
                buffer_samples: buffer_samples as usize,
                sample_type: ch_info.sample_type,
                native_dsd,
                use_output_ready,
                driver_ptr: driver.ptr,
                scratch_pcm: vec![0.0; buffer_samples as usize * 2],
                scratch_dsd_l: vec![0x69; (buffer_samples as usize / 8).max(1)],
                scratch_dsd_r: vec![0x69; (buffer_samples as usize / 8).max(1)],
                render,
                reset_requested: Arc::clone(&reset_requested),
            });
        }

        if let Err(err) = driver.start() {
            *ACTIVE_CALLBACK.lock() = None;
            return Err(err);
        }

        on_ready(session_info);

        while !stop_flag.load(Ordering::SeqCst) {
            pump_sta_messages();
            if open_panel_flag.swap(false, Ordering::SeqCst) {
                let _ = driver.control_panel();
            }
            if reset_requested.swap(false, Ordering::SeqCst) {
                // Driver requested buffer/rate renegotiation after a control panel change.
                break;
            }
            thread::sleep(Duration::from_millis(12));
        }

        driver.stop();
        *ACTIVE_CALLBACK.lock() = None;
        driver.dispose_buffers();
        Ok(())
    }

    fn negotiate_pcm_rate(driver: &AsioDriverHandle, desired: u32) -> Result<u32> {
        let target = desired.max(44_100);
        if driver.can_sample_rate(target as f64) {
            if driver.set_sample_rate(target as f64).is_ok() {
                return Ok(target);
            }
        }
        // Fallback: try closest supported standard rate (prefer integer multiples first).
        let fallback_order = [
            if target % 44_100 == 0 { 176_400 } else { 192_000 },
            if target % 44_100 == 0 { 88_200 } else { 96_000 },
            48_000,
            44_100,
            96_000,
            192_000,
            384_000,
        ];
        for r in fallback_order {
            if driver.can_sample_rate(r as f64) && driver.set_sample_rate(r as f64).is_ok() {
                return Ok(r);
            }
        }
        let current = driver.get_sample_rate()?.round() as u32;
        if current > 0 {
            Ok(current)
        } else {
            Err(anyhow!("ASIO driver rejected sample rate {desired} Hz"))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    pub fn list_asio_drivers() -> Vec<AsioDriverEntry> {
        Vec::new()
    }

    pub fn probe_asio_driver(_device_id: Option<&str>) -> Result<AsioDriverCapabilities> {
        Err(anyhow!("ASIO is only supported on Windows"))
    }

    pub fn open_asio_control_panel_detached(_device_id: Option<&str>) -> Result<()> {
        Err(anyhow!("ASIO is only supported on Windows"))
    }

    pub fn run_asio_session<FSetup, FRender>(
        _device_id: Option<&str>,
        _source_rate_hz: u32,
        _dsd_bit_rate: Option<u32>,
        _requested_buffer_samples: Option<u32>,
        _requested_clock_source: Option<i32>,
        _stop_flag: Arc<AtomicBool>,
        _open_panel_flag: Arc<AtomicBool>,
        _on_ready: FSetup,
        _make_render: FRender,
    ) -> Result<()>
    where
        FSetup: FnOnce(AsioSessionInfo),
        FRender: FnOnce(&AsioSessionInfo) -> Box<dyn FnMut(AsioRenderMode<'_>) + Send>,
    {
        Err(anyhow!("ASIO is only supported on Windows"))
    }
}

pub use imp::{
    list_asio_drivers, open_asio_control_panel_detached, probe_asio_driver, run_asio_session,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamps_power_of_two_and_linear_asio_buffer_sizes() {
        assert_eq!(clamp_asio_buffer_size(None, 64, 2048, 256, -1), 256);
        assert_eq!(clamp_asio_buffer_size(Some(500), 64, 2048, 256, -1), 512);
        assert_eq!(clamp_asio_buffer_size(Some(100), 64, 2048, 256, 32), 96);
        assert_eq!(clamp_asio_buffer_size(Some(4096), 64, 2048, 256, 32), 2048);
    }

    #[test]
    fn parses_canonical_and_legacy_asio_device_ids() {
        assert_eq!(parse_asio_driver_name("asio:FiiO ASIO Driver"), Some("FiiO ASIO Driver"));
        assert_eq!(parse_asio_driver_name("asio:0:Realtek ASIO"), Some("Realtek ASIO"));
        assert_eq!(parse_asio_driver_name("wasapi_id:abc"), None);
    }

    #[cfg(windows)]
    #[test]
    fn enumerates_windows_asio_registry_without_crashing() {
        let drivers = list_asio_drivers();
        for drv in &drivers {
            assert!(drv.id.starts_with("asio:"));
            assert!(!drv.clsid.is_empty());
        }
    }
}
