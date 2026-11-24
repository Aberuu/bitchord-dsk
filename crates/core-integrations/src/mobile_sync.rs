use crate::cast::probe::list_active_lan_adapters;
use anyhow::{Context, Result};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, options, post};
use axum::{Json, Router};
use core_stats::{ListeningStatsStore, PeerSyncResult};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, watch};
use tokio_tungstenite::tungstenite::handshake::server::{
    ErrorResponse as WsErrorResponse, Request as WsRequest, Response as WsResponse,
};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN: usize = 6;
const PLAY_LEAD_MS: i64 = 350;
const HEARTBEAT_SECS: u64 = 5;
const MAX_BACKUP_BYTES: usize = 32 * 1024 * 1024;
const MAX_QUEUE_LEN: usize = 500;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn generate_pin() -> String {
    let n: u32 = rand::rng().random_range(0..1_000_000);
    format!("{n:06}")
}

fn generate_code() -> String {
    let mut rng = rand::rng();
    (0..CODE_LEN)
        .map(|_| CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char)
        .collect()
}

fn generate_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileNowPlaying {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub status: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileSyncStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub local_ip: Option<String>,
    pub adapter_name: Option<String>,
    pub party_server_url: Option<String>,
    pub sync_portal_url: Option<String>,
    pub sync_pin: String,
    pub active_parties: usize,
    pub connected_clients: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartyTrack {
    video_id: String,
    title: String,
    artist: String,
    #[serde(default)]
    thumbnail_url: Option<String>,
    #[serde(default)]
    duration_ms: Option<i64>,
    #[serde(default)]
    from_autoplay: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartyMember {
    member_id: String,
    user_id: String,
    display_name: String,
    avatar_url: Option<String>,
    is_host: bool,
    connected: bool,
    joined_at_ms: i64,
    last_seen_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartyPlayback {
    seq: i64,
    track: Option<PartyTrack>,
    queue_seq: i64,
    queue_length: usize,
    queue_index: i32,
    is_playing: bool,
    position_ms: i64,
    anchor_ms: i64,
    effective_position_ms: i64,
    updated_by: Option<String>,
    started_by: Option<String>,
    started_by_name: Option<String>,
    autoplay_enabled: bool,
    updated_at_ms: i64,
}

impl PartyPlayback {
    fn empty(autoplay_enabled: bool) -> Self {
        Self {
            seq: 0,
            track: None,
            queue_seq: 0,
            queue_length: 0,
            queue_index: -1,
            is_playing: false,
            position_ms: 0,
            anchor_ms: 0,
            effective_position_ms: 0,
            updated_by: None,
            started_by: None,
            started_by_name: None,
            autoplay_enabled,
            updated_at_ms: now_ms(),
        }
    }

    fn effective_at(&self, at_ms: i64) -> i64 {
        if !self.is_playing || self.track.is_none() {
            return self.position_ms.max(0);
        }
        let elapsed = (at_ms - self.anchor_ms).max(0);
        let raw = self.position_ms.saturating_add(elapsed);
        if let Some(dur) = self.track.as_ref().and_then(|t| t.duration_ms) {
            if dur > 0 {
                return raw.min(dur);
            }
        }
        raw.max(0)
    }

    fn snapshot_at(&self, at_ms: i64) -> Self {
        let mut copy = self.clone();
        copy.effective_position_ms = self.effective_at(at_ms);
        copy
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PartyQueue {
    seq: i64,
    index: i32,
    items: Vec<PartyTrack>,
}

impl PartyQueue {
    fn empty() -> Self {
        Self {
            seq: 0,
            index: -1,
            items: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartySnapshot {
    code: String,
    created_at_ms: i64,
    max_members: usize,
    host_only_control: bool,
    members: Vec<PartyMember>,
    playback: PartyPlayback,
    queue: PartyQueue,
    server_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PartyMembership {
    code: String,
    token: String,
    you: PartyMember,
    party: PartySnapshot,
    server_ms: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JoinRequest {
    user_id: String,
    device_id: String,
    display_name: String,
    #[serde(default)]
    avatar_url: Option<String>,
    #[serde(default)]
    max_members: Option<usize>,
    #[serde(default)]
    autoplay_enabled: Option<bool>,
}

struct MemberEntry {
    member: PartyMember,
    device_id: String,
    token: String,
    sender: Option<mpsc::UnboundedSender<String>>,
}

struct PartyRoom {
    code: String,
    created_at_ms: i64,
    max_members: usize,
    host_only_control: bool,
    members: Vec<MemberEntry>,
    playback: PartyPlayback,
    queue: PartyQueue,
}

impl PartyRoom {
    fn snapshot(&self, at_ms: i64) -> PartySnapshot {
        PartySnapshot {
            code: self.code.clone(),
            created_at_ms: self.created_at_ms,
            max_members: self.max_members,
            host_only_control: self.host_only_control,
            members: self.members.iter().map(|m| m.member.clone()).collect(),
            playback: self.playback.snapshot_at(at_ms),
            queue: self.queue.clone(),
            server_ms: at_ms,
        }
    }

    fn broadcast(&self, frame: &Value) {
        let text = frame.to_string();
        for entry in &self.members {
            if let Some(tx) = &entry.sender {
                let _ = tx.send(text.clone());
            }
        }
    }

    fn broadcast_members(&self) {
        let members: Vec<PartyMember> = self.members.iter().map(|m| m.member.clone()).collect();
        self.broadcast(&json!({
            "type": "members",
            "members": members,
            "maxMembers": self.max_members,
            "hostOnlyControl": self.host_only_control,
            "serverMs": now_ms(),
        }));
    }

    fn ensure_host(&mut self) {
        if self.members.is_empty() {
            return;
        }
        if !self.members.iter().any(|m| m.member.is_host) {
            if let Some(first) = self.members.first_mut() {
                first.member.is_host = true;
            }
        }
    }
}

struct HubInner {
    parties: HashMap<String, PartyRoom>,
    sync_pin: String,
    now_playing: Option<MobileNowPlaying>,
}

struct SharedState {
    inner: Mutex<HubInner>,
    stats: Arc<ListeningStatsStore>,
    on_peer_sync: Arc<dyn Fn(PeerSyncResult) + Send + Sync>,
}

impl SharedState {
    fn verify_pin(&self, headers: &HeaderMap, query_pin: Option<&str>) -> bool {
        let expected = self.inner.lock().sync_pin.clone();
        let supplied = headers
            .get("x-sync-pin")
            .and_then(|v| v.to_str().ok())
            .or(query_pin)
            .map(str::trim)
            .unwrap_or("");
        !supplied.is_empty() && supplied == expected
    }

    fn auth_ws(&self, code: &str, token: &str) -> Option<String> {
        let guard = self.inner.lock();
        let room = guard.parties.get(&code.to_ascii_uppercase())?;
        room.members
            .iter()
            .find(|m| m.token == token)
            .map(|m| m.member.member_id.clone())
    }
}

struct RunningHandle {
    port: u16,
    shutdown_tx: watch::Sender<bool>,
}

pub struct MobileSyncService {
    shared: Arc<SharedState>,
    running: Mutex<Option<RunningHandle>>,
}

impl MobileSyncService {
    pub fn new(
        stats: Arc<ListeningStatsStore>,
        on_peer_sync: Arc<dyn Fn(PeerSyncResult) + Send + Sync>,
    ) -> Self {
        Self {
            shared: Arc::new(SharedState {
                inner: Mutex::new(HubInner {
                    parties: HashMap::new(),
                    sync_pin: generate_pin(),
                    now_playing: None,
                }),
                stats,
                on_peer_sync,
            }),
            running: Mutex::new(None),
        }
    }

    pub fn update_now_playing(&self, np: Option<MobileNowPlaying>) {
        self.shared.inner.lock().now_playing = np;
    }

    pub fn rotate_pin(&self) -> MobileSyncStatus {
        self.shared.inner.lock().sync_pin = generate_pin();
        self.status()
    }

    pub fn status(&self) -> MobileSyncStatus {
        let port = self.running.lock().as_ref().map(|h| h.port);
        let adapters = list_active_lan_adapters();
        let primary = adapters.first();
        let local_ip = primary
            .map(|a| a.ip.to_string())
            .or_else(|| Some("127.0.0.1".to_string()));
        let adapter_name = primary.map(|a| a.name.clone());

        let (sync_pin, active_parties, connected_clients) = {
            let guard = self.shared.inner.lock();
            let clients: usize = guard
                .parties
                .values()
                .map(|p| p.members.iter().filter(|m| m.member.connected).count())
                .sum();
            (guard.sync_pin.clone(), guard.parties.len(), clients)
        };

        let party_server_url = match (port, local_ip.as_deref()) {
            (Some(p), Some(ip)) => Some(format!("http://{ip}:{p}")),
            _ => None,
        };
        let sync_portal_url = party_server_url.as_ref().map(|u| format!("{u}/sync"));

        MobileSyncStatus {
            running: port.is_some(),
            port,
            local_ip,
            adapter_name,
            party_server_url,
            sync_portal_url,
            sync_pin,
            active_parties,
            connected_clients,
        }
    }

    pub async fn start(&self, preferred_port: Option<u16>) -> Result<MobileSyncStatus> {
        if self.running.lock().is_some() {
            return Ok(self.status());
        }

        let public_listener = match preferred_port {
            Some(p) if p > 0 => match TcpListener::bind(("0.0.0.0", p)).await {
                Ok(l) => l,
                Err(_) => TcpListener::bind(("0.0.0.0", 0))
                    .await
                    .context("Failed to bind LAN Mobile Sync TCP listener")?,
            },
            _ => TcpListener::bind(("0.0.0.0", 0))
                .await
                .context("Failed to bind LAN Mobile Sync TCP listener")?,
        };
        let public_port = public_listener.local_addr()?.port();

        let internal_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("Failed to bind internal HTTP router listener")?;
        let internal_addr = internal_listener.local_addr()?;

        let (shutdown_tx, mut shutdown_rx_http) = watch::channel(false);
        let mut shutdown_rx_accept = shutdown_tx.subscribe();

        let router = build_http_router(Arc::clone(&self.shared));
        tokio::spawn(async move {
            let server = axum::serve(internal_listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx_http.wait_for(|v| *v).await;
            });
            if let Err(err) = server.await {
                tracing::warn!("Mobile sync HTTP router exited: {err}");
            }
        });

        let shared_accept = Arc::clone(&self.shared);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = shutdown_rx_accept.wait_for(|v| *v) => break,
                    accepted = public_listener.accept() => {
                        let Ok((stream, _peer)) = accepted else { continue; };
                        let shared_conn = Arc::clone(&shared_accept);
                        tokio::spawn(async move {
                            handle_tcp_connection(stream, internal_addr, shared_conn).await;
                        });
                    }
                }
            }
        });

        *self.running.lock() = Some(RunningHandle {
            port: public_port,
            shutdown_tx,
        });

        Ok(self.status())
    }

    pub fn stop(&self) -> MobileSyncStatus {
        if let Some(handle) = self.running.lock().take() {
            let _ = handle.shutdown_tx.send(true);
        }
        self.status()
    }
}

impl Drop for MobileSyncService {
    fn drop(&mut self) {
        if let Some(handle) = self.running.lock().take() {
            let _ = handle.shutdown_tx.send(true);
        }
    }
}

async fn handle_tcp_connection(
    mut stream: TcpStream,
    internal_http_addr: SocketAddr,
    shared: Arc<SharedState>,
) {
    let mut peek_buf = [0u8; 4096];
    let n = match tokio::time::timeout(Duration::from_secs(5), stream.peek(&mut peek_buf)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return,
    };
    let head = String::from_utf8_lossy(&peek_buf[..n]).to_ascii_lowercase();
    let is_ws = head.contains("\r\nupgrade:") && head.contains("websocket");

    if is_ws {
        handle_ws_connection(stream, shared).await;
    } else if let Ok(mut upstream) = TcpStream::connect(internal_http_addr).await {
        let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
    }
}

async fn handle_ws_connection(stream: TcpStream, shared: Arc<SharedState>) {
    let auth_out: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let auth_shared = Arc::clone(&shared);
    let auth_capture = Arc::clone(&auth_out);

    let ws_stream = match tokio_tungstenite::accept_hdr_async(
        stream,
        move |req: &WsRequest, mut resp: WsResponse| -> Result<WsResponse, WsErrorResponse> {
            let path = req.uri().path();
            let code = path
                .strip_prefix("/ws/parties/")
                .map(|c| c.trim().to_ascii_uppercase())
                .unwrap_or_default();

            let mut token = req
                .headers()
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|raw| {
                    let mut parts = raw.splitn(2, ' ');
                    let scheme = parts.next()?;
                    let tok = parts.next()?;
                    if scheme.eq_ignore_ascii_case("bearer") {
                        Some(tok.trim().to_string())
                    } else {
                        None
                    }
                })
                .unwrap_or_default();

            let mut has_bitchord_v1 = false;
            if let Some(proto_header) = req
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok())
            {
                for proto in proto_header.split(',').map(str::trim) {
                    if proto == "bitchord.v1" {
                        has_bitchord_v1 = true;
                    } else if let Some(tok) = proto.strip_prefix("bitchord.token.") {
                        if token.is_empty() {
                            token = tok.trim().to_string();
                        }
                    }
                }
            }

            if has_bitchord_v1 {
                resp.headers_mut().insert(
                    "Sec-WebSocket-Protocol",
                    HeaderValue::from_static("bitchord.v1"),
                );
            }

            if code.is_empty() || token.is_empty() {
                let mut err = WsErrorResponse::new(Some("Missing party code or token".into()));
                *err.status_mut() = StatusCode::UNAUTHORIZED;
                return Err(err);
            }

            match auth_shared.auth_ws(&code, &token) {
                Some(member_id) => {
                    *auth_capture.lock() = Some((code, member_id));
                    Ok(resp)
                }
                None => {
                    let mut err = WsErrorResponse::new(Some("Invalid party token".into()));
                    *err.status_mut() = StatusCode::UNAUTHORIZED;
                    Err(err)
                }
            }
        },
    )
    .await
    {
        Ok(ws) => ws,
        Err(_) => return,
    };

    let Some((code, member_id)) = auth_out.lock().take() else {
        return;
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    // Register socket, send initial welcome frame first, then broadcast members.
    {
        let mut guard = shared.inner.lock();
        let Some(room) = guard.parties.get_mut(&code) else {
            return;
        };
        let ts = now_ms();
        let mut you_member = None;
        for entry in &mut room.members {
            if entry.member.member_id == member_id {
                entry.member.connected = true;
                entry.member.last_seen_ms = ts;
                entry.sender = Some(tx.clone());
                you_member = Some(entry.member.clone());
                break;
            }
        }
        let Some(you) = you_member else {
            return;
        };
        let snap = room.snapshot(ts);
        let _ = tx.send(
            json!({
                "type": "welcome",
                "you": you,
                "party": snap,
                "serverMs": ts,
            })
            .to_string(),
        );
        room.broadcast_members();
    };

    let (mut ws_sink, mut ws_read) = ws_stream.split();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if ws_sink.send(WsMessage::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    let heartbeat_shared = Arc::clone(&shared);
    let heartbeat_code = code.clone();
    let heartbeat_tx = tx.clone();
    let heartbeat = tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let frame = {
                let guard = heartbeat_shared.inner.lock();
                let Some(room) = guard.parties.get(&heartbeat_code) else {
                    break;
                };
                let ts = now_ms();
                json!({
                    "type": "state",
                    "playback": room.playback.snapshot_at(ts),
                    "serverMs": ts,
                })
                .to_string()
            };
            if heartbeat_tx.send(frame).is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_read.next().await {
        match msg {
            WsMessage::Text(text) => {
                if let Ok(val) = serde_json::from_str::<Value>(&text) {
                    handle_ws_message(&shared, &code, &member_id, &tx, val);
                }
            }
            WsMessage::Close(_) => break,
            _ => {}
        }
    }

    heartbeat.abort();
    writer.abort();

    // Mark disconnected cleanly.
    let mut guard = shared.inner.lock();
    if let Some(room) = guard.parties.get_mut(&code) {
        let ts = now_ms();
        for entry in &mut room.members {
            if entry.member.member_id == member_id {
                entry.member.connected = false;
                entry.member.last_seen_ms = ts;
                entry.sender = None;
                break;
            }
        }
        room.broadcast_members();
    }
}

fn handle_ws_message(
    shared: &Arc<SharedState>,
    code: &str,
    member_id: &str,
    tx: &mpsc::UnboundedSender<String>,
    val: Value,
) {
    let msg_type = val.get("type").and_then(Value::as_str).unwrap_or("");
    let ts = now_ms();

    match msg_type {
        "ping" => {
            let client_ms = val.get("clientMs").and_then(Value::as_i64).unwrap_or(0);
            let _ = tx.send(
                json!({
                    "type": "pong",
                    "clientMs": client_ms,
                    "serverMs": ts,
                })
                .to_string(),
            );
        }
        "sync" => {
            let guard = shared.inner.lock();
            if let Some(room) = guard.parties.get(code) {
                let _ = tx.send(
                    json!({
                        "type": "state",
                        "playback": room.playback.snapshot_at(ts),
                        "serverMs": ts,
                    })
                    .to_string(),
                );
            }
        }
        "syncQueue" => {
            let guard = shared.inner.lock();
            if let Some(room) = guard.parties.get(code) {
                let _ = tx.send(
                    json!({
                        "type": "queue",
                        "queue": room.queue,
                        "serverMs": ts,
                    })
                    .to_string(),
                );
            }
        }
        "control" => {
            apply_control_action(shared, code, member_id, tx, val, ts);
        }
        _ => {}
    }
}

fn apply_control_action(
    shared: &Arc<SharedState>,
    code: &str,
    member_id: &str,
    tx: &mpsc::UnboundedSender<String>,
    val: Value,
    ts: i64,
) {
    let action = val.get("action").and_then(Value::as_str).unwrap_or("");
    let mut guard = shared.inner.lock();
    let Some(room) = guard.parties.get_mut(code) else {
        return;
    };

    let Some((is_host, display_name)) = room
        .members
        .iter()
        .find(|m| m.member.member_id == member_id)
        .map(|m| (m.member.is_host, m.member.display_name.clone()))
    else {
        return;
    };

    let host_only_action = matches!(action, "setMaxMembers" | "kick" | "setHostOnlyControl");
    if (host_only_action || room.host_only_control) && !is_host {
        let _ = tx.send(
            json!({
                "type": "error",
                "error": "host_only",
                "message": "Only the host can control this party.",
            })
            .to_string(),
        );
        return;
    }

    let mut state_changed = false;
    let mut queue_changed = false;
    let mut members_changed = false;
    let mut activity_detail = String::new();

    match action {
        "play" => {
            let pos = val
                .get("positionMs")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| room.playback.effective_at(ts))
                .max(0);
            room.playback.is_playing = true;
            room.playback.position_ms = pos;
            room.playback.anchor_ms = ts + PLAY_LEAD_MS;
            state_changed = true;
        }
        "pause" => {
            let pos = val
                .get("positionMs")
                .and_then(Value::as_i64)
                .unwrap_or_else(|| room.playback.effective_at(ts))
                .max(0);
            room.playback.is_playing = false;
            room.playback.position_ms = pos;
            room.playback.anchor_ms = ts;
            state_changed = true;
        }
        "seek" => {
            let pos = val.get("positionMs").and_then(Value::as_i64).unwrap_or(0).max(0);
            room.playback.position_ms = pos;
            room.playback.anchor_ms = if room.playback.is_playing {
                ts + PLAY_LEAD_MS
            } else {
                ts
            };
            state_changed = true;
        }
        "setTrack" => {
            if let Some(track_val) = val.get("track") {
                if let Ok(track) = serde_json::from_value::<PartyTrack>(track_val.clone()) {
                    let pos = val.get("positionMs").and_then(Value::as_i64).unwrap_or(0).max(0);
                    let is_playing = val.get("isPlaying").and_then(Value::as_bool).unwrap_or(true);
                    activity_detail = track.title.clone();
                    room.playback.track = Some(track.clone());
                    room.playback.is_playing = is_playing;
                    room.playback.position_ms = pos;
                    room.playback.anchor_ms = if is_playing { ts + PLAY_LEAD_MS } else { ts };
                    room.playback.started_by = Some(member_id.to_string());
                    room.playback.started_by_name = Some(display_name.clone());
                    if let Some(idx) = room
                        .queue
                        .items
                        .iter()
                        .position(|t| t.video_id == track.video_id)
                    {
                        room.queue.index = idx as i32;
                    } else {
                        room.queue.items.insert(0, track);
                        room.queue.items.truncate(MAX_QUEUE_LEN);
                        room.queue.index = 0;
                        queue_changed = true;
                    }
                    state_changed = true;
                }
            }
        }
        "next" => {
            let next_idx = room.queue.index + 1;
            if next_idx >= 0 && (next_idx as usize) < room.queue.items.len() {
                let track = room.queue.items[next_idx as usize].clone();
                activity_detail = track.title.clone();
                room.queue.index = next_idx;
                room.playback.track = Some(track);
                room.playback.is_playing = true;
                room.playback.position_ms = 0;
                room.playback.anchor_ms = ts + PLAY_LEAD_MS;
                room.playback.started_by = Some(member_id.to_string());
                room.playback.started_by_name = Some(display_name.clone());
                queue_changed = true;
                state_changed = true;
            }
        }
        "previous" => {
            let prev_idx = (room.queue.index - 1).max(0);
            if (prev_idx as usize) < room.queue.items.len() {
                let track = room.queue.items[prev_idx as usize].clone();
                activity_detail = track.title.clone();
                room.queue.index = prev_idx;
                room.playback.track = Some(track);
                room.playback.is_playing = true;
                room.playback.position_ms = 0;
                room.playback.anchor_ms = ts + PLAY_LEAD_MS;
                room.playback.started_by = Some(member_id.to_string());
                room.playback.started_by_name = Some(display_name.clone());
                queue_changed = true;
                state_changed = true;
            }
        }
        "setQueue" => {
            if let Some(items_val) = val.get("queue") {
                if let Ok(mut items) = serde_json::from_value::<Vec<PartyTrack>>(items_val.clone()) {
                    items.truncate(MAX_QUEUE_LEN);
                    let idx = val
                        .get("queueIndex")
                        .and_then(Value::as_i64)
                        .unwrap_or(0)
                        .clamp(-1, items.len() as i64 - 1) as i32;
                    room.queue.items = items;
                    room.queue.index = idx;
                    if idx >= 0 {
                        if let Some(t) = room.queue.items.get(idx as usize) {
                            room.playback.track = Some(t.clone());
                        }
                    }
                    queue_changed = true;
                    state_changed = true;
                }
            }
        }
        "queueAdd" => {
            if let Some(tracks_val) = val.get("tracks") {
                if let Ok(tracks) = serde_json::from_value::<Vec<PartyTrack>>(tracks_val.clone()) {
                    let play_next = val
                        .get("playNext")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    if play_next && room.queue.index >= 0 {
                        let insert_at = ((room.queue.index as usize) + 1).min(room.queue.items.len());
                        for (offset, t) in tracks.into_iter().enumerate() {
                            room.queue.items.insert(insert_at + offset, t);
                        }
                    } else {
                        room.queue.items.extend(tracks);
                    }
                    room.queue.items.truncate(MAX_QUEUE_LEN);
                    queue_changed = true;
                    state_changed = true;
                }
            }
        }
        "queueRemove" => {
            if let Some(vid) = val.get("videoId").and_then(Value::as_str) {
                if let Some(pos) = room.queue.items.iter().position(|t| t.video_id == vid) {
                    room.queue.items.remove(pos);
                    if (pos as i32) < room.queue.index {
                        room.queue.index -= 1;
                    } else if room.queue.index as usize >= room.queue.items.len() {
                        room.queue.index = room.queue.items.len() as i32 - 1;
                    }
                    queue_changed = true;
                    state_changed = true;
                }
            }
        }
        "queueClear" => {
            if room.queue.index >= 0 && (room.queue.index as usize) < room.queue.items.len() {
                let keep = room.queue.items[room.queue.index as usize].clone();
                room.queue.items = vec![keep];
                room.queue.index = 0;
            } else {
                room.queue.items.clear();
                room.queue.index = -1;
            }
            queue_changed = true;
            state_changed = true;
        }
        "queueMove" => {
            let from = val.get("fromIndex").and_then(Value::as_u64).map(|v| v as usize);
            let to = val.get("toIndex").and_then(Value::as_u64).map(|v| v as usize);
            if let (Some(f), Some(t)) = (from, to) {
                if f < room.queue.items.len() && t < room.queue.items.len() && f != t {
                    let item = room.queue.items.remove(f);
                    room.queue.items.insert(t, item);
                    if let Some(cur_id) = room.playback.track.as_ref().map(|x| x.video_id.clone()) {
                        if let Some(new_idx) =
                            room.queue.items.iter().position(|x| x.video_id == cur_id)
                        {
                            room.queue.index = new_idx as i32;
                        }
                    }
                    queue_changed = true;
                    state_changed = true;
                }
            }
        }
        "setAutoplay" => {
            if let Some(enabled) = val.get("enabled").and_then(Value::as_bool) {
                room.playback.autoplay_enabled = enabled;
                state_changed = true;
            }
        }
        "setMaxMembers" => {
            if let Some(max_m) = val.get("maxMembers").and_then(Value::as_u64) {
                room.max_members = (max_m as usize).clamp(2, 20);
                members_changed = true;
            }
        }
        "setHostOnlyControl" => {
            if let Some(enabled) = val.get("enabled").and_then(Value::as_bool) {
                room.host_only_control = enabled;
                members_changed = true;
            }
        }
        "kick" => {
            if let Some(target_id) = val.get("memberId").and_then(Value::as_str) {
                if target_id != member_id {
                    if let Some(pos) = room
                        .members
                        .iter()
                        .position(|m| m.member.member_id == target_id)
                    {
                        let removed = room.members.remove(pos);
                        if let Some(target_tx) = removed.sender {
                            let _ = target_tx.send(
                                json!({
                                    "type": "bye",
                                    "reason": "kicked",
                                })
                                .to_string(),
                            );
                        }
                        members_changed = true;
                    }
                }
            }
        }
        _ => {}
    }

    if queue_changed {
        room.queue.seq += 1;
        room.playback.queue_seq = room.queue.seq;
        room.playback.queue_length = room.queue.items.len();
        room.playback.queue_index = room.queue.index;
        room.broadcast(&json!({
            "type": "queue",
            "queue": room.queue,
            "serverMs": ts,
        }));
    }

    if state_changed {
        room.playback.seq += 1;
        room.playback.queue_seq = room.queue.seq;
        room.playback.queue_length = room.queue.items.len();
        room.playback.queue_index = room.queue.index;
        room.playback.updated_by = Some(member_id.to_string());
        room.playback.updated_at_ms = ts;
        room.broadcast(&json!({
            "type": "state",
            "playback": room.playback.snapshot_at(ts),
            "serverMs": ts,
        }));
        room.broadcast(&json!({
            "type": "activity",
            "action": action,
            "by": display_name,
            "atMs": ts,
            "detail": activity_detail,
        }));
    }

    if members_changed {
        room.broadcast_members();
    }
}

fn with_cors(mut resp: Response) -> Response {
    let headers = resp.headers_mut();
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization, X-Sync-Pin, X-Device-Id, X-Device-Name"),
    );
    resp
}

fn json_err(status: StatusCode, code: &str, message: &str) -> Response {
    with_cors((status, Json(json!({ "error": code, "message": message }))).into_response())
}

fn parse_bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let mut parts = raw.splitn(2, ' ');
    let scheme = parts.next()?;
    let tok = parts.next()?;
    if scheme.eq_ignore_ascii_case("bearer") && !tok.trim().is_empty() {
        Some(tok.trim().to_string())
    } else {
        None
    }
}

fn build_http_router(shared: Arc<SharedState>) -> Router {
    Router::new()
        .route("/healthz", get(http_healthz))
        .route("/api/time", get(http_time))
        .route("/api/parties", post(http_create_party).options(http_options))
        .route(
            "/api/parties/{code}/join",
            post(http_join_party).options(http_options),
        )
        .route(
            "/api/parties/{code}/preview",
            get(http_party_preview).options(http_options),
        )
        .route(
            "/api/parties/{code}/leave",
            post(http_leave_party).options(http_options),
        )
        .route(
            "/api/parties/{code}",
            get(http_get_party).options(http_options),
        )
        .route("/sync", get(http_sync_portal))
        .route(
            "/api/sync/backup",
            get(http_sync_download_backup)
                .post(http_sync_upload_backup)
                .options(http_options),
        )
        .route(
            "/api/sync/now-playing",
            get(http_sync_now_playing).options(http_options),
        )
        .route("/{*path}", options(http_options))
        .layer(DefaultBodyLimit::max(MAX_BACKUP_BYTES))
        .with_state(shared)
}

async fn http_options() -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response())
}

async fn http_healthz() -> Response {
    // Exact compact JSON {"ok":true} required by unmodified BitChord Android ListenTogether.kt.
    with_cors(
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            r#"{"ok":true}"#,
        )
            .into_response(),
    )
}

async fn http_time() -> Response {
    with_cors(Json(json!({ "serverMs": now_ms() })).into_response())
}

async fn http_create_party(
    State(shared): State<Arc<SharedState>>,
    Json(req): Json<JoinRequest>,
) -> Response {
    if req.user_id.trim().is_empty() || req.device_id.trim().is_empty() {
        return json_err(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_identity",
            "userId and deviceId are required.",
        );
    }
    let ts = now_ms();
    let max_members = req.max_members.unwrap_or(5).clamp(2, 20);
    let autoplay = req.autoplay_enabled.unwrap_or(false);
    let mut guard = shared.inner.lock();

    let mut code = generate_code();
    while guard.parties.contains_key(&code) {
        code = generate_code();
    }

    let member = PartyMember {
        member_id: Uuid::new_v4().to_string(),
        user_id: req.user_id.trim().to_string(),
        display_name: if req.display_name.trim().is_empty() {
            "Host".to_string()
        } else {
            req.display_name.trim().to_string()
        },
        avatar_url: req.avatar_url,
        is_host: true,
        connected: false,
        joined_at_ms: ts,
        last_seen_ms: ts,
    };
    let token = generate_token();
    let room = PartyRoom {
        code: code.clone(),
        created_at_ms: ts,
        max_members,
        host_only_control: false,
        members: vec![MemberEntry {
            member: member.clone(),
            device_id: req.device_id.trim().to_string(),
            token: token.clone(),
            sender: None,
        }],
        playback: PartyPlayback::empty(autoplay),
        queue: PartyQueue::empty(),
    };
    let snap = room.snapshot(ts);
    guard.parties.insert(code.clone(), room);

    with_cors(
        (
            StatusCode::CREATED,
            Json(PartyMembership {
                code,
                token,
                you: member,
                party: snap,
                server_ms: ts,
            }),
        )
            .into_response(),
    )
}

async fn http_join_party(
    State(shared): State<Arc<SharedState>>,
    AxumPath(raw_code): AxumPath<String>,
    Json(req): Json<JoinRequest>,
) -> Response {
    let code = raw_code.trim().to_ascii_uppercase();
    let ts = now_ms();
    let mut guard = shared.inner.lock();
    let Some(room) = guard.parties.get_mut(&code) else {
        return json_err(StatusCode::NOT_FOUND, "no_such_party", "That party does not exist.");
    };

    if let Some(existing) = room
        .members
        .iter_mut()
        .find(|m| m.member.user_id == req.user_id.trim() && m.device_id == req.device_id.trim())
    {
        if !req.display_name.trim().is_empty() {
            existing.member.display_name = req.display_name.trim().to_string();
        }
        existing.member.last_seen_ms = ts;
        let you = existing.member.clone();
        let token = existing.token.clone();
        let snap = room.snapshot(ts);
        return with_cors(
            Json(PartyMembership {
                code,
                token,
                you,
                party: snap,
                server_ms: ts,
            })
            .into_response(),
        );
    }

    if room.members.len() >= room.max_members {
        return json_err(StatusCode::CONFLICT, "party_full", "This party is full.");
    }

    let member = PartyMember {
        member_id: Uuid::new_v4().to_string(),
        user_id: req.user_id.trim().to_string(),
        display_name: if req.display_name.trim().is_empty() {
            "Listener".to_string()
        } else {
            req.display_name.trim().to_string()
        },
        avatar_url: req.avatar_url,
        is_host: room.members.is_empty(),
        connected: false,
        joined_at_ms: ts,
        last_seen_ms: ts,
    };
    let token = generate_token();
    room.members.push(MemberEntry {
        member: member.clone(),
        device_id: req.device_id.trim().to_string(),
        token: token.clone(),
        sender: None,
    });
    let snap = room.snapshot(ts);
    room.broadcast_members();

    with_cors(
        Json(PartyMembership {
            code,
            token,
            you: member,
            party: snap,
            server_ms: ts,
        })
        .into_response(),
    )
}

async fn http_party_preview(
    State(shared): State<Arc<SharedState>>,
    AxumPath(raw_code): AxumPath<String>,
) -> Response {
    let code = raw_code.trim().to_ascii_uppercase();
    let guard = shared.inner.lock();
    let Some(room) = guard.parties.get(&code) else {
        return json_err(StatusCode::NOT_FOUND, "no_such_party", "That party does not exist.");
    };
    let host_name = room
        .members
        .iter()
        .find(|m| m.member.is_host)
        .or_else(|| room.members.first())
        .map(|m| m.member.display_name.clone())
        .unwrap_or_else(|| "Host".to_string());
    let members: Vec<Value> = room
        .members
        .iter()
        .map(|m| {
            json!({
                "displayName": m.member.display_name,
                "avatarUrl": m.member.avatar_url,
                "isHost": m.member.is_host,
            })
        })
        .collect();
    with_cors(
        Json(json!({
            "code": room.code,
            "hostName": host_name,
            "memberCount": room.members.len(),
            "maxMembers": room.max_members,
            "isFull": room.members.len() >= room.max_members,
            "members": members,
        }))
        .into_response(),
    )
}

async fn http_get_party(
    State(shared): State<Arc<SharedState>>,
    AxumPath(raw_code): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let code = raw_code.trim().to_ascii_uppercase();
    let Some(token) = parse_bearer(&headers) else {
        return json_err(StatusCode::UNAUTHORIZED, "bad_token", "Missing bearer token.");
    };
    let guard = shared.inner.lock();
    let Some(room) = guard.parties.get(&code) else {
        return json_err(StatusCode::NOT_FOUND, "no_such_party", "That party does not exist.");
    };
    if !room.members.iter().any(|m| m.token == token) {
        return json_err(StatusCode::UNAUTHORIZED, "bad_token", "Invalid party token.");
    }
    with_cors(Json(room.snapshot(now_ms())).into_response())
}

async fn http_leave_party(
    State(shared): State<Arc<SharedState>>,
    AxumPath(raw_code): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let code = raw_code.trim().to_ascii_uppercase();
    let Some(token) = parse_bearer(&headers) else {
        return json_err(StatusCode::UNAUTHORIZED, "bad_token", "Missing bearer token.");
    };
    let mut guard = shared.inner.lock();
    let Some(room) = guard.parties.get_mut(&code) else {
        return with_cors(Json(json!({ "ok": true })).into_response());
    };
    if let Some(pos) = room.members.iter().position(|m| m.token == token) {
        room.members.remove(pos);
        if room.members.is_empty() {
            guard.parties.remove(&code);
        } else {
            room.ensure_host();
            room.broadcast_members();
        }
    }
    with_cors(Json(json!({ "ok": true })).into_response())
}

#[derive(Debug, Deserialize)]
struct SyncQuery {
    pin: Option<String>,
    device_id: Option<String>,
    device_name: Option<String>,
}

async fn http_sync_now_playing(
    State(shared): State<Arc<SharedState>>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
) -> Response {
    if !shared.verify_pin(&headers, query.pin.as_deref()) {
        return json_err(StatusCode::UNAUTHORIZED, "invalid_pin", "Invalid 6-digit sync PIN.");
    }
    let now_playing = shared.inner.lock().now_playing.clone();
    let peers = shared.stats.list_synced_peers();
    with_cors(
        Json(json!({
            "nowPlaying": now_playing,
            "peers": peers,
            "serverMs": now_ms(),
        }))
        .into_response(),
    )
}

async fn http_sync_upload_backup(
    State(shared): State<Arc<SharedState>>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
    body: Bytes,
) -> Response {
    if !shared.verify_pin(&headers, query.pin.as_deref()) {
        return json_err(StatusCode::UNAUTHORIZED, "invalid_pin", "Invalid 6-digit sync PIN.");
    }
    let raw = match std::str::from_utf8(&body) {
        Ok(s) => s,
        Err(_) => {
            return json_err(
                StatusCode::BAD_REQUEST,
                "invalid_encoding",
                "Backup payload must be valid UTF-8 JSON.",
            );
        }
    };

    let device_name = headers
        .get("x-device-name")
        .and_then(|v| v.to_str().ok())
        .or(query.device_name.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let device_id = headers
        .get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .or(query.device_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match shared
        .stats
        .merge_peer_backup_json(device_id, device_name, raw)
    {
        Ok(res) => {
            (shared.on_peer_sync)(res.clone());
            with_cors(Json(res).into_response())
        }
        Err(err) => json_err(StatusCode::BAD_REQUEST, "invalid_backup", &err.to_string()),
    }
}

async fn http_sync_download_backup(
    State(shared): State<Arc<SharedState>>,
    headers: HeaderMap,
    Query(query): Query<SyncQuery>,
) -> Response {
    if !shared.verify_pin(&headers, query.pin.as_deref()) {
        return json_err(StatusCode::UNAUTHORIZED, "invalid_pin", "Invalid 6-digit sync PIN.");
    }
    match shared.stats.export_combined_backup_json() {
        Ok(json_str) => with_cors(
            (
                StatusCode::OK,
                [
                    (header::CONTENT_TYPE, "application/json; charset=utf-8"),
                    (
                        header::CONTENT_DISPOSITION,
                        "attachment; filename=\"bitchord-pc-sync.json\"",
                    ),
                ],
                json_str,
            )
                .into_response(),
        ),
        Err(err) => json_err(
            StatusCode::INTERNAL_SERVER_ERROR,
            "export_failed",
            &err.to_string(),
        ),
    }
}

async fn http_sync_portal() -> Response {
    with_cors(Html(SYNC_PORTAL_HTML).into_response())
}

const SYNC_PORTAL_HTML: &str = r##"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BitChord Mobile Sync</title>
  <style>
    :root {
      color-scheme: dark light;
      --bg: #0b0b0c;
      --card: #161618;
      --muted: #242428;
      --border: rgba(255,255,255,0.12);
      --text: #f5f5f7;
      --sub: #a1a1aa;
      --accent: #fa243c;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f6f7;
        --card: #ffffff;
        --muted: #ececef;
        --border: rgba(0,0,0,0.1);
        --text: #111113;
        --sub: #585860;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px 16px 40px;
      line-height: 1.45;
    }
    .wrap { max-width: 520px; margin: 0 auto; display: grid; gap: 16px; }
    h1 { margin: 0; font-size: 22px; letter-spacing: -0.02em; }
    h2 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 0; color: var(--sub); font-size: 13px; }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 16px;
      display: grid;
      gap: 12px;
    }
    label { display: grid; gap: 6px; font-size: 13px; font-weight: 600; }
    input[type="text"], input[type="file"] {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid var(--border);
      background: var(--muted);
      color: var(--text);
      font-size: 15px;
    }
    button {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
    }
    .primary { background: var(--accent); color: #fff; }
    .secondary { background: var(--muted); color: var(--text); }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .status {
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--muted);
      font-size: 13px;
      white-space: pre-wrap;
    }
    .np { font-size: 14px; font-weight: 600; color: var(--text); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--muted);
      padding: 2px 6px;
      border-radius: 6px;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <main class="wrap">
    <header>
      <h1>BitChord Mobile Sync</h1>
      <p>Sync listening stats and backups directly with BitChord Desktop over local Wi-Fi.</p>
    </header>

    <section class="card">
      <h2>1. Pair with Desktop PIN</h2>
      <label>
        6-Digit Pairing PIN (shown in Desktop Listen Together)
        <input id="pin" type="text" inputmode="numeric" maxlength="6" placeholder="123456" autocomplete="off" />
      </label>
      <label>
        Device Name
        <input id="deviceName" type="text" placeholder="My Android Phone" />
      </label>
      <div class="row">
        <button class="secondary" type="button" id="checkBtn">Verify PIN &amp; Check Desktop</button>
      </div>
      <div id="nowPlaying" class="status">Enter the 6-digit PIN shown on BitChord Desktop.</div>
    </section>

    <section class="card">
      <h2>2. Send Phone Backup to PC (Non-Destructive Merge)</h2>
      <p>In BitChord Android: Settings &gt; Backup &amp; Restore &gt; Export Backup, then upload the JSON file here. Desktop merges it cleanly without erasing PC history.</p>
      <input id="backupFile" type="file" accept="application/json,.json" />
      <button class="primary" type="button" id="uploadBtn">Upload &amp; Merge Into Desktop</button>
      <div id="uploadStatus" class="status" hidden></div>
    </section>

    <section class="card">
      <h2>3. Download Combined Backup to Phone</h2>
      <p>Download combined PC + Phone stats as a BitChord backup JSON, then import it in BitChord Android.</p>
      <button class="secondary" type="button" id="downloadBtn">Download bitchord-pc-sync.json</button>
    </section>
  </main>

  <script>
    const pinEl = document.getElementById('pin');
    const nameEl = document.getElementById('deviceName');
    const npEl = document.getElementById('nowPlaying');
    const uploadStatus = document.getElementById('uploadStatus');
    const fileEl = document.getElementById('backupFile');

    const savedName = localStorage.getItem('bitchord:sync:deviceName');
    if (savedName) nameEl.value = savedName;
    nameEl.addEventListener('change', () => localStorage.setItem('bitchord:sync:deviceName', nameEl.value.trim()));

    let deviceId = localStorage.getItem('bitchord:sync:deviceId');
    if (!deviceId) {
      deviceId = 'phone-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('bitchord:sync:deviceId', deviceId);
    }

    async function checkDesktop() {
      const pin = pinEl.value.trim();
      if (!pin) { npEl.textContent = 'Enter the 6-digit PIN first.'; return; }
      npEl.textContent = 'Checking Desktop...';
      try {
        const r = await fetch('/api/sync/now-playing?pin=' + encodeURIComponent(pin));
        const data = await r.json();
        if (!r.ok) { npEl.textContent = data.message || 'Invalid PIN.'; return; }
        if (data.nowPlaying) {
          npEl.innerHTML = '<div class="np">Now Playing: ' + escapeHtml(data.nowPlaying.title) + '</div><div>' + escapeHtml(data.nowPlaying.artist) + ' (' + escapeHtml(data.nowPlaying.status) + ')</div>';
        } else {
          npEl.textContent = 'Connected to BitChord Desktop. Nothing currently playing.';
        }
      } catch (e) {
        npEl.textContent = 'Could not reach BitChord Desktop: ' + String(e);
      }
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    document.getElementById('checkBtn').addEventListener('click', checkDesktop);

    document.getElementById('uploadBtn').addEventListener('click', async () => {
      const pin = pinEl.value.trim();
      const file = fileEl.files && fileEl.files[0];
      uploadStatus.hidden = false;
      if (!pin) { uploadStatus.textContent = 'Enter the 6-digit PIN first.'; return; }
      if (!file) { uploadStatus.textContent = 'Choose a bitchord-backup JSON file first.'; return; }
      uploadStatus.textContent = 'Uploading and merging...';
      try {
        const text = await file.text();
        const r = await fetch('/api/sync/backup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sync-Pin': pin,
            'X-Device-Id': deviceId,
            'X-Device-Name': nameEl.value.trim() || 'Android Phone'
          },
          body: text
        });
        const data = await r.json();
        if (!r.ok) { uploadStatus.textContent = data.message || 'Merge failed.'; return; }
        uploadStatus.textContent = 'Merged ' + data.months + ' month(s) and ' + data.tracks + ' track(s) from ' + data.deviceName + '.';
      } catch (e) {
        uploadStatus.textContent = 'Upload failed: ' + String(e);
      }
    });

    document.getElementById('downloadBtn').addEventListener('click', async () => {
      const pin = pinEl.value.trim();
      if (!pin) { npEl.textContent = 'Enter the 6-digit PIN first.'; return; }
      window.location.href = '/api/sync/backup?pin=' + encodeURIComponent(pin);
    });
  </script>
</body>
</html>
"##;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    fn temp_stats(name: &str) -> Arc<ListeningStatsStore> {
        let dir = std::env::temp_dir().join(format!(
            "bitchord-mobile-sync-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        Arc::new(ListeningStatsStore::open_at(dir).expect("open stats"))
    }

    #[tokio::test]
    async fn healthz_party_http_ws_and_pin_backup_sync_roundtrip() {
        let stats = temp_stats("roundtrip");
        let synced_count = Arc::new(Mutex::new(0usize));
        let synced_cb = Arc::clone(&synced_count);
        let svc = MobileSyncService::new(
            Arc::clone(&stats),
            Arc::new(move |_| {
                *synced_cb.lock() += 1;
            }),
        );

        let status = svc.start(None).await.expect("start server");
        assert!(status.running);
        let port = status.port.expect("port");
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();

        // 1. /healthz returns exact compact {"ok":true} for Android compatibility.
        let health_body = client
            .get(format!("{base}/healthz"))
            .send()
            .await
            .expect("healthz")
            .text()
            .await
            .expect("healthz text");
        assert_eq!(health_body, r#"{"ok":true}"#);

        // 2. /api/time returns serverMs.
        let time_json: Value = client
            .get(format!("{base}/api/time"))
            .send()
            .await
            .expect("time")
            .json()
            .await
            .expect("time json");
        assert!(time_json.get("serverMs").and_then(Value::as_i64).unwrap_or(0) > 0);

        // 3. Create party + Join party + dual WebSocket auth (Bearer for Android, subprotocol for Desktop).
        let host: Value = client
            .post(format!("{base}/api/parties"))
            .json(&json!({
                "userId": "u-host",
                "deviceId": "pc-1",
                "displayName": "Desktop Host",
                "maxMembers": 4,
                "autoplayEnabled": true
            }))
            .send()
            .await
            .expect("create party")
            .json()
            .await
            .expect("host json");
        let code = host["code"].as_str().expect("code").to_string();
        let host_token = host["token"].as_str().expect("host token").to_string();

        let guest: Value = client
            .post(format!("{base}/api/parties/{code}/join"))
            .json(&json!({
                "userId": "u-phone",
                "deviceId": "android-1",
                "displayName": "Android Guest"
            }))
            .send()
            .await
            .expect("join party")
            .json()
            .await
            .expect("guest json");
        let guest_token = guest["token"].as_str().expect("guest token").to_string();

        // Host connects via Browser subprotocol (bitchord.v1, bitchord.token.<tok>).
        let mut host_req = format!("ws://127.0.0.1:{port}/ws/parties/{code}")
            .into_client_request()
            .expect("host ws req");
        host_req.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&format!("bitchord.v1, bitchord.token.{host_token}")).unwrap(),
        );
        let (mut host_ws, host_resp) = tokio_tungstenite::connect_async(host_req)
            .await
            .expect("connect host ws");
        assert_eq!(
            host_resp
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok()),
            Some("bitchord.v1")
        );

        // Guest connects via Android Bearer Authorization header.
        let mut guest_req = format!("ws://127.0.0.1:{port}/ws/parties/{code}")
            .into_client_request()
            .expect("guest ws req");
        guest_req.headers_mut().insert(
            "Authorization",
            HeaderValue::from_str(&format!("Bearer {guest_token}")).unwrap(),
        );
        let (mut guest_ws, _) = tokio_tungstenite::connect_async(guest_req)
            .await
            .expect("connect guest ws");

        // Drain initial welcome frame on guest.
        let welcome_msg = tokio::time::timeout(Duration::from_secs(2), guest_ws.next())
            .await
            .expect("welcome timeout")
            .expect("welcome item")
            .expect("welcome ok");
        let welcome_json: Value = serde_json::from_str(welcome_msg.to_text().unwrap()).unwrap();
        assert_eq!(welcome_json["type"], "welcome");

        // Host sends setTrack control -> Guest receives state with the track.
        host_ws
            .send(WsMessage::Text(
                json!({
                    "type": "control",
                    "action": "setTrack",
                    "track": {
                        "videoId": "abc12345678",
                        "title": "Sync Song",
                        "artist": "Sync Artist",
                        "durationMs": 200000,
                        "fromAutoplay": false
                    },
                    "positionMs": 12000,
                    "isPlaying": true
                })
                .to_string()
                .into(),
            ))
            .await
            .expect("send setTrack");

        let mut saw_state = false;
        for _ in 0..8 {
            if let Ok(Some(Ok(WsMessage::Text(txt)))) =
                tokio::time::timeout(Duration::from_secs(2), guest_ws.next()).await
            {
                let v: Value = serde_json::from_str(&txt).unwrap();
                if v["type"] == "state" && v["playback"]["track"]["videoId"] == "abc12345678" {
                    saw_state = true;
                    break;
                }
            }
        }
        assert!(saw_state, "guest did not receive synced track state");

        // 4. Mobile /sync HTML portal and PIN-gated backup merge.
        let portal = client
            .get(format!("{base}/sync"))
            .send()
            .await
            .expect("portal")
            .text()
            .await
            .expect("portal html");
        assert!(portal.contains("BitChord Mobile Sync"));

        let backup_payload = r#"{
            "app": "bitchord",
            "version": 1,
            "versionName": "0.8.0-android",
            "exportedAt": "2026-11-24T00:00:00Z",
            "settings": {},
            "listening": [
                {
                    "v": 1,
                    "month": "2026-11",
                    "tracks": [
                        {
                            "id": "mob99",
                            "title": "Phone Song",
                            "artist": "Phone Band",
                            "ms": 180000,
                            "plays": 2,
                            "days": { "2026-11-24": { "ms": 180000, "plays": 2 } }
                        }
                    ],
                    "artists": [
                        {
                            "name": "Phone Band",
                            "ms": 180000,
                            "plays": 2,
                            "days": { "2026-11-24": { "ms": 180000, "plays": 2 } }
                        }
                    ],
                    "albums": [],
                    "hours": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,180000,0,0,0,0,0],
                    "days": { "24": 180000 }
                }
            ]
        }"#;

        // Wrong PIN rejected with 401.
        let bad_resp = client
            .post(format!("{base}/api/sync/backup"))
            .header("X-Sync-Pin", "000000-wrong")
            .body(backup_payload)
            .send()
            .await
            .expect("bad pin post");
        assert_eq!(bad_resp.status(), StatusCode::UNAUTHORIZED);

        // Correct PIN merges cleanly and triggers callback.
        let ok_resp = client
            .post(format!("{base}/api/sync/backup"))
            .header("X-Sync-Pin", &status.sync_pin)
            .header("X-Device-Id", "android-phone-1")
            .header("X-Device-Name", "Galaxy S24")
            .body(backup_payload)
            .send()
            .await
            .expect("valid pin post");
        assert_eq!(ok_resp.status(), StatusCode::OK);
        let merged: PeerSyncResult = ok_resp.json().await.expect("merge json");
        assert_eq!(merged.device_name, "Galaxy S24");
        assert_eq!(*synced_count.lock(), 1);

        // Downloading combined backup with valid PIN returns the merged track.
        let dl_text = client
            .get(format!("{base}/api/sync/backup?pin={}", status.sync_pin))
            .send()
            .await
            .expect("download backup")
            .text()
            .await
            .expect("download text");
        assert!(dl_text.contains("Phone Song"));

        svc.stop();
    }
}
