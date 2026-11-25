use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CastProtocol {
    Chromecast,
    Dlna,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSupportStatus {
    pub supported: bool,
    pub reason: Option<String>,
    pub local_ip: Option<String>,
    pub adapter_name: Option<String>,
    pub protocols: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastDevice {
    pub id: String,
    pub name: String,
    pub model: Option<String>,
    pub manufacturer: Option<String>,
    pub protocol: CastProtocol,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub av_transport_url: Option<String>,
    #[serde(default)]
    pub rendering_control_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastSessionState {
    pub connected: bool,
    pub connecting: bool,
    pub device: Option<CastDevice>,
    pub track_id: Option<String>,
    pub status: String,
    pub position_sec: f64,
    pub duration_sec: f64,
    pub volume: f32,
    pub muted: bool,
    pub error: Option<String>,
}

impl Default for CastSessionState {
    fn default() -> Self {
        Self {
            connected: false,
            connecting: false,
            device: None,
            track_id: None,
            status: "idle".to_string(),
            position_sec: 0.0,
            duration_sec: 0.0,
            volume: 1.0,
            muted: false,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CastLoadRequest {
    pub device: CastDevice,
    pub track_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub stream_url: Option<String>,
    pub local_file_path: Option<String>,
    pub mime_type: String,
    pub duration_sec: f64,
    pub start_sec: f64,
    pub autoplay: bool,
}
