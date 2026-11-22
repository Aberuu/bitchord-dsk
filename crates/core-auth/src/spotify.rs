use crate::vault::SecretVault;
use anyhow::{anyhow, Result};
use base64::Engine;
use hmac::{Hmac, Mac};
use parking_lot::Mutex;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::Sha1;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const WEB_PLAYER: &str = "https://open.spotify.com";
const CDN: &str = "https://open.spotifycdn.com/cdn/build/web-player/";
const PATHFINDER: &str = "https://api-partner.spotify.com/pathfinder/v2/query";
const CLIENT_TOKEN: &str = "https://clienttoken.spotify.com/v1/clienttoken";
pub const LIKED_ID: &str = "liked";
const LIKED_COVER: &str = "https://misc.scdn.co/liked-songs/liked-songs-640.png";
const FOUND_TTL: Duration = Duration::from_secs(12 * 3600);
const MISSED_TTL: Duration = Duration::from_secs(30 * 60);
const RETRY_COOLDOWN: Duration = Duration::from_secs(60);

const FALLBACK_SECRET_VERSION: u32 = 12;
const FALLBACK_SECRET_CODES: &[u32] = &[
    107, 81, 49, 57, 67, 93, 87, 81, 69, 67, 40, 93, 48, 50, 46, 91, 94, 113, 41, 47,
];

const OPERATIONS: &[(&str, &str)] = &[
    ("libraryV3", "390c78e5b951029bad359785e69b07b536a509c581cbcd0aded5e5067f187455"),
    ("fetchPlaylist", "21ea11a6ac75a5f3e01fd365d29c18e0a4a8b7dc09f89bbb5d73910190c6acaf"),
    ("fetchLibraryTracks", "087278b20b743578a6262c2b0b4bcd20d879c503cc359a2285baf083ef944240"),
    ("canvas", "575138ab27cd5c1b3e54da54d0a7cc8d85485402de26340c2145f0f6bb5e7a9f"),
    ("searchTracks", "b02683192a98dde7966b5e6655a79eeb62713eab703eda9902c932818dd52751"),
    ("profileAttributes", "08ffb4730af3746e04a8301396f20875dbbce10c75243803091a9274eacc8ac0"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyUser {
    pub name: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyAuthState {
    pub browser_signed_in: bool,
    pub connected: bool,
    pub signed_in: bool,
    pub user: Option<SpotifyUser>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPlaylist {
    pub id: String,
    pub name: String,
    pub owner: Option<String>,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: u64,
    pub image_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPage<T> {
    pub items: Vec<T>,
    pub total: u64,
    pub raw: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyPlaylistInfo {
    pub name: String,
    pub owner: Option<String>,
    pub image_url: Option<String>,
    pub total: u64,
}

#[derive(Debug, Clone)]
struct WebPlayerMeta {
    client_version: String,
    secret_version: u32,
    secret_codes: Vec<u32>,
    hashes: HashMap<String, String>,
    complete: bool,
    at: Instant,
}

#[derive(Debug, Clone)]
struct AccessToken {
    token: String,
    expires_at_ms: u64,
    client_id: Option<String>,
    cookie: String,
}

#[derive(Debug, Clone)]
struct ClientToken {
    token: String,
    expires_at_ms: u64,
}

pub struct SpotifyService {
    vault: Arc<SecretVault>,
    http: reqwest::Client,
    web_player: Mutex<Option<WebPlayerMeta>>,
    access: Mutex<Option<AccessToken>>,
    client_tok: Mutex<Option<ClientToken>>,
    profile_cache: Mutex<Option<SpotifyUser>>,
    retry_after: Mutex<Option<Instant>>,
}

impl SpotifyService {
    pub fn new(vault: Arc<SecretVault>, http: reqwest::Client) -> Self {
        Self {
            vault,
            http,
            web_player: Mutex::new(None),
            access: Mutex::new(None),
            client_tok: Mutex::new(None),
            profile_cache: Mutex::new(None),
            retry_after: Mutex::new(None),
        }
    }

    pub fn save_sp_dc(&self, sp_dc: Option<String>) -> Result<()> {
        self.vault.update(|data| {
            data.spotify_sp_dc = sp_dc.filter(|s| !s.trim().is_empty());
            data.spotify_connected = true;
        })?;
        self.invalidate_session();
        Ok(())
    }

    pub fn invalidate_session(&self) {
        *self.access.lock() = None;
        *self.client_tok.lock() = None;
        *self.profile_cache.lock() = None;
        *self.retry_after.lock() = None;
    }

    pub async fn set_connected(&self, connected: bool) -> Result<SpotifyAuthState> {
        self.vault.update(|data| {
            data.spotify_connected = connected;
        })?;
        self.invalidate_session();
        Ok(self.auth_state(false).await)
    }

    pub async fn auth_state(&self, refresh: bool) -> SpotifyAuthState {
        if refresh {
            self.invalidate_session();
        }
        let snap = self.vault.snapshot();
        let browser_signed_in = snap.spotify_sp_dc.is_some();
        let base = SpotifyAuthState {
            browser_signed_in,
            connected: snap.spotify_connected,
            signed_in: false,
            user: None,
            problem: None,
        };
        if !browser_signed_in || !snap.spotify_connected {
            return base;
        }
        if let Some(cached) = self.profile_cache.lock().clone() {
            return SpotifyAuthState {
                signed_in: true,
                user: Some(cached),
                ..base
            };
        }
        match self.gql("profileAttributes", json!({})).await {
            Ok(root) => {
                let profile = root.pointer("/data/me/profile");
                let name = profile
                    .and_then(|p| p.get("name").or_else(|| p.get("username")))
                    .and_then(Value::as_str)
                    .unwrap_or("Spotify")
                    .to_string();
                let avatar_url = profile
                    .and_then(|p| p.pointer("/avatar/sources"))
                    .and_then(|s| sized_image(s, 64));
                let user = SpotifyUser { name, avatar_url };
                *self.profile_cache.lock() = Some(user.clone());
                SpotifyAuthState {
                    signed_in: true,
                    user: Some(user),
                    ..base
                }
            }
            Err(err) => SpotifyAuthState {
                problem: Some(err.to_string()),
                ..base
            },
        }
    }

    pub async fn playlists(&self, offset: u64) -> Result<SpotifyPage<SpotifyPlaylist>> {
        let root = self
            .gql(
                "libraryV3",
                json!({
                    "filters": ["Playlists"],
                    "order": null,
                    "textFilter": "",
                    "features": ["LIKED_SONGS", "YOUR_EPISODES_V2", "PRERELEASES", "EVENTS"],
                    "limit": 50,
                    "offset": offset,
                    "flatten": true,
                    "expandedFolders": [],
                    "folderUri": null,
                    "includeFoldersWhenFlattening": false
                }),
            )
            .await?;
        let mut page = parse_playlist_page(&root)?;
        if offset == 0 {
            page.items.insert(
                0,
                SpotifyPlaylist {
                    id: LIKED_ID.into(),
                    name: "Liked Songs".into(),
                    owner: None,
                    image_url: Some(LIKED_COVER.into()),
                },
            );
        }
        Ok(page)
    }

    pub async fn tracks(&self, playlist_id: &str, offset: u64) -> Result<SpotifyPage<SpotifyTrack>> {
        if playlist_id == LIKED_ID {
            let root = self
                .gql("fetchLibraryTracks", json!({ "offset": offset, "limit": 100 }))
                .await?;
            return parse_liked_page(&root);
        }
        let root = self
            .gql(
                "fetchPlaylist",
                json!({
                    "uri": format!("spotify:playlist:{playlist_id}"),
                    "offset": offset,
                    "limit": 100,
                    "enableWatchFeedEntrypoint": false
                }),
            )
            .await?;
        parse_track_page(&root)
    }

    pub async fn playlist_info(&self, playlist_id: &str) -> Result<SpotifyPlaylistInfo> {
        if playlist_id == LIKED_ID {
            let page = self.tracks(LIKED_ID, 0).await?;
            return Ok(SpotifyPlaylistInfo {
                name: "Liked Songs".into(),
                owner: None,
                image_url: Some(LIKED_COVER.into()),
                total: page.total,
            });
        }
        let root = self
            .gql(
                "fetchPlaylist",
                json!({
                    "uri": format!("spotify:playlist:{playlist_id}"),
                    "offset": 0,
                    "limit": 1,
                    "enableWatchFeedEntrypoint": false
                }),
            )
            .await?;
        let playlist = root.pointer("/data/playlistV2");
        Ok(SpotifyPlaylistInfo {
            name: playlist
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("Playlist")
                .to_string(),
            owner: playlist
                .and_then(|p| p.pointer("/ownerV2/data/name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            image_url: playlist
                .and_then(|p| p.pointer("/images/items/0/sources"))
                .and_then(largest_image),
            total: playlist
                .and_then(|p| p.pointer("/content/totalCount"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }

    pub async fn search_tracks(&self, query: &str) -> Result<Vec<SpotifyTrack>> {
        let root = self
            .gql(
                "searchTracks",
                json!({
                    "searchTerm": query,
                    "offset": 0,
                    "limit": 10,
                    "numberOfTopResults": 5,
                    "includeAudiobooks": false,
                    "includePreReleases": false,
                    "includeAuthors": false
                }),
            )
            .await?;
        Ok(parse_search_tracks(&root))
    }

    pub async fn canvas(&self, track_id: &str) -> Result<Option<String>> {
        let root = self
            .gql("canvas", json!({ "trackUri": format!("spotify:track:{track_id}") }))
            .await?;
        Ok(parse_canvas(&root))
    }

    async fn web_player(&self, force: bool) -> WebPlayerMeta {
        if !force {
            if let Some(cached) = self.web_player.lock().clone() {
                let ttl = if cached.complete { FOUND_TTL } else { MISSED_TTL };
                if cached.at.elapsed() < ttl {
                    return cached;
                }
            }
        }
        let meta = self.read_web_player().await;
        *self.web_player.lock() = Some(meta.clone());
        meta
    }

    async fn read_web_player(&self) -> WebPlayerMeta {
        let html = self.fetch_text(&format!("{WEB_PLAYER}/")).await.unwrap_or_default();
        let mut client_version = String::new();
        if let Ok(re) = Regex::new(r#"<script id="appServerConfig" type="text/plain">([^<]+)</script>"#) {
            if let Some(cap) = re.captures(&html).and_then(|c| c.get(1)) {
                if let Ok(decoded) = base64::engine::general_purpose::STANDARD.decode(cap.as_str()) {
                    if let Ok(val) = serde_json::from_slice::<Value>(&decoded) {
                        if let Some(ver) = val.get("clientVersion").and_then(Value::as_str) {
                            client_version = ver.to_string();
                        }
                    }
                }
            }
        }
        let bundle_url = Regex::new(r#"https://open\.spotifycdn\.com/cdn/build/web-player/web-player\.[0-9a-f]+\.js"#)
            .ok()
            .and_then(|re| re.find(&html))
            .map(|m| m.as_str().to_string());
        let bundle = match bundle_url {
            Some(url) => self.fetch_text(&url).await.unwrap_or_default(),
            None => String::new(),
        };

        let mut search_chunk = String::new();
        if let Some(search_id) = Regex::new(r#"(\d+):"xpui-routes-search""#)
            .ok()
            .and_then(|re| re.captures(&bundle))
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
        {
            if let Ok(part_re) = Regex::new(&format!(r#"\b{search_id}:"([0-9a-f]{{8}})""#)) {
                for cap in part_re.captures_iter(&bundle) {
                    if let Some(part) = cap.get(1) {
                        if let Some(chunk) = self
                            .fetch_text(&format!("{CDN}xpui-routes-search.{}.js", part.as_str()))
                            .await
                        {
                            search_chunk = chunk;
                            break;
                        }
                    }
                }
            }
        }

        let secret = secrets_in(&bundle).into_iter().next();
        let mut hashes = HashMap::new();
        let mut all_found = true;
        for (op, fallback) in OPERATIONS {
            let found = query_hash_in(&bundle, op).or_else(|| query_hash_in(&search_chunk, op));
            if found.is_none() {
                all_found = false;
            }
            hashes.insert((*op).to_string(), found.unwrap_or_else(|| (*fallback).to_string()));
        }
        let complete = secret.is_some() && !client_version.is_empty() && all_found;
        let (secret_version, secret_codes) = secret
            .unwrap_or_else(|| (FALLBACK_SECRET_VERSION, FALLBACK_SECRET_CODES.to_vec()));

        WebPlayerMeta {
            client_version: if client_version.is_empty() {
                "1.2.77.0".into()
            } else {
                client_version
            },
            secret_version,
            secret_codes,
            hashes,
            complete,
            at: Instant::now(),
        }
    }

    async fn fetch_text(&self, url: &str) -> Option<String> {
        let resp = self.http.get(url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        resp.text().await.ok()
    }

    async fn access_token(&self) -> Result<AccessToken> {
        let snap = self.vault.snapshot();
        if !snap.spotify_connected {
            return Err(anyhow!("unauthenticated: Spotify is disconnected"));
        }
        let cookie = snap
            .spotify_sp_dc
            .ok_or_else(|| anyhow!("unauthenticated: Not signed in to Spotify"))?;

        let now = now_ms();
        if let Some(held) = self.access.lock().clone() {
            if held.cookie == cookie && now + 30_000 < held.expires_at_ms {
                return Ok(held);
            }
            if held.cookie != cookie {
                self.invalidate_session();
            }
        }
        if let Some(until) = *self.retry_after.lock() {
            if Instant::now() < until {
                return Err(anyhow!("unauthenticated: Spotify token mint cooling down"));
            }
        }

        for force in [false, true] {
            let player = self.web_player(force).await;
            let code = totp(&player.secret_codes, now_ms());
            let url = format!(
                "{WEB_PLAYER}/api/token?reason=init&productType=web-player&totp={code}&totpServer={code}&totpVer={}",
                player.secret_version
            );
            let resp = self
                .http
                .get(&url)
                .header("Cookie", format!("sp_dc={cookie}"))
                .header("Origin", WEB_PLAYER)
                .header("Referer", format!("{WEB_PLAYER}/"))
                .send()
                .await?;
            let status = resp.status().as_u16();
            let body = resp.json::<Value>().await.unwrap_or_else(|_| json!({}));

            if body.get("totpVerExpired").is_some() && !force {
                continue;
            }
            if status == 401 {
                return Err(anyhow!(
                    "unauthenticated: Spotify session expired. Sign in again."
                ));
            }
            if body.get("isAnonymous").and_then(Value::as_bool) == Some(true) {
                return Err(anyhow!("unauthenticated: Not signed in to Spotify"));
            }
            if let Some(token) = body.get("accessToken").and_then(Value::as_str) {
                let held = AccessToken {
                    token: token.to_string(),
                    expires_at_ms: body
                        .get("accessTokenExpirationTimestampMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(now_ms() + 3_600_000),
                    client_id: body
                        .get("clientId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    cookie,
                };
                *self.access.lock() = Some(held.clone());
                return Ok(held);
            }
            if force {
                break;
            }
        }
        *self.retry_after.lock() = Some(Instant::now() + RETRY_COOLDOWN);
        Err(anyhow!("unauthenticated: Spotify would not mint a token"))
    }

    async fn get_device_id(&self) -> String {
        let snap = self.vault.snapshot();
        if let Some(id) = snap.spotify_device_id {
            return id;
        }
        let fresh = Uuid::new_v4().simple().to_string();
        let _ = self.vault.update(|data| {
            data.spotify_device_id = Some(fresh.clone());
        });
        fresh
    }

    async fn client_token(&self, bearer: &AccessToken, player: &WebPlayerMeta) -> Option<String> {
        if let Some(held) = self.client_tok.lock().clone() {
            if now_ms() + 30_000 < held.expires_at_ms {
                return Some(held.token);
            }
        }
        let client_id = bearer.client_id.as_deref()?;
        let device_id = self.get_device_id().await;
        let payload = json!({
            "client_data": {
                "client_version": player.client_version,
                "client_id": client_id,
                "js_sdk_data": {
                    "device_brand": "unknown",
                    "device_model": "unknown",
                    "os": "windows",
                    "os_version": "unknown",
                    "device_id": device_id,
                    "device_type": "computer"
                }
            }
        });
        // Bare application/json header: clienttoken rejects charset suffixes with 400.
        let resp = self
            .http
            .post(CLIENT_TOKEN)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Origin", WEB_PLAYER)
            .header("Referer", format!("{WEB_PLAYER}/"))
            .body(serde_json::to_vec(&payload).ok()?)
            .send()
            .await
            .ok()?;
        let body = resp.json::<Value>().await.ok()?;
        if body.get("response_type").and_then(Value::as_str)
            != Some("RESPONSE_GRANTED_TOKEN_RESPONSE")
        {
            return None;
        }
        let granted = body.get("granted_token")?;
        let token = granted.get("token")?.as_str()?.to_string();
        let ttl_s = granted
            .get("expires_after_seconds")
            .and_then(Value::as_u64)
            .unwrap_or(3600);
        *self.client_tok.lock() = Some(ClientToken {
            token: token.clone(),
            expires_at_ms: now_ms() + ttl_s * 1000,
        });
        Some(token)
    }

    async fn gql(&self, operation: &str, variables: Value) -> Result<Value> {
        for attempt in 0..2 {
            let retried = attempt > 0;
            let bearer = self.access_token().await?;
            let player = self.web_player(false).await;
            let ctok = self.client_token(&bearer, &player).await;
            let hash = player
                .hashes
                .get(operation)
                .cloned()
                .ok_or_else(|| anyhow!("Missing Spotify query hash for {operation}"))?;

            let mut req = self
                .http
                .post(PATHFINDER)
                .header("Authorization", format!("Bearer {}", bearer.token))
                .header("Accept", "application/json")
                .header("Content-Type", "application/json;charset=UTF-8")
                .header("App-Platform", "WebPlayer")
                .header("Origin", WEB_PLAYER)
                .header("Referer", format!("{WEB_PLAYER}/"));
            if let Some(token) = ctok {
                req = req.header("Client-Token", token);
            }
            let body = json!({
                "variables": variables,
                "operationName": operation,
                "extensions": { "persistedQuery": { "version": 1, "sha256Hash": hash } }
            });
            let resp = req.json(&body).send().await?;
            let status = resp.status();
            if status.as_u16() == 401 && !retried {
                *self.access.lock() = None;
                *self.client_tok.lock() = None;
                continue;
            }
            let parsed = resp.json::<Value>().await.ok();
            let errors: Vec<String> = parsed
                .as_ref()
                .and_then(|v| v.get("errors"))
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| e.get("message").and_then(Value::as_str).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();

            if errors
                .iter()
                .any(|m| m.to_lowercase().contains("persistedquerynotfound"))
                && !retried
            {
                self.web_player(true).await;
                continue;
            }
            if !status.is_success() {
                return Err(anyhow!("Spotify {operation} failed ({})", status.as_u16()));
            }
            let Some(root) = parsed else {
                return Err(anyhow!("Spotify {operation} returned non-JSON payload"));
            };
            if !errors.is_empty() && root.get("data").is_none() {
                return Err(anyhow!(errors.join("; ")));
            }
            return Ok(root);
        }
        Err(anyhow!("Spotify {operation} exhausted retries"))
    }
}

pub fn totp(codes: &[u32], epoch_ms: u64) -> String {
    let key_str: String = codes
        .iter()
        .enumerate()
        .map(|(i, code)| (*code ^ (((i as u32) % 33) + 9)).to_string())
        .collect();
    let counter = (epoch_ms / 1000 / 30).to_be_bytes();
    let mut mac = Hmac::<Sha1>::new_from_slice(key_str.as_bytes()).expect("HMAC accepts any key");
    mac.update(&counter);
    let hash = mac.finalize().into_bytes();
    let offset = (hash[hash.len() - 1] & 0x0f) as usize;
    let binary = (((hash[offset] & 0x7f) as u32) << 24)
        | ((hash[offset + 1] as u32) << 16)
        | ((hash[offset + 2] as u32) << 8)
        | (hash[offset + 3] as u32);
    format!("{:06}", binary % 1_000_000)
}

fn unescape_js(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('b') => out.push('\u{0008}'),
            Some('f') => out.push('\u{000c}'),
            Some('v') => out.push('\u{000b}'),
            Some('0') => out.push('\0'),
            Some('x') => {
                let hex: String = chars.by_ref().take(2).collect();
                if let Ok(v) = u8::from_str_radix(&hex, 16) {
                    out.push(v as char);
                }
            }
            Some('u') => {
                if chars.peek() == Some(&'{') {
                    chars.next();
                    let mut hex = String::new();
                    for ch in chars.by_ref() {
                        if ch == '}' {
                            break;
                        }
                        hex.push(ch);
                    }
                    if let Ok(v) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(v) {
                            out.push(ch);
                        }
                    }
                } else {
                    let hex: String = chars.by_ref().take(4).collect();
                    if let Ok(v) = u32::from_str_radix(&hex, 16) {
                        if let Some(ch) = char::from_u32(v) {
                            out.push(ch);
                        }
                    }
                }
            }
            Some(other) => out.push(other),
            None => break,
        }
    }
    out
}

pub fn secrets_in(script: &str) -> Vec<(u32, Vec<u32>)> {
    let mut found = Vec::new();
    for quote in ['\'', '"'] {
        let pattern = format!(r"\{{secret:{q}((?:\\.|[^{q}])*){q},version:(\d+)\}}", q = quote);
        if let Ok(re) = Regex::new(&pattern) {
            for cap in re.captures_iter(script) {
                if let (Some(raw), Some(ver)) = (cap.get(1), cap.get(2)) {
                    if let Ok(version) = ver.as_str().parse::<u32>() {
                        let codes = unescape_js(raw.as_str())
                            .encode_utf16()
                            .map(u32::from)
                            .collect();
                        found.push((version, codes));
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found
}

fn query_hash_in(script: &str, operation: &str) -> Option<String> {
    let re = Regex::new(&format!(
        r#"["']{operation}["']\s*,\s*["']query["']\s*,\s*["']([0-9a-f]{{64}})["']"#
    ))
    .ok()?;
    re.captures(script)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn largest_image(sources: &Value) -> Option<String> {
    sources
        .as_array()?
        .iter()
        .filter_map(|s| {
            let url = s.get("url")?.as_str()?;
            let width = s.get("width").and_then(Value::as_u64).unwrap_or(0);
            Some((width, url))
        })
        .max_by_key(|(w, _)| *w)
        .map(|(_, url)| url.to_string())
}

fn sized_image(sources: &Value, min_width: u64) -> Option<String> {
    let mut items: Vec<(u64, &str)> = sources
        .as_array()?
        .iter()
        .filter_map(|s| {
            let url = s.get("url")?.as_str()?;
            let width = s.get("width").and_then(Value::as_u64).unwrap_or(0);
            Some((width, url))
        })
        .collect();
    items.sort_by_key(|(w, _)| *w);
    items
        .iter()
        .find(|(w, _)| *w >= min_width)
        .or_else(|| items.last())
        .map(|(_, url)| (*url).to_string())
}

fn track_of(data: &Value, uri: Option<&str>) -> Option<SpotifyTrack> {
    let title = data.get("name")?.as_str()?.trim();
    let uri = uri?;
    if title.is_empty() {
        return None;
    }
    let artist = data
        .pointer("/artists/items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|a| a.pointer("/profile/name").and_then(Value::as_str))
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let album_obj = data.get("albumOfTrack");
    let album = album_obj
        .and_then(|a| a.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let duration_ms = data
        .pointer("/trackDuration/totalMilliseconds")
        .or_else(|| data.pointer("/duration/totalMilliseconds"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let image_url = album_obj
        .and_then(|a| a.pointer("/coverArt/sources"))
        .and_then(|s| sized_image(s, 300));
    Some(SpotifyTrack {
        id: uri.rsplit(':').next()?.to_string(),
        title: title.to_string(),
        artist,
        album,
        duration_ms,
        image_url,
    })
}

fn parse_playlist_page(root: &Value) -> Result<SpotifyPage<SpotifyPlaylist>> {
    let library = root
        .pointer("/data/me/libraryV3")
        .ok_or_else(|| anyhow!("Spotify library response was empty"))?;
    let raw = library
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut items = Vec::new();
    for entry in raw {
        let Some(wrapper) = entry.get("item") else {
            continue;
        };
        let typename = wrapper
            .get("__typename")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !typename.to_lowercase().contains("playlist") {
            continue;
        }
        let Some(data) = wrapper.get("data") else {
            continue;
        };
        if data.get("__typename").and_then(Value::as_str) != Some("Playlist") {
            continue;
        }
        let Some(uri) = wrapper.get("_uri").and_then(Value::as_str) else {
            continue;
        };
        let Some(name) = data.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.trim().is_empty() {
            continue;
        }
        items.push(SpotifyPlaylist {
            id: uri.rsplit(':').next().unwrap_or(uri).to_string(),
            name: name.to_string(),
            owner: data
                .pointer("/ownerV2/data/name")
                .and_then(Value::as_str)
                .map(str::to_string),
            image_url: data
                .pointer("/images/items/0/sources")
                .and_then(largest_image),
        });
    }
    Ok(SpotifyPage {
        items,
        total: library
            .get("totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(raw.len() as u64),
        raw: raw.len() as u64,
    })
}

fn parse_track_page(root: &Value) -> Result<SpotifyPage<SpotifyTrack>> {
    let content = root
        .pointer("/data/playlistV2/content")
        .ok_or_else(|| anyhow!("Spotify playlist response was empty"))?;
    let raw = content
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut items = Vec::new();
    for entry in raw {
        let Some(data) = entry.pointer("/itemV2/data") else {
            continue;
        };
        let uri = data
            .get("uri")
            .or_else(|| data.get("_uri"))
            .and_then(Value::as_str);
        if let Some(track) = track_of(data, uri) {
            items.push(track);
        }
    }
    Ok(SpotifyPage {
        items,
        total: content
            .get("totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(raw.len() as u64),
        raw: raw.len() as u64,
    })
}

fn parse_liked_page(root: &Value) -> Result<SpotifyPage<SpotifyTrack>> {
    let tracks = root
        .pointer("/data/me/library/tracks")
        .ok_or_else(|| anyhow!("Spotify liked songs response was empty"))?;
    let raw = tracks
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut items = Vec::new();
    for entry in raw {
        let Some(wrapper) = entry.get("track") else {
            continue;
        };
        let Some(data) = wrapper.get("data") else {
            continue;
        };
        let uri = wrapper
            .get("_uri")
            .or_else(|| data.get("uri"))
            .and_then(Value::as_str);
        if let Some(track) = track_of(data, uri) {
            items.push(track);
        }
    }
    Ok(SpotifyPage {
        items,
        total: tracks
            .get("totalCount")
            .and_then(Value::as_u64)
            .unwrap_or(raw.len() as u64),
        raw: raw.len() as u64,
    })
}

fn parse_search_tracks(root: &Value) -> Vec<SpotifyTrack> {
    root.pointer("/data/searchV2/tracksV2/items")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|entry| {
                    let data = entry.pointer("/item/data")?;
                    track_of(data, data.get("uri").and_then(Value::as_str))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_canvas(root: &Value) -> Option<String> {
    let url = root.pointer("/data/trackUnion/canvas/url")?.as_str()?;
    let lower = url.to_lowercase();
    if lower.starts_with("https://")
        && (lower.ends_with(".mp4") || lower.contains(".mp4?") || lower.contains(".mp4#"))
    {
        Some(url.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn totp_produces_deterministic_six_digit_code() {
        let code = totp(FALLBACK_SECRET_CODES, 1_700_000_000_000);
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(code, totp(FALLBACK_SECRET_CODES, 1_700_000_005_000));
    }

    #[test]
    fn parses_spotify_secret_from_bundle_snippet() {
        let snippet = r#"const s=[{secret:'abc',version:12},{secret:"xyz\x31",version:61}];"#;
        let found = secrets_in(snippet);
        assert_eq!(found[0].0, 61);
        assert_eq!(found[0].1, vec![120, 121, 122, 49]);
    }
}
