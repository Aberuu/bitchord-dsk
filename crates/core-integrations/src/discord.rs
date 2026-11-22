use anyhow::{anyhow, Result};
use base64::Engine;
use core_auth::{DiscordUser, SecretVault};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const APPLICATION_ID: &str = "1543679166967193620";
const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=9&encoding=json";
const API_BASE: &str = "https://discord.com/api/v9";
const PROJECT_URL: &str = "https://github.com/kushagrasinghx/BitChord";
const DEFAULT_BUTTON_1: &str = "Listen on YouTube Music";
const DEFAULT_BUTTON_2: &str = "Visit BitChord";
const APP_NAME: &str = "BitChord";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPublicUser {
    pub name: String,
    pub username: String,
    pub avatar_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordState {
    pub available: bool,
    pub connected: bool,
    pub enabled: bool,
    pub user: Option<DiscordPublicUser>,
    pub gateway: String,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordPresenceOptions {
    pub activity_type: String,
    pub status: String,
    pub use_details: bool,
    pub activity_name: String,
    pub button1_text: String,
    pub button1_visible: bool,
    pub button2_text: String,
    pub button2_visible: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordNowPlaying {
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub position_ms: f64,
    pub duration_ms: f64,
    pub playback_rate: f64,
}

enum GatewayCmd {
    SendPresence(Value),
    Clear,
    Close,
}

pub struct DiscordService {
    vault: Arc<SecretVault>,
    http: reqwest::Client,
    artwork_cache: Mutex<HashMap<String, Option<String>>>,
    gateway_status: Arc<Mutex<(String, Option<String>)>>,
    gateway_tx: Mutex<Option<mpsc::UnboundedSender<GatewayCmd>>>,
    on_state: Arc<dyn Fn(DiscordState) + Send + Sync>,
}

impl DiscordService {
    pub fn new(
        vault: Arc<SecretVault>,
        http: reqwest::Client,
        on_state: Arc<dyn Fn(DiscordState) + Send + Sync>,
    ) -> Self {
        Self {
            vault,
            http,
            artwork_cache: Mutex::new(HashMap::new()),
            gateway_status: Arc::new(Mutex::new(("off".into(), None))),
            gateway_tx: Mutex::new(None),
            on_state,
        }
    }

    pub fn state(&self) -> DiscordState {
        let snap = self.vault.snapshot();
        let (gw, prob) = self.gateway_status.lock().clone();
        let user = snap.discord_user.map(|u| DiscordPublicUser {
            name: u.name,
            username: u.username,
            avatar_url: u.avatar_url,
        });
        DiscordState {
            available: true,
            connected: snap.discord_token.is_some() && user.is_some(),
            enabled: snap.discord_enabled,
            user,
            gateway: gw,
            problem: prob,
        }
    }

    fn announce(&self) {
        (self.on_state)(self.state());
    }

    pub async fn connect_with_token(&self, token: String) -> Result<DiscordState> {
        let clean = token.trim().trim_matches('"').to_string();
        if clean.is_empty() {
            return Err(anyhow!("Discord token was empty"));
        }
        let user = self.fetch_user_info(&clean).await?;
        self.vault.update(|data| {
            data.discord_token = Some(clean);
            data.discord_user = Some(user);
            data.discord_enabled = true;
        })?;
        *self.gateway_status.lock() = ("off".into(), None);
        self.announce();
        Ok(self.state())
    }

    pub fn set_enabled(&self, enabled: bool) -> Result<DiscordState> {
        self.vault.update(|data| {
            data.discord_enabled = enabled;
        })?;
        if !enabled {
            self.close_gateway();
        }
        self.announce();
        Ok(self.state())
    }

    pub fn disconnect(&self) -> Result<DiscordState> {
        self.close_gateway();
        self.artwork_cache.lock().clear();
        *self.gateway_status.lock() = ("off".into(), None);
        self.vault.update(|data| {
            data.discord_token = None;
            data.discord_user = None;
            data.discord_enabled = false;
        })?;
        self.announce();
        Ok(self.state())
    }

    pub async fn set_presence(
        &self,
        track: Option<DiscordNowPlaying>,
        options: DiscordPresenceOptions,
    ) -> Result<()> {
        let snap = self.vault.snapshot();
        let Some(token) = snap.discord_token else {
            return Ok(());
        };
        if !snap.discord_enabled {
            return Ok(());
        }

        let Some(track) = track else {
            if let Some(tx) = self.gateway_tx.lock().as_ref() {
                let _ = tx.send(GatewayCmd::Clear);
            }
            return Ok(());
        };

        let large_image = match track.artwork_url.as_deref() {
            Some(url) if url.starts_with("http") => self
                .external_asset(&token, url)
                .await
                .or_else(|| Some(url.to_string())),
            _ => None,
        };
        let payload = build_presence(&track, &options, large_image, now_ms());
        let tx = self.ensure_gateway(token);
        let _ = tx.send(GatewayCmd::SendPresence(payload));
        Ok(())
    }

    pub fn shutdown(&self) {
        self.close_gateway();
    }

    fn close_gateway(&self) {
        if let Some(tx) = self.gateway_tx.lock().take() {
            let _ = tx.send(GatewayCmd::Close);
        }
        *self.gateway_status.lock() = ("off".into(), None);
    }

    fn ensure_gateway(&self, token: String) -> mpsc::UnboundedSender<GatewayCmd> {
        let mut guard = self.gateway_tx.lock();
        if let Some(tx) = guard.as_ref() {
            if !tx.is_closed() {
                return tx.clone();
            }
        }
        let (tx, rx) = mpsc::unbounded_channel();
        *guard = Some(tx.clone());
        let vault = Arc::clone(&self.vault);
        let status_cell = Arc::clone(&self.gateway_status);
        let on_state = Arc::clone(&self.on_state);
        tokio::spawn(async move {
            run_gateway_loop(token, rx, vault, status_cell, on_state).await;
        });
        tx
    }

    async fn fetch_user_info(&self, token: &str) -> Result<DiscordUser> {
        let resp = self
            .http
            .get(format!("{API_BASE}/users/@me"))
            .header("Authorization", token)
            .header("X-Super-Properties", super_properties_b64())
            .header("Origin", "https://discord.com")
            .header("Referer", "https://discord.com/")
            .send()
            .await?;
        if resp.status().as_u16() == 401 {
            return Err(anyhow!("unauthenticated: Discord refused the token"));
        }
        if !resp.status().is_success() {
            return Err(anyhow!("Discord /users/@me failed ({})", resp.status().as_u16()));
        }
        let me = resp.json::<Value>().await?;
        let id = me
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Missing Discord user id"))?
            .to_string();
        let username = me
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("Discord")
            .to_string();
        let name = me
            .get("global_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&username)
            .to_string();
        let avatar_url = me
            .get("avatar")
            .and_then(Value::as_str)
            .map(|av| format!("https://cdn.discordapp.com/avatars/{id}/{av}.png"));
        Ok(DiscordUser {
            id,
            name,
            username,
            avatar_url,
        })
    }

    async fn external_asset(&self, token: &str, image_url: &str) -> Option<String> {
        if let Some(cached) = self.artwork_cache.lock().get(image_url).cloned() {
            return cached;
        }
        let resp = self
            .http
            .post(format!(
                "{API_BASE}/applications/{APPLICATION_ID}/external-assets"
            ))
            .header("Authorization", token)
            .header("X-Super-Properties", super_properties_b64())
            .header("Origin", "https://discord.com")
            .header("Referer", "https://discord.com/")
            .json(&json!({ "urls": [image_url] }))
            .send()
            .await
            .ok()?;
        let asset = if resp.status().is_success() {
            resp.json::<Value>()
                .await
                .ok()
                .and_then(|v| {
                    v.as_array()?
                        .first()?
                        .get("external_asset_path")?
                        .as_str()
                        .map(|p| format!("mp:{p}"))
                })
        } else {
            None
        };
        let mut cache = self.artwork_cache.lock();
        if cache.len() >= 50 {
            cache.clear();
        }
        cache.insert(image_url.to_string(), asset.clone());
        asset
    }
}

pub fn build_presence(
    track: &DiscordNowPlaying,
    options: &DiscordPresenceOptions,
    large_image: Option<String>,
    now_ms: u64,
) -> Value {
    let rate = if track.playback_rate > 0.0 {
        track.playback_rate
    } else {
        1.0
    };
    let watch_url = format!("https://music.youtube.com/watch?v={}", track.video_id);
    let mut buttons: Vec<(String, String)> = Vec::new();
    if options.button1_visible {
        let raw = if options.button1_text.trim().is_empty() {
            DEFAULT_BUTTON_1
        } else {
            options.button1_text.as_str()
        };
        buttons.push((resolve_vars(raw, track), watch_url.clone()));
    }
    if options.button2_visible {
        let raw = if options.button2_text.trim().is_empty() {
            DEFAULT_BUTTON_2
        } else {
            options.button2_text.as_str()
        };
        buttons.push((resolve_vars(raw, track), PROJECT_URL.to_string()));
    }

    let details = if (rate - 1.0).abs() > 0.001 {
        format!("{} [{:.2}x]", track.title, rate)
    } else {
        track.title.clone()
    };
    let activity_type = match options.activity_type.as_str() {
        "playing" => 0,
        "watching" => 3,
        "competing" => 5,
        _ => 2,
    };
    let start = (now_ms as f64 - track.position_ms / rate).round() as u64;
    let remaining = (track.duration_ms - track.position_ms).max(0.0);
    let end = (now_ms as f64 + remaining / rate).round() as u64;

    let mut activity = json!({
        "name": if options.activity_name.trim().is_empty() { APP_NAME } else { options.activity_name.trim() },
        "details": details,
        "details_url": watch_url,
        "state": track.artist,
        "state_url": Value::Null,
        "type": activity_type,
        "status_display_type": if options.use_details { 2 } else { 1 },
        "timestamps": { "start": start, "end": end },
        "assets": {
            "large_image": large_image,
            "small_image": Value::Null,
            "large_text": Value::Null,
            "small_text": Value::Null
        },
        "url": Value::Null
    });

    if !buttons.is_empty() {
        if let Some(obj) = activity.as_object_mut() {
            obj.insert(
                "buttons".into(),
                Value::Array(buttons.iter().map(|(l, _)| Value::String(l.clone())).collect()),
            );
            obj.insert(
                "metadata".into(),
                json!({
                    "button_urls": buttons.iter().map(|(_, u)| u.clone()).collect::<Vec<_>>()
                }),
            );
            obj.insert("application_id".into(), Value::String(APPLICATION_ID.into()));
        }
    }

    json!({
        "activities": [activity],
        "afk": true,
        "since": now_ms,
        "status": options.status
    })
}

fn resolve_vars(text: &str, track: &DiscordNowPlaying) -> String {
    text.replace("{song_name}", &track.title)
        .replace("{artist_name}", &track.artist)
        .replace("{album_name}", track.album.as_deref().unwrap_or(""))
}

fn super_properties_b64() -> String {
    let props = json!({
        "os": "Windows",
        "browser": "Discord Client",
        "device": "",
        "system_locale": "en-US",
        "release_channel": "stable",
        "client_build_number": 352675,
        "client_event_source": Value::Null
    });
    base64::engine::general_purpose::STANDARD.encode(props.to_string().as_bytes())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn run_gateway_loop(
    token: String,
    mut rx: mpsc::UnboundedReceiver<GatewayCmd>,
    vault: Arc<SecretVault>,
    status_cell: Arc<Mutex<(String, Option<String>)>>,
    on_state: Arc<dyn Fn(DiscordState) + Send + Sync>,
) {
    let set_status = |gateway: &str, problem: Option<String>| {
        *status_cell.lock() = (gateway.to_string(), problem.clone());
        let snap = vault.snapshot();
        let user = snap.discord_user.map(|u| DiscordPublicUser {
            name: u.name,
            username: u.username,
            avatar_url: u.avatar_url,
        });
        on_state(DiscordState {
            available: true,
            connected: snap.discord_token.is_some() && user.is_some(),
            enabled: snap.discord_enabled,
            user,
            gateway: gateway.to_string(),
            problem,
        });
    };

    let mut backoff = Duration::from_secs(1);
    let mut session_id: Option<String> = None;
    let mut resume_url: Option<String> = None;
    let mut sequence: Option<u64> = None;
    let mut last_presence: Option<Value> = None;

    loop {
        set_status("connecting", None);
        let url = resume_url.as_deref().unwrap_or(GATEWAY_URL);
        let ws = match tokio_tungstenite::connect_async(url).await {
            Ok((stream, _)) => stream,
            Err(_) => {
                session_id = None;
                resume_url = None;
                sequence = None;
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                        continue;
                    }
                    cmd = rx.recv() => {
                        match cmd {
                            Some(GatewayCmd::SendPresence(p)) => { last_presence = Some(p); continue; }
                            Some(GatewayCmd::Clear) => { last_presence = Some(clear_presence()); continue; }
                            Some(GatewayCmd::Close) | None => { set_status("off", None); return; }
                        }
                    }
                }
            }
        };

        backoff = Duration::from_secs(1);
        let (mut write, mut read) = ws.split();
        let mut heartbeat_interval = Duration::from_secs(41);
        let mut heartbeat_tick = tokio::time::interval(heartbeat_interval);
        heartbeat_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut ready = false;
        let mut delivered: Option<String> = None;
        let mut awaiting_ack = false;
        let mut idle_close: Option<tokio::time::Instant> = None;

        loop {
            let idle_fut = async {
                match idle_close {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            };
            tokio::select! {
                _ = idle_fut => {
                    let _ = write.close().await;
                    set_status("off", None);
                    return;
                }
                _ = heartbeat_tick.tick() => {
                    if awaiting_ack {
                        let _ = write.close().await;
                        break;
                    }
                    awaiting_ack = true;
                    let hb = json!({ "op": 1, "d": sequence });
                    if write.send(Message::Text(hb.to_string().into())).await.is_err() {
                        break;
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(GatewayCmd::SendPresence(p)) => {
                            idle_close = None;
                            last_presence = Some(p.clone());
                            if ready {
                                let serialized = p.to_string();
                                if delivered.as_deref() != Some(serialized.as_str()) {
                                    let frame = json!({ "op": 3, "d": p });
                                    if write.send(Message::Text(frame.to_string().into())).await.is_ok() {
                                        delivered = Some(serialized);
                                    }
                                }
                            }
                        }
                        Some(GatewayCmd::Clear) => {
                            let cleared = clear_presence();
                            last_presence = Some(cleared.clone());
                            if ready {
                                let frame = json!({ "op": 3, "d": cleared });
                                let _ = write.send(Message::Text(frame.to_string().into())).await;
                                delivered = Some(cleared.to_string());
                            }
                            idle_close = Some(tokio::time::Instant::now() + Duration::from_secs(300));
                        }
                        Some(GatewayCmd::Close) | None => {
                            let cleared = clear_presence();
                            let _ = write.send(Message::Text(json!({ "op": 3, "d": cleared }).to_string().into())).await;
                            let _ = write.close().await;
                            set_status("off", None);
                            return;
                        }
                    }
                }
                frame = read.next() => {
                    match frame {
                        Some(Ok(Message::Text(text))) => {
                            let Ok(payload) = serde_json::from_str::<Value>(&text) else { continue };
                            if let Some(s) = payload.get("s").and_then(Value::as_u64) {
                                sequence = Some(s);
                            }
                            match payload.get("op").and_then(Value::as_u64).unwrap_or(99) {
                                10 => {
                                    if let Some(ms) = payload.pointer("/d/heartbeat_interval").and_then(Value::as_u64) {
                                        heartbeat_interval = Duration::from_millis(ms.max(5_000));
                                        heartbeat_tick = tokio::time::interval(heartbeat_interval);
                                        heartbeat_tick.tick().await;
                                    }
                                    let handshake = if let (Some(sid), Some(seq)) = (&session_id, sequence) {
                                        json!({ "op": 6, "d": { "token": token, "session_id": sid, "seq": seq } })
                                    } else {
                                        identify_frame(&token)
                                    };
                                    if write.send(Message::Text(handshake.to_string().into())).await.is_err() {
                                        break;
                                    }
                                }
                                11 => {
                                    awaiting_ack = false;
                                }
                                1 => {
                                    let hb = json!({ "op": 1, "d": sequence });
                                    let _ = write.send(Message::Text(hb.to_string().into())).await;
                                }
                                0 => {
                                    let evt = payload.get("t").and_then(Value::as_str).unwrap_or("");
                                    if evt == "READY" {
                                        session_id = payload.pointer("/d/session_id").and_then(Value::as_str).map(str::to_string);
                                        resume_url = payload.pointer("/d/resume_gateway_url").and_then(Value::as_str).map(|u| format!("{u}/?v=9&encoding=json"));
                                        ready = true;
                                        set_status("ready", None);
                                    } else if evt == "RESUMED" {
                                        ready = true;
                                        set_status("ready", None);
                                    }
                                    if ready {
                                        if let Some(p) = &last_presence {
                                            let serialized = p.to_string();
                                            if delivered.as_deref() != Some(serialized.as_str()) {
                                                let frame = json!({ "op": 3, "d": p });
                                                if write.send(Message::Text(frame.to_string().into())).await.is_ok() {
                                                    delivered = Some(serialized);
                                                }
                                            }
                                        }
                                    }
                                }
                                7 => {
                                    let _ = write.close().await;
                                    break;
                                }
                                9 => {
                                    session_id = None;
                                    resume_url = None;
                                    sequence = None;
                                    let _ = write.send(Message::Text(identify_frame(&token).to_string().into())).await;
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(close))) => {
                            if let Some(cf) = close {
                                if u16::from(cf.code) == 4004 {
                                    set_status("error", Some("Discord refused the token. Connect the account again.".into()));
                                    return;
                                }
                            }
                            break;
                        }
                        Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
            }
        }
    }
}

fn identify_frame(token: &str) -> Value {
    json!({
        "op": 2,
        "d": {
            "token": token,
            "capabilities": 16381,
            "properties": { "os": "Windows", "browser": "Discord Client", "device": "" },
            "presence": { "status": "online", "since": 0, "activities": [], "afk": false },
            "compress": false,
            "client_state": {
                "guild_versions": {},
                "highest_last_message_id": "0",
                "read_state_version": 0,
                "user_guild_settings_version": -1,
                "user_settings_version": -1,
                "private_channels_version": "0",
                "api_code_version": 0
            }
        }
    })
}

fn clear_presence() -> Value {
    json!({
        "activities": [],
        "afk": true,
        "since": 0,
        "status": "online"
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presence_divides_timestamps_by_playback_rate_and_substitutes_buttons() {
        let track = DiscordNowPlaying {
            video_id: "dQw4w9WgXcQ".into(),
            title: "Never Gonna Give You Up".into(),
            artist: "Rick Astley".into(),
            album: Some("Whenever You Need Somebody".into()),
            artwork_url: None,
            position_ms: 20_000.0,
            duration_ms: 200_000.0,
            playback_rate: 2.0,
        };
        let options = DiscordPresenceOptions {
            activity_type: "listening".into(),
            status: "online".into(),
            use_details: true,
            activity_name: String::new(),
            button1_text: "Play {song_name}".into(),
            button1_visible: true,
            button2_text: String::new(),
            button2_visible: false,
        };
        let payload = build_presence(&track, &options, None, 1_000_000);
        let act = &payload["activities"][0];
        assert_eq!(act["details"], "Never Gonna Give You Up [2.00x]");
        assert_eq!(act["timestamps"]["start"], 990_000);
        assert_eq!(act["timestamps"]["end"], 1_090_000);
        assert_eq!(act["buttons"][0], "Play Never Gonna Give You Up");
    }
}
