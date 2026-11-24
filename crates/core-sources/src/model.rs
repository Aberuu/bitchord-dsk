use core_auth::{StoredAddonConfig, StoredAddonQualityOption};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "flac", "ogg", "opus", "aac", "wav", "wma", "aif", "aiff", "webm", "dsf", "dff",
];

pub const IMAGE_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "webp"];

pub fn is_audio_file(name: &str) -> bool {
    extension_lower(name).is_some_and(|ext| AUDIO_EXTENSIONS.contains(&ext.as_str()))
}

pub fn is_image_file(name: &str) -> bool {
    extension_lower(name).is_some_and(|ext| IMAGE_EXTENSIONS.contains(&ext.as_str()))
}

pub fn extension_lower(name: &str) -> Option<String> {
    let clean = name.split(['?', '#']).next().unwrap_or(name);
    let file = clean.rsplit(['/', '\\']).next().unwrap_or(clean);
    let (_, ext) = file.rsplit_once('.')?;
    let trimmed = ext.trim().to_ascii_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn codec_from_name(name: &str) -> String {
    match extension_lower(name).as_deref() {
        Some("flac") => "FLAC",
        Some("m4a") | Some("mp4") | Some("aac") => "AAC / ALAC",
        Some("mp3") => "MP3",
        Some("opus") => "Opus",
        Some("ogg") => "Vorbis",
        Some("wav") => "WAV",
        Some("aif") | Some("aiff") => "AIFF",
        Some("dsf") | Some("dff") => "DSD",
        Some("webm") => "WebM",
        Some("wma") => "WMA",
        _ => "Audio",
    }
    .to_string()
}

pub fn split_artist_title(file_name: &str) -> (String, String) {
    let base = file_name
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(file_name)
        .trim();
    if let Some((artist, title)) = base.split_once(" - ") {
        let a = artist.trim();
        let t = title.trim();
        if !a.is_empty() && !t.is_empty() {
            return (a.to_string(), t.to_string());
        }
    }
    ("Unknown artist".to_string(), base.to_string())
}

/// Picks preferred folder cover artwork ("cover", "folder", "front", "album", then first image).
pub fn pick_best_cover<'a, I>(candidates: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let items: Vec<&str> = candidates.into_iter().collect();
    if items.is_empty() {
        return None;
    }
    for priority in ["cover", "folder", "front", "album"] {
        if let Some(found) = items.iter().find(|path| {
            let file = path
                .rsplit(['/', '\\'])
                .next()
                .unwrap_or(path)
                .to_ascii_lowercase();
            file.starts_with(priority)
        }) {
            return Some((*found).to_string());
        }
    }
    items.first().map(|s| (*s).to_string())
}

pub fn decode_html_entities(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    input
        .replace("&quot;", "\"")
        .replace("&#039;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum AddonHealthStatus {
    Ok { detail: String, latency_ms: u64 },
    Rejected { reason: String },
    Unreachable { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddonProbeResult {
    pub config: StoredAddonConfig,
    pub health: AddonHealthStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceCandidateTrack {
    pub id: String,
    pub source_id: String,
    pub source_name: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_sec: Option<i64>,
    pub explicit: bool,
    pub artwork_url: Option<String>,
    pub stream_url: Option<String>,
    pub headers: HashMap<String, String>,
    pub mime_type: Option<String>,
    pub format: Option<String>,
    pub codec: Option<String>,
    pub bitrate_kbps: Option<i64>,
    pub sample_rate_hz: Option<i64>,
    pub bit_depth: Option<i64>,
    pub lossless: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSourceStream {
    pub source_id: String,
    pub source_name: String,
    pub track_id: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub mime_type: Option<String>,
    pub format: Option<String>,
    pub codec: Option<String>,
    pub bitrate_kbps: Option<i64>,
    pub sample_rate_hz: Option<i64>,
    pub bit_depth: Option<i64>,
    pub lossless: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTrackItem {
    pub id: String,
    pub source_kind: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub file_name: String,
    pub codec: String,
    pub size_bytes: u64,
    pub rel_path: String,
    pub proxy_key: String,
    pub stream_proxy_url: String,
    pub artwork_proxy_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebDavStatusView {
    pub configured: bool,
    pub url: String,
    pub username: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmbStatusView {
    pub configured: bool,
    pub host: String,
    pub share: String,
    pub base_path: String,
    pub username: String,
    pub has_password: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesSnapshot {
    pub addons: Vec<StoredAddonConfig>,
    pub jiosaavn_enabled: bool,
    pub track_length_tolerance_sec: u8,
    pub webdav: WebDavStatusView,
    pub smb: SmbStatusView,
}

pub fn addon_has_lossless_capability(config: &StoredAddonConfig) -> bool {
    if config.check_valid_lossless {
        return true;
    }
    let matches_lossless = |text: &str| {
        let lower = text.to_ascii_lowercase();
        lower.contains("lossless") || lower.contains("flac") || lower.contains("hi-res") || lower.contains("hires")
    };
    if matches_lossless(&config.name) {
        return true;
    }
    config
        .quality_options
        .iter()
        .any(|StoredAddonQualityOption { value, label }| matches_lossless(value) || matches_lossless(label))
}
