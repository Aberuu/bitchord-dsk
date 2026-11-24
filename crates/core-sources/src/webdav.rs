use crate::model::{
    codec_from_name, is_audio_file, is_image_file, pick_best_cover, split_artist_title,
    RemoteTrackItem,
};
use anyhow::{anyhow, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use core_auth::StoredWebDavConfig;
use quick_xml::events::Event;
use quick_xml::Reader;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use reqwest::Method;
use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;
use url::Url;

const MAX_FILES: usize = 10_000;
const REQUEST_TIMEOUT_SECS: u64 = 15;
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:resourcetype/>
    <d:getcontenttype/>
  </d:prop>
</d:propfind>"#;

#[derive(Debug, Clone)]
pub struct DavEntry {
    pub url: String,
    pub display_name: String,
    pub is_dir: bool,
    pub size_bytes: u64,
}

pub fn normalize_url(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

pub fn is_configured(url: &str) -> bool {
    let normalized = normalize_url(url);
    !normalized.is_empty() && Url::parse(&normalized).ok().and_then(|u| u.host_str().map(|h| !h.is_empty())).unwrap_or(false)
}

pub fn basic_auth_header(username: &str, password: &str) -> Option<String> {
    if username.trim().is_empty() && password.is_empty() {
        return None;
    }
    let creds = format!("{}:{}", username.trim(), password);
    Some(format!("Basic {}", BASE64.encode(creds.as_bytes())))
}

fn canonical_path_key(url: &Url) -> String {
    format!(
        "{}{}",
        url.host_str().unwrap_or(""),
        url.path().trim_end_matches('/').to_ascii_lowercase()
    )
}

fn dir_key(url_str: &str) -> String {
    Url::parse(url_str)
        .ok()
        .map(|u| {
            let trimmed = u.path().trim_end_matches('/');
            let parent = trimmed.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
            format!("{}{}", u.host_str().unwrap_or(""), parent.to_ascii_lowercase())
        })
        .unwrap_or_default()
}

fn parent_folder_name(url_str: &str) -> Option<String> {
    let parsed = Url::parse(url_str).ok()?;
    let segments: Vec<&str> = parsed.path().trim_end_matches('/').split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return None;
    }
    let raw = segments[segments.len() - 2];
    let decoded = url::form_urlencoded::parse(format!("v={raw}").as_bytes())
        .find(|(k, _)| k == "v")
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| raw.to_string());
    let trimmed = decoded.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

async fn send_propfind(
    http: &reqwest::Client,
    url: &Url,
    depth: &str,
    auth: Option<&str>,
) -> Result<String> {
    let method = Method::from_bytes(b"PROPFIND")?;
    let mut req = http
        .request(method, url.clone())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .header("Depth", depth)
        .header(CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(PROPFIND_BODY);
    if let Some(auth_val) = auth {
        req = req.header(AUTHORIZATION, auth_val);
    }
    let resp = req.send().await?;
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(anyhow!("Unauthorized (check username and password)"));
    }
    if !status.is_success() && status.as_u16() != 207 {
        return Err(anyhow!("WebDAV HTTP {}", status.as_u16()));
    }
    Ok(resp.text().await?)
}

fn local_xml_name(raw: &str) -> String {
    raw.rsplit_once(':')
        .map(|(_, local)| local)
        .unwrap_or(raw)
        .to_ascii_lowercase()
}

fn append_active_text(
    active_tag: &str,
    text: &str,
    current_href: &mut String,
    current_display: &mut String,
    current_size: &mut u64,
) {
    let trimmed = text.trim();
    match active_tag {
        "href" => current_href.push_str(trimmed),
        "displayname" => current_display.push_str(text),
        "getcontentlength" => {
            if let Ok(n) = trimmed.parse::<u64>() {
                *current_size = n;
            }
        }
        _ => {}
    }
}

fn resolve_href(base: &Url, href: &str) -> Option<Url> {
    if href.starts_with("http://") || href.starts_with("https://") {
        Url::parse(href).ok()
    } else {
        base.join(href).ok()
    }
}

pub fn parse_multistatus(base: &Url, xml: &str) -> Vec<DavEntry> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    let mut current_href = String::new();
    let mut current_display = String::new();
    let mut current_size: u64 = 0;
    let mut current_is_dir = false;
    let mut in_response = false;
    let mut active_tag = String::new();

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let name = local_xml_name(e.name().as_ref());
                if name == "response" {
                    in_response = true;
                    current_href.clear();
                    current_display.clear();
                    current_size = 0;
                    current_is_dir = false;
                } else if in_response {
                    if name == "collection" {
                        current_is_dir = true;
                    }
                    active_tag = name;
                }
            }
            Ok(Event::Empty(e)) => {
                if in_response && local_xml_name(e.name().as_ref()) == "collection" {
                    current_is_dir = true;
                }
            }
            Ok(Event::Text(t)) if in_response => {
                let text = t.xml10_content();
                append_active_text(
                    active_tag.as_str(),
                    &text,
                    &mut current_href,
                    &mut current_display,
                    &mut current_size,
                );
            }
            Ok(Event::GeneralRef(g)) if in_response => {
                let resolved = g.resolve_char_ref().ok().flatten().map(|c| c.to_string()).unwrap_or_else(|| {
                    match g.xml10_content().as_ref() {
                        "amp" => "&".to_string(),
                        "lt" => "<".to_string(),
                        "gt" => ">".to_string(),
                        "quot" => "\"".to_string(),
                        "apos" => "'".to_string(),
                        _ => String::new(),
                    }
                });
                append_active_text(
                    active_tag.as_str(),
                    &resolved,
                    &mut current_href,
                    &mut current_display,
                    &mut current_size,
                );
            }
            Ok(Event::End(e)) => {
                let name = local_xml_name(e.name().as_ref());
                if name == "response" && in_response {
                    in_response = false;
                    if let Some(resolved) = resolve_href(base, current_href.trim()) {
                        let raw_seg = resolved
                            .path()
                            .trim_end_matches('/')
                            .rsplit('/')
                            .next()
                            .unwrap_or("");
                        let fallback_name = url::form_urlencoded::parse(format!("v={raw_seg}").as_bytes())
                            .find(|(k, _)| k == "v")
                            .map(|(_, v)| v.to_string())
                            .unwrap_or_else(|| raw_seg.to_string());
                        let display_name = if current_display.trim().is_empty() {
                            fallback_name
                        } else {
                            current_display.trim().to_string()
                        };
                        out.push(DavEntry {
                            url: resolved.to_string(),
                            display_name,
                            is_dir: current_is_dir || current_href.trim().ends_with('/'),
                            size_bytes: current_size,
                        });
                    }
                } else if active_tag == name {
                    active_tag.clear();
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

pub async fn test_connection(
    http: &reqwest::Client,
    url: &str,
    username: &str,
    password: &str,
) -> Result<()> {
    let normalized = normalize_url(url);
    if !is_configured(&normalized) {
        return Err(anyhow!("Enter a valid WebDAV server URL"));
    }
    let parsed = Url::parse(&normalized)?;
    let auth = basic_auth_header(username, password);
    send_propfind(http, &parsed, "0", auth.as_deref()).await?;
    Ok(())
}

pub async fn list_library(
    http: &reqwest::Client,
    config: &StoredWebDavConfig,
) -> Result<Vec<RemoteTrackItem>> {
    let normalized = normalize_url(&config.url);
    if !is_configured(&normalized) {
        return Ok(Vec::new());
    }
    let root = Url::parse(&normalized)?;
    let auth = basic_auth_header(&config.username, &config.password);

    let mut queue = VecDeque::new();
    let mut visited = HashSet::new();
    queue.push_back(root.clone());

    let mut audio_entries: Vec<DavEntry> = Vec::new();
    let mut images_by_dir: HashMap<String, Vec<String>> = HashMap::new();

    while let Some(dir_url) = queue.pop_front() {
        if audio_entries.len() >= MAX_FILES {
            break;
        }
        let dir_key_str = canonical_path_key(&dir_url);
        if !visited.insert(dir_key_str.clone()) {
            continue;
        }

        let xml = match send_propfind(http, &dir_url, "1", auth.as_deref()).await {
            Ok(body) => body,
            Err(err) => {
                if visited.len() == 1 {
                    return Err(err);
                }
                tracing::debug!("Skipping unreadable WebDAV dir {}: {err}", dir_url);
                continue;
            }
        };

        for entry in parse_multistatus(&dir_url, &xml) {
            let Ok(entry_url) = Url::parse(&entry.url) else {
                continue;
            };
            let entry_path_key = canonical_path_key(&entry_url);
            if entry_path_key == dir_key_str {
                continue;
            }
            if entry.is_dir {
                if !visited.contains(&entry_path_key) {
                    queue.push_back(entry_url);
                }
                continue;
            }
            if is_audio_file(&entry.display_name) || is_audio_file(&entry.url) {
                audio_entries.push(entry);
            } else if is_image_file(&entry.display_name) || is_image_file(&entry.url) {
                images_by_dir
                    .entry(dir_key(&entry.url))
                    .or_default()
                    .push(entry.url);
            }
        }
    }

    Ok(audio_entries
        .into_iter()
        .map(|entry| {
            let (artist, title) = split_artist_title(&entry.display_name);
            let album = parent_folder_name(&entry.url);
            let artwork_url = images_by_dir
                .get(&dir_key(&entry.url))
                .and_then(|imgs| pick_best_cover(imgs.iter().map(String::as_str)));
            RemoteTrackItem {
                id: format!("webdav:{}", entry.url),
                source_kind: "webdav".to_string(),
                title,
                artist,
                album,
                codec: codec_from_name(&entry.display_name),
                file_name: entry.display_name,
                size_bytes: entry.size_bytes,
                rel_path: entry.url,
                proxy_key: String::new(),
                stream_proxy_url: String::new(),
                artwork_proxy_url: artwork_url,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::any;
    use axum::Router;
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn tests_connection_and_lists_nested_webdav_tracks() {
        let app = Router::new().route(
            "/dav/{*rest}",
            any(|req: axum::extract::Request| async move {
                let auth_ok = req
                    .headers()
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .is_some_and(|v| v == "Basic dXNlcjpwYXNz");
                if !auth_ok {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                let path = req.uri().path().to_string();
                let depth = req
                    .headers()
                    .get("depth")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("0")
                    .to_string();
                let body = if depth == "0" || path.trim_end_matches('/').ends_with("/Music/Album") {
                    r#"<?xml version="1.0"?>
                    <d:multistatus xmlns:d="DAV:">
                      <d:response><d:href>/dav/Music/Album/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
                      <d:response><d:href>/dav/Music/Album/Artist%20-%20Song.flac</d:href><d:propstat><d:prop><d:displayname>Artist - Song.flac</d:displayname><d:getcontentlength>4096</d:getcontentlength></d:prop></d:propstat></d:response>
                      <d:response><d:href>/dav/Music/Album/cover.jpg</d:href><d:propstat><d:prop><d:displayname>cover.jpg</d:displayname></d:prop></d:propstat></d:response>
                    </d:multistatus>"#
                } else {
                    r#"<?xml version="1.0"?>
                    <d:multistatus xmlns:d="DAV:">
                      <d:response><d:href>/dav/Music/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
                      <d:response><d:href>/dav/Music/Album/</d:href><d:propstat><d:prop><d:displayname>Album</d:displayname><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
                    </d:multistatus>"#
                };
                let mut headers = HeaderMap::new();
                headers.insert("content-type", "application/xml".parse().unwrap());
                (StatusCode::MULTI_STATUS, headers, body.to_string()).into_response()
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let http = reqwest::Client::new();
        let root_url = format!("http://127.0.0.1:{}/dav/Music", addr.port());
        test_connection(&http, &root_url, "user", "pass").await.unwrap();
        assert!(test_connection(&http, &root_url, "user", "wrong").await.is_err());

        let tracks = list_library(
            &http,
            &StoredWebDavConfig {
                url: root_url,
                username: "user".to_string(),
                password: "pass".to_string(),
            },
        )
        .await
        .unwrap();
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].artist, "Artist");
        assert_eq!(tracks[0].title, "Song");
        assert_eq!(tracks[0].album.as_deref(), Some("Album"));
        assert_eq!(tracks[0].codec, "FLAC");
        assert!(tracks[0].artwork_proxy_url.as_deref().unwrap().ends_with("cover.jpg"));
    }
}
