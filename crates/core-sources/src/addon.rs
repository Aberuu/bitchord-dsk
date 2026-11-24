use crate::model::{
    addon_has_lossless_capability, AddonHealthStatus, AddonProbeResult, ResolvedSourceStream,
    SourceCandidateTrack,
};
use anyhow::{anyhow, Result};
use core_auth::{StoredAddonConfig, StoredAddonQualityOption};
use reqwest::header::RETRY_AFTER;
use serde::Deserialize;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use url::Url;
use uuid::Uuid;

const PROBE_TIMEOUT_SECS: u64 = 25;
const STREAM_TIMEOUT_SECS: u64 = 25;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawManifest {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    resources: Vec<serde_json::Value>,
    #[serde(default)]
    settings: Vec<RawSetting>,
    #[serde(default)]
    allow_downloads: Option<serde_json::Value>,
    #[serde(default)]
    check_valid_lossless: Option<serde_json::Value>,
    #[serde(default)]
    bitchord_auth: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawSetting {
    #[serde(default)]
    key: String,
    #[serde(default)]
    default: Option<serde_json::Value>,
    #[serde(default)]
    options: Vec<RawSettingOption>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum RawSettingOption {
    Str(String),
    Obj {
        value: serde_json::Value,
        #[serde(default)]
        label: Option<String>,
        #[serde(default)]
        name: Option<String>,
    },
}

fn json_flag_bool(val: Option<&serde_json::Value>, default: bool) -> bool {
    match val {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().unwrap_or(1) != 0,
        Some(serde_json::Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "0" | "false" | "no" | "off" => false,
            "1" | "true" | "yes" | "on" => true,
            _ => default,
        },
        _ => default,
    }
}

fn json_scalar_string(val: &serde_json::Value) -> Option<String> {
    match val {
        serde_json::Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

pub fn normalize_base_url(raw: &str) -> Result<String> {
    let mut trimmed = raw.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err(anyhow!("Enter an addon URL"));
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        trimmed = format!("https://{trimmed}");
    }
    let mut parsed = Url::parse(&trimmed).map_err(|_| anyhow!("BitChord could not tell what that link is"))?;
    if parsed.path().to_ascii_lowercase().ends_with("/manifest.json") {
        let stripped = parsed.path()[..parsed.path().len() - "/manifest.json".len()].to_string();
        parsed.set_path(if stripped.is_empty() { "/" } else { &stripped });
    } else if parsed.path().to_ascii_lowercase().ends_with(".json") {
        let new_path = parsed.path().rsplit_once('/').map(|(parent, _)| {
            if parent.is_empty() {
                "/".to_string()
            } else {
                parent.to_string()
            }
        });
        if let Some(p) = new_path {
            parsed.set_path(&p);
        }
    }
    parsed.set_query(None);
    parsed.set_fragment(None);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

pub fn manifest_url(base_url: &str) -> String {
    format!("{}/manifest.json", base_url.trim_end_matches('/'))
}

fn display_host(base_url: &str) -> String {
    Url::parse(base_url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| base_url.to_string())
}

fn apply_addon_query_params(
    url: &mut Url,
    config: &StoredAddonConfig,
    quality_override: Option<&str>,
) {
    let mut pairs = url.query_pairs_mut();
    for (k, v) in &config.default_settings {
        if k != "quality" {
            pairs.append_pair(k, v);
        }
    }
    let active_q = quality_override
        .filter(|s| !s.trim().is_empty())
        .or_else(|| config.picked_quality.as_deref().filter(|s| !s.trim().is_empty()))
        .or_else(|| config.quality_options.first().map(|o| o.value.as_str()));
    if let Some(q) = active_q {
        pairs.append_pair("quality", q);
    }
}

async fn send_with_429_retry(
    http: &reqwest::Client,
    url: Url,
    timeout_secs: u64,
) -> Result<reqwest::Response> {
    let user_agent = format!("BitChord/{}", env!("CARGO_PKG_VERSION"));
    let first = http
        .get(url.clone())
        .timeout(Duration::from_secs(timeout_secs))
        .header("Accept", "application/json")
        .header("User-Agent", &user_agent)
        .send()
        .await?;

    if first.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        let retry_secs = first
            .headers()
            .get(RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(1)
            .min(5);
        tokio::time::sleep(Duration::from_secs(retry_secs)).await;
        return Ok(http
            .get(url)
            .timeout(Duration::from_secs(timeout_secs))
            .header("Accept", "application/json")
            .header("User-Agent", &user_agent)
            .send()
            .await?);
    }

    Ok(first)
}

fn parse_manifest_into_config(
    raw_json: &str,
    base_url: &str,
    existing: Option<&StoredAddonConfig>,
) -> Result<StoredAddonConfig> {
    let manifest: RawManifest =
        serde_json::from_str(raw_json).map_err(|_| anyhow!("Manifest JSON is malformed"))?;

    let mut resources: Vec<String> = Vec::new();
    for item in &manifest.resources {
        match item {
            serde_json::Value::String(s) => resources.push(s.to_ascii_lowercase()),
            serde_json::Value::Object(obj) => {
                if let Some(name) = obj.get("name").and_then(|v| v.as_str()) {
                    resources.push(name.to_ascii_lowercase());
                }
            }
            _ => {}
        }
    }
    if !resources.is_empty() && (!resources.iter().any(|r| r == "search") || !resources.iter().any(|r| r == "stream")) {
        return Err(anyhow!("Addon manifest must declare both search and stream resources"));
    }

    let mut quality_options: Vec<StoredAddonQualityOption> = Vec::new();
    let mut default_settings: HashMap<String, String> = HashMap::new();
    let mut quality_default: Option<String> = None;

    for setting in manifest.settings {
        if setting.key.trim().is_empty() {
            continue;
        }
        if setting.key == "quality" {
            for opt in setting.options {
                match opt {
                    RawSettingOption::Str(v) if !v.trim().is_empty() => {
                        quality_options.push(StoredAddonQualityOption {
                            value: v.clone(),
                            label: v,
                        });
                    }
                    RawSettingOption::Obj { value, label, name } => {
                        if let Some(val) = json_scalar_string(&value) {
                            let lbl = label
                                .or(name)
                                .filter(|s| !s.trim().is_empty())
                                .unwrap_or_else(|| val.clone());
                            quality_options.push(StoredAddonQualityOption { value: val, label: lbl });
                        }
                    }
                    _ => {}
                }
            }
            quality_default = setting.default.as_ref().and_then(json_scalar_string);
        } else if let Some(def) = setting.default.as_ref().and_then(json_scalar_string) {
            default_settings.insert(setting.key, def);
        }
    }

    let picked_quality = existing
        .and_then(|prev| prev.picked_quality.clone())
        .filter(|prev| quality_options.iter().any(|o| &o.value == prev))
        .or(quality_default)
        .filter(|def| quality_options.is_empty() || quality_options.iter().any(|o| &o.value == def))
        .or_else(|| quality_options.first().map(|o| o.value.clone()));

    let name = if !manifest.name.trim().is_empty() {
        manifest.name.trim().to_string()
    } else if !manifest.id.trim().is_empty() {
        manifest.id.trim().to_string()
    } else {
        display_host(base_url)
    };

    let inferred_lossless = quality_options.iter().any(|o| {
        let v = o.value.to_ascii_lowercase();
        let l = o.label.to_ascii_lowercase();
        v.contains("lossless") || v.contains("flac") || l.contains("lossless") || l.contains("flac")
    }) || manifest.id.to_ascii_lowercase().contains("flac")
        || manifest.name.to_ascii_lowercase().contains("flac");

    Ok(StoredAddonConfig {
        id: existing
            .map(|e| e.id.clone())
            .filter(|id| !id.is_empty())
            .unwrap_or_else(|| format!("addon:{}", Uuid::new_v4().simple())),
        name,
        base_url: base_url.to_string(),
        enabled: existing.map(|e| e.enabled).unwrap_or(true),
        picked_quality,
        quality_options,
        allow_downloads: json_flag_bool(manifest.allow_downloads.as_ref(), true),
        check_valid_lossless: json_flag_bool(manifest.check_valid_lossless.as_ref(), inferred_lossless),
        bitchord_auth: json_flag_bool(manifest.bitchord_auth.as_ref(), false),
        version: manifest.version,
        default_settings,
    })
}

pub async fn identify_and_probe(
    http: &reqwest::Client,
    raw_url: &str,
    existing: Option<&StoredAddonConfig>,
) -> Result<AddonProbeResult> {
    let base_url = normalize_base_url(raw_url)?;
    let trimmed = raw_url.trim();
    let explicit_doc = trimmed.split('?').next().unwrap_or(trimmed).to_ascii_lowercase().ends_with(".json");

    let mut attempts = Vec::new();
    if explicit_doc {
        let with_scheme = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            trimmed.to_string()
        } else {
            format!("https://{trimmed}")
        };
        attempts.push(with_scheme);
    }
    let std_manifest = manifest_url(&base_url);
    if !attempts.contains(&std_manifest) {
        attempts.push(std_manifest);
    }

    let mut parsed_config: Option<StoredAddonConfig> = None;
    let mut last_err: Option<String> = None;

    for candidate in attempts {
        let Ok(parsed_url) = Url::parse(&candidate) else {
            continue;
        };
        match send_with_429_retry(http, parsed_url, PROBE_TIMEOUT_SECS).await {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(text) = resp.text().await {
                    match parse_manifest_into_config(&text, &base_url, existing) {
                        Ok(cfg) => {
                            parsed_config = Some(cfg);
                            break;
                        }
                        Err(err) => last_err = Some(err.to_string()),
                    }
                }
            }
            Ok(resp) => {
                last_err = Some(format!("HTTP {}", resp.status().as_u16()));
            }
            Err(err) => {
                last_err = Some(err.to_string());
            }
        }
    }

    // Fallback when an endpoint omits manifest.json but serves /search directly.
    let config = match parsed_config {
        Some(cfg) => cfg,
        None => {
            let mut probe_url = Url::parse(&format!("{base_url}/search"))?;
            probe_url.query_pairs_mut().append_pair("q", "test");
            let resp = send_with_429_retry(http, probe_url, PROBE_TIMEOUT_SECS)
                .await
                .map_err(|_| anyhow!(last_err.clone().unwrap_or_else(|| "BitChord could not tell what that link is".to_string())))?;
            if !resp.status().is_success() {
                return Err(anyhow!(
                    last_err.unwrap_or_else(|| format!("HTTP {}", resp.status().as_u16()))
                ));
            }
            let text = resp.text().await?;
            parse_search_json(&text, "probe", &display_host(&base_url))
                .map_err(|_| anyhow!("BitChord could not tell what that link is"))?;
            StoredAddonConfig {
                id: existing
                    .map(|e| e.id.clone())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| format!("addon:{}", Uuid::new_v4().simple())),
                name: display_host(&base_url),
                base_url,
                enabled: existing.map(|e| e.enabled).unwrap_or(true),
                picked_quality: existing.and_then(|e| e.picked_quality.clone()),
                quality_options: existing.map(|e| e.quality_options.clone()).unwrap_or_default(),
                allow_downloads: existing.map(|e| e.allow_downloads).unwrap_or(true),
                check_valid_lossless: existing.map(|e| e.check_valid_lossless).unwrap_or(false),
                bitchord_auth: false,
                version: String::new(),
                default_settings: HashMap::new(),
            }
        }
    };

    let health = probe_addon(http, &config).await;
    Ok(AddonProbeResult { config, health })
}

pub async fn probe_addon(http: &reqwest::Client, config: &StoredAddonConfig) -> AddonHealthStatus {
    let Ok(mut url) = Url::parse(&format!("{}/search", config.base_url.trim_end_matches('/'))) else {
        return AddonHealthStatus::Rejected {
            reason: "Invalid addon URL".to_string(),
        };
    };
    url.query_pairs_mut()
        .append_pair("q", "never gonna give you up")
        .append_pair("limit", "1");
    apply_addon_query_params(&mut url, config, None);

    let started = Instant::now();
    match send_with_429_retry(http, url, PROBE_TIMEOUT_SECS).await {
        Ok(resp) => {
            let status = resp.status();
            let latency_ms = started.elapsed().as_millis() as u64;
            if status.is_success() {
                let capability = if addon_has_lossless_capability(config) {
                    "Lossless"
                } else {
                    "HTTP Addon"
                };
                AddonHealthStatus::Ok {
                    detail: format!("{capability} · {latency_ms} ms"),
                    latency_ms,
                }
            } else if status.is_client_error() {
                AddonHealthStatus::Rejected {
                    reason: format!("HTTP {}", status.as_u16()),
                }
            } else {
                AddonHealthStatus::Unreachable {
                    reason: format!("HTTP {}", status.as_u16()),
                }
            }
        }
        Err(err) => AddonHealthStatus::Unreachable {
            reason: err.to_string(),
        },
    }
}

fn parse_search_json(raw: &str, source_id: &str, source_name: &str) -> Result<Vec<SourceCandidateTrack>> {
    let value: serde_json::Value = serde_json::from_str(raw)?;
    let items = if let Some(arr) = value.as_array() {
        arr
    } else if let Some(arr) = value.get("results").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = value.get("tracks").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = value.get("items").and_then(|v| v.as_array()) {
        arr
    } else {
        return Err(anyhow!("Unexpected addon search response shape"));
    };

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .or_else(|| obj.get("trackId"))
            .and_then(json_scalar_string);
        let title = obj
            .get("title")
            .or_else(|| obj.get("name"))
            .and_then(|v| v.as_str())
            .map(str::trim);
        let (Some(id), Some(title)) = (id, title) else {
            continue;
        };
        if title.is_empty() {
            continue;
        }
        let artist = obj
            .get("artist")
            .or_else(|| obj.get("artistsText"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| {
                obj.get("artists").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|a| {
                            a.as_str()
                                .or_else(|| a.get("name").and_then(|n| n.as_str()))
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Unknown artist".to_string());

        let album = obj
            .get("album")
            .and_then(|v| v.as_str().or_else(|| v.get("name").and_then(|n| n.as_str())))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let duration_sec = obj
            .get("durationSec")
            .or_else(|| obj.get("duration"))
            .and_then(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
            })
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(|d| if d > 36000.0 { (d / 1000.0).round() as i64 } else { d.round() as i64 });

        let format = obj.get("format").and_then(|v| v.as_str()).map(str::to_string);
        let codec = obj.get("codec").and_then(|v| v.as_str()).map(str::to_string);
        let audio_quality = obj
            .get("audioQuality")
            .or_else(|| obj.get("quality"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let lossless = obj.get("lossless").and_then(|v| v.as_bool()).unwrap_or_else(|| {
            let joined = format!(
                "{} {} {}",
                codec.as_deref().unwrap_or(""),
                format.as_deref().unwrap_or(""),
                audio_quality
            )
            .to_ascii_lowercase();
            joined.contains("flac") || joined.contains("alac") || joined.contains("wav") || joined.contains("lossless")
        });

        out.push(SourceCandidateTrack {
            id,
            source_id: source_id.to_string(),
            source_name: source_name.to_string(),
            title: title.to_string(),
            artist,
            album,
            duration_sec,
            explicit: obj.get("explicit").and_then(|v| v.as_bool()).unwrap_or(false),
            artwork_url: obj
                .get("artworkUrl")
                .or_else(|| obj.get("artworkURL"))
                .or_else(|| obj.get("cover"))
                .or_else(|| obj.get("thumbnail"))
                .and_then(|v| v.as_str())
                .map(str::to_string),
            stream_url: None,
            headers: HashMap::new(),
            mime_type: obj.get("mimeType").and_then(|v| v.as_str()).map(str::to_string),
            format,
            codec,
            bitrate_kbps: obj.get("bitrateKbps").or_else(|| obj.get("bitrate")).and_then(|v| v.as_i64()),
            sample_rate_hz: obj.get("sampleRateHz").or_else(|| obj.get("sampleRate")).and_then(|v| v.as_i64()),
            bit_depth: obj.get("bitDepth").and_then(|v| v.as_i64()),
            lossless,
        });
    }
    Ok(out)
}

pub async fn search_addon(
    http: &reqwest::Client,
    config: &StoredAddonConfig,
    query: &str,
    title: Option<&str>,
    artist: Option<&str>,
) -> Result<Vec<SourceCandidateTrack>> {
    let mut url = Url::parse(&format!("{}/search", config.base_url.trim_end_matches('/')))?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("q", query);
        if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
            pairs.append_pair("title", t.trim());
        }
        if let Some(a) = artist.filter(|s| !s.trim().is_empty()) {
            pairs.append_pair("artist", a.trim());
        }
    }
    apply_addon_query_params(&mut url, config, None);

    let resp = send_with_429_retry(http, url, PROBE_TIMEOUT_SECS).await?;
    if !resp.status().is_success() {
        return Err(anyhow!("Addon search HTTP {}", resp.status().as_u16()));
    }
    let body = resp.text().await?;
    parse_search_json(&body, &config.id, &config.name)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawStreamPayload {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    stream_url: Option<String>,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    mime_type: Option<String>,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    codec: Option<String>,
    #[serde(default, alias = "bitrate")]
    bitrate_kbps: Option<i64>,
    #[serde(default, alias = "sampleRate")]
    sample_rate_hz: Option<i64>,
    #[serde(default)]
    bit_depth: Option<i64>,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    audio_quality: Option<String>,
    #[serde(default)]
    lossless: Option<bool>,
}

pub async fn resolve_addon_stream(
    http: &reqwest::Client,
    config: &StoredAddonConfig,
    track: &SourceCandidateTrack,
) -> Result<ResolvedSourceStream> {
    let mut endpoint = Url::parse(&format!("{}/stream/", config.base_url.trim_end_matches('/')))?;
    endpoint
        .path_segments_mut()
        .map_err(|_| anyhow!("Invalid addon base URL"))?
        .pop_if_empty()
        .push(&track.id);
    apply_addon_query_params(&mut endpoint, config, None);

    let resp = send_with_429_retry(http, endpoint.clone(), STREAM_TIMEOUT_SECS).await?;
    if !resp.status().is_success() {
        return Err(anyhow!("Addon stream HTTP {}", resp.status().as_u16()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Direct audio byte response (server serves media straight from /stream/{id}).
    if content_type.starts_with("audio/") || content_type == "application/octet-stream" {
        let final_url = resp.url().to_string();
        return Ok(ResolvedSourceStream {
            source_id: config.id.clone(),
            source_name: config.name.clone(),
            track_id: track.id.clone(),
            url: final_url,
            headers: HashMap::new(),
            mime_type: Some(content_type),
            format: track.format.clone(),
            codec: track.codec.clone(),
            bitrate_kbps: track.bitrate_kbps,
            sample_rate_hz: track.sample_rate_hz,
            bit_depth: track.bit_depth,
            lossless: track.lossless || addon_has_lossless_capability(config),
        });
    }

    let payload: RawStreamPayload = resp.json().await?;
    let stream_url = payload
        .url
        .or(payload.stream_url)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Addon returned no playable stream URL"))?;

    let codec = payload.codec.or_else(|| track.codec.clone());
    let format = payload.format.or_else(|| track.format.clone());
    let lossless = payload.lossless.unwrap_or_else(|| {
        let hint = format!(
            "{} {} {} {} {}",
            codec.as_deref().unwrap_or(""),
            format.as_deref().unwrap_or(""),
            payload.mime_type.as_deref().unwrap_or(""),
            payload.audio_quality.as_deref().unwrap_or(""),
            payload.quality.as_deref().unwrap_or("")
        )
        .to_ascii_lowercase();
        hint.contains("flac")
            || hint.contains("alac")
            || hint.contains("wav")
            || hint.contains("lossless")
            || track.lossless
    });

    Ok(ResolvedSourceStream {
        source_id: config.id.clone(),
        source_name: config.name.clone(),
        track_id: track.id.clone(),
        url: stream_url,
        headers: payload.headers,
        mime_type: payload.mime_type.or_else(|| track.mime_type.clone()),
        format,
        codec,
        bitrate_kbps: payload.bitrate_kbps.or(track.bitrate_kbps),
        sample_rate_hz: payload.sample_rate_hz.or(track.sample_rate_hz),
        bit_depth: payload.bit_depth.or(track.bit_depth),
        lossless,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::{Path, Query};
    use axum::routing::get;
    use axum::{Json, Router};
    use tokio::net::TcpListener;

    #[test]
    fn normalizes_manifest_or_root_url() {
        assert_eq!(
            normalize_base_url("my-addon.example.com/manifest.json").unwrap(),
            "https://my-addon.example.com"
        );
        assert_eq!(
            normalize_base_url("http://127.0.0.1:8080/sub/manifest.json/").unwrap(),
            "http://127.0.0.1:8080/sub"
        );
    }

    #[tokio::test]
    async fn identifies_searches_and_resolves_mock_addon() {
        let app = Router::new()
            .route(
                "/manifest.json",
                get(|| async {
                    Json(serde_json::json!({
                        "id": "hi-res-test",
                        "name": "Hi-Res Addon",
                        "version": "1.0.0",
                        "resources": ["search", "stream"],
                        "checkValidLossless": true,
                        "settings": [
                            {
                                "key": "quality",
                                "default": "lossless",
                                "options": [
                                    { "value": "lossless", "label": "Lossless FLAC" },
                                    { "value": "high", "label": "High 320kbps" }
                                ]
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/search",
                get(|Query(params): Query<HashMap<String, String>>| async move {
                    let q = params.get("q").cloned().unwrap_or_default();
                    Json(serde_json::json!({
                        "results": [
                            {
                                "id": "trk-42",
                                "title": format!("Test {q}"),
                                "artist": "Tester",
                                "album": "Demo",
                                "durationSec": 200,
                                "codec": "FLAC",
                                "lossless": true
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/stream/{id}",
                get(|Path(id): Path<String>| async move {
                    Json(serde_json::json!({
                        "url": format!("https://cdn.example.com/audio/{id}.flac"),
                        "codec": "FLAC",
                        "sampleRateHz": 96000,
                        "bitDepth": 24,
                        "lossless": true
                    }))
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let http = reqwest::Client::new();
        let probe = identify_and_probe(&http, &format!("http://127.0.0.1:{}/manifest.json", addr.port()), None)
            .await
            .unwrap();
        assert_eq!(probe.config.name, "Hi-Res Addon");
        assert!(probe.config.check_valid_lossless);
        assert_eq!(probe.config.quality_options.len(), 2);
        assert!(matches!(probe.health, AddonHealthStatus::Ok { .. }));

        let hits = search_addon(&http, &probe.config, "song", None, None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].id, "trk-42");

        let stream = resolve_addon_stream(&http, &probe.config, &hits[0]).await.unwrap();
        assert_eq!(stream.url, "https://cdn.example.com/audio/trk-42.flac");
        assert_eq!(stream.sample_rate_hz, Some(96000));
        assert!(stream.lossless);
    }

    #[tokio::test]
    async fn bitchord_flac_addon_schema_roundtrip() {
        use axum::{extract::Path, routing::get, Json, Router};
        use tokio::net::TcpListener;

        let app = Router::new()
            .route(
                "/manifest.json",
                get(|| async {
                    Json(serde_json::json!({
                        "id": "bitchord-internet-archive-flac",
                        "name": "Layz Add On",
                        "version": "1.6.0",
                        "resources": ["search", "stream"],
                        "settings": [
                            {
                                "key": "quality",
                                "type": "select",
                                "default": "lossless",
                                "options": [
                                    { "value": "lossless", "label": "FLAC Lossless" },
                                    { "value": "high", "label": "High MP3" }
                                ]
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/search",
                get(|| async {
                    Json(serde_json::json!({
                        "tracks": [
                            {
                                "id": "ia-track-1",
                                "title": "Moonlight Sonata",
                                "artist": "Beethoven",
                                "album": "Archive Classical",
                                "duration": "312.4",
                                "artworkURL": "https://archive.org/services/img/ia-track-1",
                                "format": "flac",
                                "audioQuality": "LOSSLESS",
                                "quality": "Hi-Res Lossless 24-bit / 96 kHz",
                                "sampleRate": 96000,
                                "bitDepth": 24,
                                "bitrate": 2800
                            }
                        ]
                    }))
                }),
            )
            .route(
                "/stream/{id}",
                get(|Path(id): Path<String>| async move {
                    Json(serde_json::json!({
                        "url": format!("https://archive.org/download/{id}/track.flac"),
                        "format": "flac",
                        "quality": "Hi-Res Lossless 24-bit / 96 kHz",
                        "audioQuality": "LOSSLESS",
                        "codec": "flac",
                        "container": "flac",
                        "sampleRate": 96000,
                        "bitDepth": 24,
                        "bitrate": 2800
                    }))
                }),
            );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let http = reqwest::Client::new();
        let probe = identify_and_probe(&http, &format!("http://127.0.0.1:{}", addr.port()), None)
            .await
            .unwrap();
        assert_eq!(probe.config.name, "Layz Add On");
        assert!(probe.config.check_valid_lossless);
        assert!(matches!(probe.health, AddonHealthStatus::Ok { .. }));

        let hits = search_addon(&http, &probe.config, "moonlight", None, None).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].duration_sec, Some(312));
        assert_eq!(
            hits[0].artwork_url.as_deref(),
            Some("https://archive.org/services/img/ia-track-1")
        );
        assert!(hits[0].lossless);
        assert_eq!(hits[0].sample_rate_hz, Some(96000));
        assert_eq!(hits[0].bit_depth, Some(24));
        assert_eq!(hits[0].bitrate_kbps, Some(2800));

        let stream = resolve_addon_stream(&http, &probe.config, &hits[0]).await.unwrap();
        assert_eq!(stream.url, "https://archive.org/download/ia-track-1/track.flac");
        assert_eq!(stream.sample_rate_hz, Some(96000));
        assert_eq!(stream.bit_depth, Some(24));
        assert_eq!(stream.bitrate_kbps, Some(2800));
        assert!(stream.lossless);
    }
}
