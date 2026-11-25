use crate::cast::types::{CastDevice, CastSessionState};
use anyhow::{anyhow, Result};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use serde_json::{json, Value};
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_rustls::TlsConnector;

const DEFAULT_MEDIA_RECEIVER_APP_ID: &str = "CC1AD845";
const NS_CONNECTION: &str = "urn:x-cast:com.google.cast.tp.connection";
const NS_HEARTBEAT: &str = "urn:x-cast:com.google.cast.tp.heartbeat";
const NS_RECEIVER: &str = "urn:x-cast:com.google.cast.receiver";
const NS_MEDIA: &str = "urn:x-cast:com.google.cast.media";

#[derive(Debug)]
struct CastCertVerifier {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for CastCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, RustlsError> {
        // Chromecast receivers present hardware-issued certs for raw LAN IPs outside public WebPKI roots.
        if end_entity.is_empty() {
            return Err(RustlsError::General("Empty receiver certificate".into()));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CastMessage {
    pub source_id: String,
    pub destination_id: String,
    pub namespace: String,
    pub payload_utf8: String,
}

fn push_varint(buf: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7F) as u8;
        v >>= 7;
        if v == 0 {
            buf.push(b);
            break;
        } else {
            buf.push(b | 0x80);
        }
    }
}

fn push_str_field(buf: &mut Vec<u8>, field_num: u64, val: &str) {
    push_varint(buf, (field_num << 3) | 2);
    push_varint(buf, val.len() as u64);
    buf.extend_from_slice(val.as_bytes());
}

fn read_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut out = 0u64;
    let mut shift = 0u32;
    while *pos < data.len() && shift < 64 {
        let b = data[*pos];
        *pos += 1;
        out |= ((b & 0x7F) as u64) << shift;
        if (b & 0x80) == 0 {
            return Some(out);
        }
        shift += 7;
    }
    None
}

pub fn encode_cast_message(msg: &CastMessage) -> Vec<u8> {
    let mut body = Vec::with_capacity(64 + msg.payload_utf8.len());
    // field 1: protocol_version = CASTV2_1_0 (0)
    push_varint(&mut body, 1 << 3);
    push_varint(&mut body, 0);
    push_str_field(&mut body, 2, &msg.source_id);
    push_str_field(&mut body, 3, &msg.destination_id);
    push_str_field(&mut body, 4, &msg.namespace);
    // field 5: payload_type = STRING (0)
    push_varint(&mut body, 5 << 3);
    push_varint(&mut body, 0);
    push_str_field(&mut body, 6, &msg.payload_utf8);

    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    frame
}

pub fn decode_cast_message_body(body: &[u8]) -> Result<CastMessage> {
    let mut pos = 0usize;
    let mut source_id = String::new();
    let mut destination_id = String::new();
    let mut namespace = String::new();
    let mut payload_utf8 = String::new();

    while pos < body.len() {
        let tag = read_varint(body, &mut pos).ok_or_else(|| anyhow!("Truncated protobuf tag"))?;
        let field = tag >> 3;
        let wire = tag & 0x07;
        match wire {
            0 => {
                let _ = read_varint(body, &mut pos).ok_or_else(|| anyhow!("Truncated varint"))?;
            }
            2 => {
                let len = read_varint(body, &mut pos).ok_or_else(|| anyhow!("Truncated length"))?
                    as usize;
                if pos + len > body.len() {
                    return Err(anyhow!("Protobuf field overflows frame"));
                }
                let slice = &body[pos..pos + len];
                pos += len;
                match field {
                    2 => source_id = String::from_utf8_lossy(slice).into_owned(),
                    3 => destination_id = String::from_utf8_lossy(slice).into_owned(),
                    4 => namespace = String::from_utf8_lossy(slice).into_owned(),
                    6 => payload_utf8 = String::from_utf8_lossy(slice).into_owned(),
                    _ => {}
                }
            }
            5 => {
                if pos + 4 > body.len() {
                    return Err(anyhow!("Truncated 32-bit field"));
                }
                pos += 4;
            }
            1 => {
                if pos + 8 > body.len() {
                    return Err(anyhow!("Truncated 64-bit field"));
                }
                pos += 8;
            }
            _ => return Err(anyhow!("Unsupported protobuf wire type {wire}")),
        }
    }

    Ok(CastMessage {
        source_id,
        destination_id,
        namespace,
        payload_utf8,
    })
}

pub enum ChromecastCmd {
    Load {
        track_id: String,
        media_url: String,
        mime_type: String,
        title: String,
        artist: String,
        album: Option<String>,
        artwork_url: Option<String>,
        duration_sec: f64,
        start_sec: f64,
        autoplay: bool,
    },
    Play,
    Pause,
    Seek(f64),
    SetVolume(f32),
    Disconnect,
}

#[derive(Clone)]
pub struct ChromecastMeta {
    pub track_id: String,
    pub media_url: String,
    pub mime_type: String,
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub artwork_url: Option<String>,
    pub duration_sec: f64,
    pub start_sec: f64,
    pub autoplay: bool,
}

async fn send_cast_json<W: AsyncWriteExt + Unpin>(
    writer: &mut W,
    source_id: &str,
    dest: &str,
    ns: &str,
    payload: Value,
) -> std::io::Result<()> {
    let bytes = encode_cast_message(&CastMessage {
        source_id: source_id.to_string(),
        destination_id: dest.to_string(),
        namespace: ns.to_string(),
        payload_utf8: payload.to_string(),
    });
    writer.write_all(&bytes).await
}

pub async fn start_chromecast_session(
    device: CastDevice,
    initial_media: ChromecastMeta,
    on_state: Arc<dyn Fn(CastSessionState) + Send + Sync>,
    on_track_ended: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<mpsc::Sender<ChromecastCmd>> {
    let provider = rustls::crypto::ring::default_provider();
    let verifier = CastCertVerifier {
        algorithms: provider.signature_verification_algorithms,
    };
    let tls_cfg = ClientConfig::builder_with_provider(Arc::new(provider))
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();

    let connector = TlsConnector::from(Arc::new(tls_cfg));
    let tcp = tokio::time::timeout(
        Duration::from_secs(6),
        TcpStream::connect((device.host.as_str(), device.port)),
    )
    .await
    .map_err(|_| anyhow!("Timed out connecting to {}", device.name))??;

    let server_name = match device.host.parse::<IpAddr>() {
        Ok(ip) => ServerName::IpAddress(ip.into()),
        Err(_) => ServerName::try_from(device.host.clone())
            .map_err(|_| anyhow!("Invalid Cast device hostname"))?,
    };
    let tls = connector.connect(server_name, tcp).await?;

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<ChromecastCmd>(32);

    tokio::spawn(async move {
        let (mut reader, mut writer) = tokio::io::split(tls);
        let sender_id = format!("sender-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let mut req_id = 1i64;
        let mut next_req = || {
            let v = req_id;
            req_id += 1;
            v
        };

        let mut session = CastSessionState {
            connected: true,
            connecting: true,
            device: Some(device.clone()),
            track_id: Some(initial_media.track_id.clone()),
            status: "loading".to_string(),
            position_sec: initial_media.start_sec,
            duration_sec: initial_media.duration_sec,
            volume: 1.0,
            muted: false,
            error: None,
        };
        on_state(session.clone());

        if send_cast_json(
            &mut writer,
            &sender_id,
            "receiver-0",
            NS_CONNECTION,
            json!({ "type": "CONNECT", "origin": {} }),
        )
        .await
        .is_err()
        {
            session.connected = false;
            session.connecting = false;
            session.status = "error".to_string();
            session.error = Some("Chromecast rejected connection".to_string());
            on_state(session);
            return;
        }

        let _ = send_cast_json(
            &mut writer,
            &sender_id,
            "receiver-0",
            NS_RECEIVER,
            json!({ "type": "GET_STATUS", "requestId": next_req() }),
        )
        .await;

        let _ = send_cast_json(
            &mut writer,
            &sender_id,
            "receiver-0",
            NS_RECEIVER,
            json!({
                "type": "LAUNCH",
                "appId": DEFAULT_MEDIA_RECEIVER_APP_ID,
                "requestId": next_req()
            }),
        )
        .await;

        let mut transport_id: Option<String> = None;
        let mut media_session_id: Option<i64> = None;
        let mut pending_media: Option<ChromecastMeta> = Some(initial_media);
        let mut heartbeat = tokio::time::interval(Duration::from_secs(4));
        let mut status_poll = tokio::time::interval(Duration::from_secs(2));
        let mut len_buf = [0u8; 4];

        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if send_cast_json(&mut writer, &sender_id, "receiver-0", NS_HEARTBEAT, json!({ "type": "PING" })).await.is_err() {
                        break;
                    }
                }
                _ = status_poll.tick() => {
                    if let Some(tid) = transport_id.as_deref() {
                        let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, json!({ "type": "GET_STATUS", "requestId": next_req() })).await;
                    }
                }
                cmd = cmd_rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    match cmd {
                        ChromecastCmd::Load {
                            track_id, media_url, mime_type, title, artist, album, artwork_url,
                            duration_sec, start_sec, autoplay,
                        } => {
                            let meta = ChromecastMeta {
                                track_id: track_id.clone(), media_url, mime_type, title, artist, album,
                                artwork_url, duration_sec, start_sec, autoplay,
                            };
                            session.track_id = Some(track_id);
                            session.status = "loading".to_string();
                            session.position_sec = start_sec;
                            session.duration_sec = duration_sec;
                            session.error = None;
                            on_state(session.clone());
                            if let Some(tid) = transport_id.as_deref() {
                                let payload = build_load_payload(next_req(), &meta);
                                if send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, payload).await.is_err() {
                                    break;
                                }
                            } else {
                                pending_media = Some(meta);
                            }
                        }
                        ChromecastCmd::Play => {
                            if let (Some(tid), Some(msid)) = (transport_id.as_deref(), media_session_id) {
                                let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, json!({ "type": "PLAY", "mediaSessionId": msid, "requestId": next_req() })).await;
                            }
                        }
                        ChromecastCmd::Pause => {
                            if let (Some(tid), Some(msid)) = (transport_id.as_deref(), media_session_id) {
                                let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, json!({ "type": "PAUSE", "mediaSessionId": msid, "requestId": next_req() })).await;
                            }
                        }
                        ChromecastCmd::Seek(sec) => {
                            if let (Some(tid), Some(msid)) = (transport_id.as_deref(), media_session_id) {
                                session.position_sec = sec.max(0.0);
                                on_state(session.clone());
                                let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, json!({ "type": "SEEK", "mediaSessionId": msid, "currentTime": sec.max(0.0), "requestId": next_req() })).await;
                            }
                        }
                        ChromecastCmd::SetVolume(vol) => {
                            let level = vol.clamp(0.0, 1.0);
                            session.volume = level;
                            on_state(session.clone());
                            let _ = send_cast_json(&mut writer, &sender_id, "receiver-0", NS_RECEIVER, json!({
                                "type": "SET_VOLUME",
                                "volume": { "level": level },
                                "requestId": next_req()
                            })).await;
                        }
                        ChromecastCmd::Disconnect => {
                            if let Some(tid) = transport_id.as_deref() {
                                if let Some(msid) = media_session_id {
                                    let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, json!({ "type": "STOP", "mediaSessionId": msid, "requestId": next_req() })).await;
                                }
                                let _ = send_cast_json(&mut writer, &sender_id, tid, NS_CONNECTION, json!({ "type": "CLOSE" })).await;
                            }
                            let _ = send_cast_json(&mut writer, &sender_id, "receiver-0", NS_CONNECTION, json!({ "type": "CLOSE" })).await;
                            break;
                        }
                    }
                }
                read_res = reader.read_exact(&mut len_buf) => {
                    if read_res.is_err() {
                        break;
                    }
                    let frame_len = u32::from_be_bytes(len_buf) as usize;
                    if frame_len == 0 || frame_len > 256 * 1024 {
                        break;
                    }
                    let mut body = vec![0u8; frame_len];
                    if reader.read_exact(&mut body).await.is_err() {
                        break;
                    }
                    let Ok(msg) = decode_cast_message_body(&body) else {
                        continue;
                    };
                    let Ok(val) = serde_json::from_str::<Value>(&msg.payload_utf8) else {
                        continue;
                    };
                    let msg_type = val.get("type").and_then(Value::as_str).unwrap_or("");
                    match msg.namespace.as_str() {
                        NS_HEARTBEAT if msg_type == "PING" => {
                            let _ = send_cast_json(&mut writer, &sender_id, "receiver-0", NS_HEARTBEAT, json!({ "type": "PONG" })).await;
                        }
                        NS_CONNECTION if msg_type == "CLOSE" => {
                            if transport_id.as_deref() == Some(msg.source_id.as_str()) {
                                transport_id = None;
                                media_session_id = None;
                            }
                        }
                        NS_RECEIVER if msg_type == "LAUNCH_ERROR" => {
                            let reason = val.get("reason").and_then(Value::as_str).unwrap_or("unknown");
                            session.connected = false;
                            session.connecting = false;
                            session.status = "error".to_string();
                            session.error = Some(format!("Receiver failed to launch media player ({reason})."));
                            on_state(session);
                            return;
                        }
                        NS_RECEIVER if msg_type == "RECEIVER_STATUS" => {
                            if let Some(vol) = val.pointer("/status/volume/level").and_then(Value::as_f64) {
                                session.volume = vol as f32;
                            }
                            if let Some(muted) = val.pointer("/status/volume/muted").and_then(Value::as_bool) {
                                session.muted = muted;
                            }
                            if let Some(apps) = val.pointer("/status/applications").and_then(Value::as_array) {
                                if let Some(app) = apps.iter().find(|a| a.get("appId").and_then(Value::as_str) == Some(DEFAULT_MEDIA_RECEIVER_APP_ID)) {
                                    if let Some(tid) = app.get("transportId").and_then(Value::as_str) {
                                        let changed = transport_id.as_deref() != Some(tid);
                                        if changed {
                                            transport_id = Some(tid.to_string());
                                            let _ = send_cast_json(&mut writer, &sender_id, tid, NS_CONNECTION, json!({ "type": "CONNECT", "origin": {} })).await;
                                            if let Some(meta) = pending_media.take() {
                                                let payload = build_load_payload(next_req(), &meta);
                                                let _ = send_cast_json(&mut writer, &sender_id, tid, NS_MEDIA, payload).await;
                                            }
                                        }
                                        session.connecting = false;
                                    }
                                }
                            }
                            on_state(session.clone());
                        }
                        NS_MEDIA if matches!(msg_type, "LOAD_FAILED" | "LOAD_CANCELLED" | "INVALID_REQUEST") => {
                            let reason = val
                                .get("detailedErrorCode")
                                .and_then(Value::as_i64)
                                .map(|c| format!("code {c}"))
                                .or_else(|| val.get("reason").and_then(Value::as_str).map(String::from))
                                .unwrap_or_else(|| msg_type.to_string());
                            session.connecting = false;
                            session.status = "error".to_string();
                            session.error = Some(format!(
                                "Receiver could not load this track ({reason}). Check that Windows Firewall allows BitChord on your local Wi-Fi."
                            ));
                            on_state(session.clone());
                        }
                        NS_MEDIA if msg_type == "MEDIA_STATUS" => {
                            if let Some(arr) = val.get("status").and_then(Value::as_array) {
                                if let Some(st) = arr.first() {
                                    if let Some(msid) = st.get("mediaSessionId").and_then(Value::as_i64) {
                                        media_session_id = Some(msid);
                                    }
                                    if let Some(ct) = st.get("currentTime").and_then(Value::as_f64) {
                                        session.position_sec = ct;
                                    }
                                    if let Some(dur) = st.pointer("/media/duration").and_then(Value::as_f64) {
                                        if dur > 0.0 {
                                            session.duration_sec = dur;
                                        }
                                    }
                                    let pstate = st.get("playerState").and_then(Value::as_str).unwrap_or("IDLE");
                                    let idle_reason = st.get("idleReason").and_then(Value::as_str).unwrap_or("");
                                    session.connecting = false;
                                    session.status = match pstate {
                                        "PLAYING" => "playing".to_string(),
                                        "PAUSED" => "paused".to_string(),
                                        "BUFFERING" | "LOADING" => "buffering".to_string(),
                                        _ => "idle".to_string(),
                                    };
                                    on_state(session.clone());
                                    if pstate == "IDLE" && idle_reason == "FINISHED" {
                                        if let Some(finished_id) = session.track_id.clone() {
                                            on_track_ended(finished_id);
                                        }
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        on_state(CastSessionState::default());
    });

    Ok(cmd_tx)
}

fn build_load_payload(request_id: i64, meta: &ChromecastMeta) -> Value {
    let clean_mime = meta.mime_type.split(';').next().unwrap_or("audio/mp4").trim();
    let mut metadata = serde_json::Map::new();
    metadata.insert("metadataType".into(), json!(3));
    metadata.insert("title".into(), json!(meta.title));
    metadata.insert("artist".into(), json!(meta.artist));
    if let Some(album) = meta.album.as_deref().filter(|a| !a.trim().is_empty()) {
        metadata.insert("albumName".into(), json!(album));
    }
    if let Some(art) = meta.artwork_url.as_deref().filter(|u| !u.trim().is_empty()) {
        metadata.insert("images".into(), json!([{ "url": art }]));
    }

    let mut media = serde_json::Map::new();
    media.insert("contentId".into(), json!(meta.media_url));
    media.insert("contentUrl".into(), json!(meta.media_url));
    media.insert("contentType".into(), json!(clean_mime));
    media.insert("streamType".into(), json!("BUFFERED"));
    if meta.duration_sec > 0.0 {
        media.insert("duration".into(), json!(meta.duration_sec));
    }
    media.insert("metadata".into(), Value::Object(metadata));

    json!({
        "type": "LOAD",
        "requestId": request_id,
        "autoplay": meta.autoplay,
        "currentTime": meta.start_sec.max(0.0),
        "media": Value::Object(media),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cast_message_protobuf_frame_roundtrips() {
        let original = CastMessage {
            source_id: "sender-0".to_string(),
            destination_id: "receiver-0".to_string(),
            namespace: NS_RECEIVER.to_string(),
            payload_utf8: r#"{"type":"LAUNCH","appId":"CC1AD845","requestId":1}"#.to_string(),
        };
        let encoded = encode_cast_message(&original);
        assert!(encoded.len() > 4);
        let len = u32::from_be_bytes([encoded[0], encoded[1], encoded[2], encoded[3]]) as usize;
        assert_eq!(len + 4, encoded.len());
        let decoded = decode_cast_message_body(&encoded[4..]).expect("decode");
        assert_eq!(decoded, original);
    }

    #[test]
    fn load_payload_omits_optional_null_fields() {
        let meta = ChromecastMeta {
            track_id: "abc".into(),
            media_url: "http://192.168.1.5:8080/cast/t/stream.m4a".into(),
            mime_type: "audio/mp4; codecs=\"mp4a.40.2\"".into(),
            title: "Song".into(),
            artist: "Artist".into(),
            album: None,
            artwork_url: None,
            duration_sec: 0.0,
            start_sec: 0.0,
            autoplay: true,
        };
        let payload = build_load_payload(7, &meta);
        let media = payload.get("media").and_then(Value::as_object).unwrap();
        assert_eq!(media.get("contentType").unwrap(), "audio/mp4");
        assert!(!media.contains_key("duration"));
        let md = media.get("metadata").and_then(Value::as_object).unwrap();
        assert!(!md.contains_key("albumName"));
        assert!(!md.contains_key("images"));
    }
}
