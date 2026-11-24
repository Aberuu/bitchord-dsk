pub mod asio;
pub mod automix_ffi;
pub mod converter;
pub mod decoder;
pub mod dsd;
pub mod engine;
pub mod eq;
pub mod hotplug;
pub mod sink;
pub mod tap;

pub use asio::{
    list_asio_drivers, probe_asio_driver, AsioClockSourceInfo, AsioDriverCapabilities,
    AsioDriverEntry,
};
pub use automix_ffi::{analyze_mono_pcm, TimeStretcher, TrackAnalysisSummary};
pub use converter::DacFormatConverter;
pub use dsd::{DopPacker, DsdFormat, RawDsdStream};
pub use engine::{AudioSettings, NativeAudioEngine, NativePlaybackSnapshot};
pub use eq::{EqConfig, EqCurve, EqualizerProcessor, PeakLimiter};
pub use hotplug::AudioHotplugWatcher;
pub use sink::{
    asio_available, list_output_devices, AudioDeviceInfo, AudioDeviceKind, BitPerfectStatus,
    OutputMode,
};
pub use tap::{AudioTapBuffer, AudioTapServer};
