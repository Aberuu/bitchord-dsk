use crate::model::{decode_html_entities, SourceCandidateTrack};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use des::cipher::{Block, BlockCipherDecrypt, KeyInit};
use des::Des;
use serde::Deserialize;
use std::collections::HashMap;
use url::Url;

const SAAVN_KEY: &[u8; 8] = b"38346591";
const MIN_USABLE_KBPS: i64 = 96;
const API_BASE: &str = "https://www.jiosaavn.com/api.php";

#[derive(Debug, Deserialize)]
struct SaavnSearchResponse {
    #[serde(default)]
    results: Vec<RawSongItem>,
}

#[derive(Debug, Deserialize)]
struct RawSongItem {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    song: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    explicit_content: Option<String>,
    #[serde(default)]
    more_info: Option<RawMoreInfo>,
}

#[derive(Debug, Deserialize)]
struct RawMoreInfo {
    #[serde(default)]
    encrypted_media_url: Option<String>,
    #[serde(rename = "320kbps", default)]
    is_320kbps: Option<String>,
    #[serde(default)]
    duration: Option<serde_json::Value>,
    #[serde(default)]
    album: Option<String>,
    #[serde(default)]
    singers: Option<String>,
    #[serde(rename = "artistMap", default)]
    artist_map: Option<RawArtistMap>,
}

#[derive(Debug, Deserialize)]
struct RawArtistMap {
    #[serde(default)]
    primary_artists: Vec<RawArtistEntry>,
}

#[derive(Debug, Deserialize)]
struct RawArtistEntry {
    #[serde(default)]
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaavnStreamSelection {
    pub url: String,
    pub bitrate_kbps: i64,
}

/// Decrypts JioSaavn's Base64-encoded DES-ECB `encrypted_media_url` field.
pub fn decrypt_media_url(encrypted_b64: &str) -> Result<String> {
    let trimmed = encrypted_b64.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Empty encrypted media URL"));
    }
    let mut bytes = BASE64
        .decode(trimmed)
        .map_err(|e| anyhow!("Invalid JioSaavn base64 payload: {e}"))?;
    if bytes.is_empty() || bytes.len() % 8 != 0 {
        return Err(anyhow!("Unexpected JioSaavn ciphertext length {}", bytes.len()));
    }
    let cipher = Des::new_from_slice(SAAVN_KEY).map_err(|e| anyhow!("Invalid DES key: {e}"))?;
    for chunk in bytes.chunks_exact_mut(8) {
        let mut block = Block::<Des>::default();
        block.copy_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    let pad = *bytes.last().unwrap_or(&0) as usize;
    if pad == 0 || pad > 8 || pad > bytes.len() || !bytes[bytes.len() - pad..].iter().all(|&b| b as usize == pad) {
        return Err(anyhow!("Invalid PKCS5 padding in JioSaavn stream URL"));
    }
    bytes.truncate(bytes.len() - pad);
    String::from_utf8(bytes).map_err(|e| anyhow!("Invalid UTF-8 in JioSaavn stream URL: {e}"))
}

pub fn select_best_saavn_stream(
    encrypted_b64: Option<&str>,
    is_320kbps: Option<&str>,
) -> Option<SaavnStreamSelection> {
    let raw = encrypted_b64?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut url = decrypt_media_url(raw).ok()?;
    if url.starts_with("http://") {
        url = format!("https://{}", &url[7..]);
    }
    if is_320kbps.is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        for pat in ["_48.", "_96.", "_160.", "_320."] {
            if url.contains(pat) {
                url = url.replacen(pat, "_320.", 1);
                break;
            }
        }
    }
    let kbps = parse_kbps_from_url(&url);
    if kbps <= MIN_USABLE_KBPS {
        return None;
    }
    Some(SaavnStreamSelection { url, bitrate_kbps: kbps })
}

fn parse_kbps_from_url(url: &str) -> i64 {
    let lower = url.to_ascii_lowercase();
    if lower.contains("_320.") {
        320
    } else if lower.contains("_160.") {
        160
    } else if lower.contains("_96.") {
        96
    } else if lower.contains("_48.") {
        48
    } else {
        160
    }
}

fn upgrade_artwork_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let https = if trimmed.starts_with("http://") {
        format!("https://{}", &trimmed[7..])
    } else {
        trimmed.to_string()
    };
    Some(
        https
            .replace("150x150", "500x500")
            .replace("50x50", "500x500"),
    )
}

pub async fn search_songs(http: &reqwest::Client, query: &str) -> Result<Vec<SourceCandidateTrack>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let mut url = Url::parse(API_BASE)?;
    url.query_pairs_mut()
        .append_pair("__call", "search.getResults")
        .append_pair("_format", "json")
        .append_pair("_marker", "0")
        .append_pair("api_version", "4")
        .append_pair("ctx", "android")
        .append_pair("p", "1")
        .append_pair("n", "20")
        .append_pair("q", q);

    let resp = http
        .get(url)
        .header("X-Forwarded-For", "49.36.0.1")
        .header("X-Real-IP", "49.36.0.1")
        .header("Cookie", "explicit_content=1")
        .send()
        .await?;

    if !resp.status().is_success() {
        return Err(anyhow!("JioSaavn HTTP {}", resp.status().as_u16()));
    }

    let body: SaavnSearchResponse = resp.json().await?;
    let mut mapped: Vec<SourceCandidateTrack> = body
        .results
        .into_iter()
        .filter_map(|item| {
            let info = item.more_info.as_ref()?;
            let picked = select_best_saavn_stream(
                info.encrypted_media_url.as_deref(),
                info.is_320kbps.as_deref(),
            )?;
            let raw_title = if !item.title.trim().is_empty() {
                &item.title
            } else {
                &item.song
            };
            let title = decode_html_entities(raw_title).trim().to_string();
            if title.is_empty() || item.id.trim().is_empty() {
                return None;
            }
            let artist = info
                .artist_map
                .as_ref()
                .map(|m| {
                    m.primary_artists
                        .iter()
                        .map(|a| decode_html_entities(&a.name))
                        .filter(|s| !s.trim().is_empty())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .filter(|s| !s.is_empty())
                .or_else(|| info.singers.as_deref().map(decode_html_entities))
                .unwrap_or_else(|| "Unknown artist".to_string());

            let album = info
                .album
                .as_deref()
                .map(decode_html_entities)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());

            let duration_sec = info.duration.as_ref().and_then(|v| match v {
                serde_json::Value::Number(n) => n.as_i64(),
                serde_json::Value::String(s) => s.trim().parse::<i64>().ok(),
                _ => None,
            });

            let explicit = item.explicit_content.as_deref() == Some("1");
            Some(SourceCandidateTrack {
                id: item.id,
                source_id: "jiosaavn".to_string(),
                source_name: "JioSaavn".to_string(),
                title,
                artist,
                album,
                duration_sec,
                explicit,
                artwork_url: upgrade_artwork_url(&item.image),
                stream_url: Some(picked.url),
                headers: HashMap::new(),
                mime_type: Some("audio/mp4".to_string()),
                format: Some("mp4".to_string()),
                codec: Some("AAC".to_string()),
                bitrate_kbps: Some(picked.bitrate_kbps),
                sample_rate_hz: Some(44_100),
                bit_depth: None,
                lossless: false,
            })
        })
        .collect();

    // Explicit tracks first so matching prefers uncensored studio masters when ambiguous.
    mapped.sort_by_key(|track| if track.explicit { 0u8 } else { 1u8 });
    Ok(mapped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use des::cipher::BlockCipherEncrypt;

    fn encrypt_saavn_test_url(plain: &str) -> String {
        let cipher = Des::new_from_slice(SAAVN_KEY).unwrap();
        let pad_len = 8 - (plain.len() % 8);
        let mut buf = plain.as_bytes().to_vec();
        buf.extend(std::iter::repeat_n(pad_len as u8, pad_len));
        for chunk in buf.chunks_exact_mut(8) {
            let mut block = Block::<Des>::default();
            block.copy_from_slice(chunk);
            cipher.encrypt_block(&mut block);
            chunk.copy_from_slice(&block);
        }
        BASE64.encode(buf)
    }

    #[test]
    fn decrypts_and_upgrades_to_320_only_when_advertised() {
        let encrypted = encrypt_saavn_test_url("http://aac.saavncdn.com/123/song_96.mp4");
        let upgraded = select_best_saavn_stream(Some(&encrypted), Some("true")).unwrap();
        assert_eq!(upgraded.url, "https://aac.saavncdn.com/123/song_320.mp4");
        assert_eq!(upgraded.bitrate_kbps, 320);

        // Without 320kbps flag, 96kbps stream must be rejected.
        assert!(select_best_saavn_stream(Some(&encrypted), Some("false")).is_none());

        let encrypted_160 = encrypt_saavn_test_url("http://aac.saavncdn.com/123/song_160.mp4");
        let kept = select_best_saavn_stream(Some(&encrypted_160), Some("false")).unwrap();
        assert_eq!(kept.url, "https://aac.saavncdn.com/123/song_160.mp4");
        assert_eq!(kept.bitrate_kbps, 160);
    }

    #[test]
    fn decodes_html_entities_in_titles() {
        assert_eq!(decode_html_entities("Rock &amp; Roll &#039;99"), "Rock & Roll '99");
    }
}
