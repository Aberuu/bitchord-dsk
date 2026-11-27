use crate::mobile_sync::MobileNowPlaying;
use anyhow::{anyhow, Context, Result};
use axum::http::StatusCode;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use core_auth::extract_signing_secret_present;
use parking_lot::Mutex;
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use url::Url;
use uuid::Uuid;

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
pub const PAIRING_TTL_MS: i64 = 3 * 60 * 1000;
const MAX_FAILED_ATTEMPTS: usize = 5;
const PAIRING_KEY_LEN: usize = 32;
const PAIRING_NONCE_LEN: usize = 24;
const MAX_PAIRED_DEVICES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPairingPayload {
    pub v: u8,
    pub yt_cookie_header: String,
    #[serde(default)]
    pub yt_selected_channel_id: Option<String>,
    #[serde(default)]
    pub spotify_sp_dc: Option<String>,
    pub desktop_id: String,
    pub desktop_name: String,
    pub desktop_version: String,
    pub lan_url: String,
    pub sync_pin: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub issued_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPairingOfferView {
    pub active: bool,
    pub offer_id: Option<String>,
    pub code: Option<String>,
    pub qr_uri: Option<String>,
    pub lan_ip: Option<String>,
    pub port: Option<u16>,
    pub desktop_name: Option<String>,
    pub include_spotify: bool,
    pub expires_at_ms: Option<i64>,
}

impl Default for DesktopPairingOfferView {
    fn default() -> Self {
        Self {
            active: false,
            offer_id: None,
            code: None,
            qr_uri: None,
            lan_ip: None,
            port: None,
            desktop_name: None,
            include_spotify: false,
            expires_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PairedMobileRecord {
    pub device_id: String,
    pub device_name: String,
    pub platform: String,
    pub paired_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingStatusView {
    pub offer: DesktopPairingOfferView,
    pub paired_devices: Vec<PairedMobileRecord>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemRequest {
    pub offer_id: String,
    pub code: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedeemResponse {
    pub v: u8,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParsedPairingQr {
    DesktopPair {
        host: String,
        port: u16,
        offer_id: String,
        key_b64: String,
        code: String,
    },
    OneKey {
        key: String,
        needs_pin: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopHealthSnapshot {
    pub online: bool,
    pub lan_url: String,
    pub now_playing: Option<MobileNowPlaying>,
    pub server_ms: Option<i64>,
    pub error: Option<String>,
}

struct ActivePairingOffer {
    offer_id: String,
    code: String,
    qr_uri: String,
    lan_ip: String,
    port: u16,
    desktop_name: String,
    include_spotify: bool,
    expires_at_ms: i64,
    failed_attempts: usize,
    nonce_b64: String,
    ciphertext_b64: String,
}

impl ActivePairingOffer {
    fn to_view(&self) -> DesktopPairingOfferView {
        DesktopPairingOfferView {
            active: true,
            offer_id: Some(self.offer_id.clone()),
            code: Some(self.code.clone()),
            qr_uri: Some(self.qr_uri.clone()),
            lan_ip: Some(self.lan_ip.clone()),
            port: Some(self.port),
            desktop_name: Some(self.desktop_name.clone()),
            include_spotify: self.include_spotify,
            expires_at_ms: Some(self.expires_at_ms),
        }
    }
}

struct PairingInner {
    active_offer: Option<ActivePairingOffer>,
    paired_devices: Vec<PairedMobileRecord>,
}

pub struct MobilePairingService {
    inner: Mutex<PairingInner>,
    on_paired: Arc<dyn Fn(PairedMobileRecord) + Send + Sync>,
}

impl MobilePairingService {
    pub fn new(on_paired: Arc<dyn Fn(PairedMobileRecord) + Send + Sync>) -> Self {
        Self {
            inner: Mutex::new(PairingInner {
                active_offer: None,
                paired_devices: Vec::new(),
            }),
            on_paired,
        }
    }

    pub fn create_offer(
        &self,
        payload: &DesktopPairingPayload,
        lan_ip: &str,
        port: u16,
        include_spotify: bool,
    ) -> Result<DesktopPairingOfferView> {
        if payload.yt_cookie_header.trim().is_empty()
            || !extract_signing_secret_present(&payload.yt_cookie_header)
        {
            return Err(anyhow!(
                "Sign in to YouTube Music on Desktop before generating a mobile pairing QR."
            ));
        }

        let json_bytes = serde_json::to_vec(payload)?;
        let mut key_bytes = [0u8; PAIRING_KEY_LEN];
        let mut nonce_bytes = [0u8; PAIRING_NONCE_LEN];
        rand::rng().fill_bytes(&mut key_bytes);
        rand::rng().fill_bytes(&mut nonce_bytes);

        let cipher = XChaCha20Poly1305::new((&key_bytes).into());
        let ciphertext = cipher
            .encrypt(XNonce::from_slice(&nonce_bytes), json_bytes.as_slice())
            .map_err(|_| anyhow!("Failed to encrypt desktop pairing bundle"))?;

        let offer_id = Uuid::new_v4().simple().to_string()[..16].to_string();
        let code = generate_pairing_code();
        let compact_code = normalize_code(&code);
        let key_b64 = URL_SAFE_NO_PAD.encode(key_bytes);
        let nonce_b64 = URL_SAFE_NO_PAD.encode(nonce_bytes);
        let ciphertext_b64 = URL_SAFE_NO_PAD.encode(ciphertext);
        let expires_at_ms = now_ms() + PAIRING_TTL_MS;

        let mut qr_url = Url::parse("bitchord://pair")?;
        qr_url
            .query_pairs_mut()
            .append_pair("v", "1")
            .append_pair("h", lan_ip)
            .append_pair("p", &port.to_string())
            .append_pair("id", &offer_id)
            .append_pair("k", &key_b64)
            .append_pair("c", &compact_code);
        let qr_uri = qr_url.to_string();

        // Ephemeral key K stays only inside the visual QR URI, never stored in offer state.
        let offer = ActivePairingOffer {
            offer_id,
            code,
            qr_uri,
            lan_ip: lan_ip.to_string(),
            port,
            desktop_name: payload.desktop_name.clone(),
            include_spotify,
            expires_at_ms,
            failed_attempts: 0,
            nonce_b64,
            ciphertext_b64,
        };
        let view = offer.to_view();
        self.inner.lock().active_offer = Some(offer);
        Ok(view)
    }

    pub fn redeem_offer(
        &self,
        req: RedeemRequest,
    ) -> std::result::Result<RedeemResponse, (StatusCode, &'static str, String)> {
        let submitted_code = normalize_code(&req.code);
        if req.offer_id.trim().is_empty() || submitted_code.is_empty() {
            return Err((
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Offer ID and pairing code are required.".to_string(),
            ));
        }

        let ts = now_ms();
        let (resp, paired_record) = {
            let mut guard = self.inner.lock();
            let Some(offer) = guard.active_offer.as_mut() else {
                return Err((
                    StatusCode::GONE,
                    "offer_expired",
                    "Pairing QR expired or already used. Generate a new QR on Desktop.".to_string(),
                ));
            };

            if offer.offer_id != req.offer_id.trim() {
                return Err((
                    StatusCode::GONE,
                    "offer_mismatch",
                    "This QR code has been replaced by a newer one on Desktop.".to_string(),
                ));
            }

            if ts > offer.expires_at_ms {
                guard.active_offer = None;
                return Err((
                    StatusCode::GONE,
                    "offer_expired",
                    "Pairing QR expired. Generate a new QR on Desktop.".to_string(),
                ));
            }

            if offer.failed_attempts >= MAX_FAILED_ATTEMPTS {
                guard.active_offer = None;
                return Err((
                    StatusCode::TOO_MANY_REQUESTS,
                    "too_many_attempts",
                    "Too many failed pairing attempts. Generate a new QR on Desktop.".to_string(),
                ));
            }

            let expected_code = normalize_code(&offer.code);
            if !ct_eq(expected_code.as_bytes(), submitted_code.as_bytes()) {
                offer.failed_attempts += 1;
                if offer.failed_attempts >= MAX_FAILED_ATTEMPTS {
                    guard.active_offer = None;
                    return Err((
                        StatusCode::TOO_MANY_REQUESTS,
                        "too_many_attempts",
                        "Too many failed pairing attempts. Generate a new QR on Desktop."
                            .to_string(),
                    ));
                }
                return Err((
                    StatusCode::UNAUTHORIZED,
                    "invalid_code",
                    "Incorrect pairing code.".to_string(),
                ));
            }

            // Single-use atomic consume: replay attempts immediately fail with 410 Gone.
            let consumed = guard.active_offer.take().expect("checked active_offer");
            let device_id = if req.device_id.trim().is_empty() {
                format!("mobile-{}", &Uuid::new_v4().simple().to_string()[..8])
            } else {
                req.device_id.trim().to_string()
            };
            let device_name = if req.device_name.trim().is_empty() {
                "BitChord Mobile".to_string()
            } else {
                req.device_name.trim().to_string()
            };
            let platform = if req.platform.trim().is_empty() {
                "android".to_string()
            } else {
                req.platform.trim().to_ascii_lowercase()
            };

            let record = PairedMobileRecord {
                device_id: device_id.clone(),
                device_name,
                platform,
                paired_at_ms: ts,
            };
            guard.paired_devices.retain(|d| d.device_id != device_id);
            guard.paired_devices.insert(0, record.clone());
            guard.paired_devices.truncate(MAX_PAIRED_DEVICES);

            let resp = RedeemResponse {
                v: 1,
                nonce: consumed.nonce_b64,
                ciphertext: consumed.ciphertext_b64,
            };
            (resp, record)
        };

        (self.on_paired)(paired_record);
        Ok(resp)
    }

    pub fn status(&self) -> PairingStatusView {
        let mut guard = self.inner.lock();
        let ts = now_ms();
        if let Some(ref offer) = guard.active_offer {
            if ts > offer.expires_at_ms {
                guard.active_offer = None;
            }
        }
        PairingStatusView {
            offer: guard
                .active_offer
                .as_ref()
                .map(ActivePairingOffer::to_view)
                .unwrap_or_default(),
            paired_devices: guard.paired_devices.clone(),
        }
    }

    pub fn stop(&self) -> PairingStatusView {
        let mut guard = self.inner.lock();
        guard.active_offer = None;
        PairingStatusView {
            offer: DesktopPairingOfferView::default(),
            paired_devices: guard.paired_devices.clone(),
        }
    }
}

pub fn parse_pairing_qr(raw: &str) -> Result<ParsedPairingQr> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Scan or paste a BitChord Desktop QR code first."));
    }

    if trimmed.starts_with("BC1K-") {
        return Ok(ParsedPairingQr::OneKey {
            key: trimmed.to_string(),
            needs_pin: false,
        });
    }
    if trimmed.starts_with("BC1P-") {
        return Ok(ParsedPairingQr::OneKey {
            key: trimmed.to_string(),
            needs_pin: true,
        });
    }

    let parsed = Url::parse(trimmed)
        .map_err(|_| anyhow!("Unrecognized QR code. Expected a BitChord Desktop pairing QR or 1-Key token."))?;
    if !parsed.scheme().eq_ignore_ascii_case("bitchord")
        || parsed.host_str() != Some("pair")
    {
        return Err(anyhow!(
            "This QR code is not a BitChord Desktop pairing link."
        ));
    }

    let mut version = None;
    let mut host = None;
    let mut port = None;
    let mut offer_id = None;
    let mut key_b64 = None;
    let mut code = None;

    for (k, v) in parsed.query_pairs() {
        match k.as_ref() {
            "v" => version = Some(v.into_owned()),
            "h" => host = Some(v.into_owned()),
            "p" => port = v.parse::<u16>().ok(),
            "id" => offer_id = Some(v.into_owned()),
            "k" => key_b64 = Some(v.into_owned()),
            "c" => code = Some(v.into_owned()),
            _ => {}
        }
    }

    if version.as_deref() != Some("1") {
        return Err(anyhow!("Unsupported BitChord pairing QR version."));
    }

    let host = host
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Pairing QR is missing Desktop IP address."))?;
    let port = port.filter(|p| *p > 0).ok_or_else(|| anyhow!("Pairing QR has an invalid port."))?;
    let offer_id = offer_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Pairing QR is missing offer ID."))?;
    let key_b64 = key_b64
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("Pairing QR is missing encryption key."))?;
    let decoded_key = URL_SAFE_NO_PAD
        .decode(key_b64.as_bytes())
        .map_err(|_| anyhow!("Pairing QR key is malformed."))?;
    if decoded_key.len() != PAIRING_KEY_LEN {
        return Err(anyhow!("Pairing QR key length is invalid."));
    }
    let code = code
        .map(|s| normalize_code(&s))
        .filter(|s| s.len() >= 4)
        .ok_or_else(|| anyhow!("Pairing QR is missing verification code."))?;

    Ok(ParsedPairingQr::DesktopPair {
        host,
        port,
        offer_id,
        key_b64,
        code,
    })
}

pub async fn redeem_desktop_pairing(
    http: &reqwest::Client,
    host: &str,
    port: u16,
    offer_id: &str,
    key_b64: &str,
    code: &str,
    device_id: &str,
    device_name: &str,
    platform: &str,
) -> Result<DesktopPairingPayload> {
    let key_vec = URL_SAFE_NO_PAD
        .decode(key_b64.as_bytes())
        .map_err(|_| anyhow!("Invalid pairing encryption key"))?;
    let key: [u8; PAIRING_KEY_LEN] = key_vec
        .try_into()
        .map_err(|_| anyhow!("Invalid pairing key length"))?;

    let endpoint = format!("http://{host}:{port}/api/pair/redeem");
    let resp = http
        .post(&endpoint)
        .timeout(Duration::from_secs(6))
        .json(&serde_json::json!({
            "offerId": offer_id,
            "code": normalize_code(code),
            "deviceId": device_id,
            "deviceName": device_name,
            "platform": platform,
        }))
        .send()
        .await
        .with_context(|| {
            format!("Could not reach BitChord Desktop at {host}:{port}. Check that both devices are on the same Wi-Fi and Windows Firewall allows BitChord.")
        })?;

    let status = resp.status();
    if !status.is_success() {
        let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| serde_json::json!({}));
        let msg = body
            .get("message")
            .and_then(|v| v.as_str())
            .or_else(|| body.get("error").and_then(|v| v.as_str()))
            .unwrap_or("Desktop rejected the pairing request.");
        return Err(anyhow!("{msg}"));
    }

    let envelope: RedeemResponse = resp
        .json()
        .await
        .context("Desktop returned an invalid pairing response")?;
    if envelope.v != 1 {
        return Err(anyhow!("Unsupported pairing envelope version {}", envelope.v));
    }

    let nonce_vec = URL_SAFE_NO_PAD
        .decode(envelope.nonce.as_bytes())
        .map_err(|_| anyhow!("Malformed pairing nonce"))?;
    if nonce_vec.len() != PAIRING_NONCE_LEN {
        return Err(anyhow!("Invalid pairing nonce length"));
    }
    let ciphertext = URL_SAFE_NO_PAD
        .decode(envelope.ciphertext.as_bytes())
        .map_err(|_| anyhow!("Malformed encrypted pairing payload"))?;

    let cipher = XChaCha20Poly1305::new((&key).into());
    let plain = cipher
        .decrypt(XNonce::from_slice(&nonce_vec), ciphertext.as_slice())
        .map_err(|_| anyhow!("Failed to decrypt Desktop pairing payload (key mismatch or tampered data)."))?;

    let payload: DesktopPairingPayload =
        serde_json::from_slice(&plain).context("Invalid decrypted Desktop pairing JSON")?;
    if payload.v != 1 {
        return Err(anyhow!("Unsupported pairing payload version {}", payload.v));
    }
    if payload.yt_cookie_header.trim().is_empty()
        || !extract_signing_secret_present(&payload.yt_cookie_header)
    {
        return Err(anyhow!(
            "Desktop pairing bundle did not contain valid YouTube Music credentials."
        ));
    }
    Ok(payload)
}

pub async fn check_desktop_health(
    http: &reqwest::Client,
    lan_url: &str,
    sync_pin: &str,
) -> DesktopHealthSnapshot {
    let base = lan_url.trim_end_matches('/');
    let health_res = http
        .get(format!("{base}/healthz"))
        .timeout(Duration::from_secs(3))
        .send()
        .await;

    let Ok(resp) = health_res else {
        return DesktopHealthSnapshot {
            online: false,
            lan_url: base.to_string(),
            now_playing: None,
            server_ms: None,
            error: Some("Desktop is offline or not on the same Wi-Fi.".to_string()),
        };
    };

    if !resp.status().is_success() {
        return DesktopHealthSnapshot {
            online: false,
            lan_url: base.to_string(),
            now_playing: None,
            server_ms: None,
            error: Some(format!("Desktop returned HTTP {}", resp.status().as_u16())),
        };
    }

    let np_res = http
        .get(format!("{base}/api/sync/now-playing"))
        .header("X-Sync-Pin", sync_pin)
        .timeout(Duration::from_secs(3))
        .send()
        .await;

    if let Ok(np_resp) = np_res {
        if np_resp.status().is_success() {
            if let Ok(body) = np_resp.json::<serde_json::Value>().await {
                let now_playing = body
                    .get("nowPlaying")
                    .and_then(|v| serde_json::from_value::<MobileNowPlaying>(v.clone()).ok());
                let server_ms = body.get("serverMs").and_then(|v| v.as_i64());
                return DesktopHealthSnapshot {
                    online: true,
                    lan_url: base.to_string(),
                    now_playing,
                    server_ms,
                    error: None,
                };
            }
        }
    }

    DesktopHealthSnapshot {
        online: true,
        lan_url: base.to_string(),
        now_playing: None,
        server_ms: None,
        error: None,
    }
}

fn generate_pairing_code() -> String {
    let mut rng = rand::rng();
    let mut chars = Vec::with_capacity(6);
    for _ in 0..6 {
        chars.push(CODE_ALPHABET[rng.random_range(0..CODE_ALPHABET.len())] as char);
    }
    format!(
        "{}{}{}-{}{}{}",
        chars[0], chars[1], chars[2], chars[3], chars[4], chars[5]
    )
}

fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile_sync::MobileSyncService;
    use core_stats::ListeningStatsStore;

    fn sample_payload() -> DesktopPairingPayload {
        DesktopPairingPayload {
            v: 1,
            yt_cookie_header: "SID=abc; SAPISID=xyz_secret_123; __Secure-3PAPISID=p3".into(),
            yt_selected_channel_id: Some("0:own".into()),
            spotify_sp_dc: Some("sp_dc_sample".into()),
            desktop_id: "pc-uuid-1".into(),
            desktop_name: "Abel Workstation".into(),
            desktop_version: "1.4.2".into(),
            lan_url: "http://192.168.1.42:48221".into(),
            sync_pin: "123456".into(),
            capabilities: vec!["auth".into(), "lan-sync".into(), "party".into()],
            issued_at_ms: 1_700_000_000_000,
        }
    }

    #[test]
    fn qr_uri_is_compact_and_roundtrips_with_parser() {
        let svc = MobilePairingService::new(Arc::new(|_| {}));
        let view = svc
            .create_offer(&sample_payload(), "192.168.100.123", 48221, true)
            .expect("create offer");
        let uri = view.qr_uri.expect("qr_uri");
        assert!(
            uri.len() < 180,
            "QR URI must stay compact for quick phone scanning, got {} chars: {uri}",
            uri.len()
        );

        let parsed = parse_pairing_qr(&uri).expect("parse uri");
        match parsed {
            ParsedPairingQr::DesktopPair {
                host,
                port,
                offer_id,
                key_b64,
                code,
            } => {
                assert_eq!(host, "192.168.100.123");
                assert_eq!(port, 48221);
                assert_eq!(offer_id, view.offer_id.unwrap());
                assert_eq!(key_b64.len(), 43);
                assert_eq!(code, normalize_code(&view.code.unwrap()));
            }
            ParsedPairingQr::OneKey { .. } => panic!("expected DesktopPair"),
        }

        assert!(matches!(
            parse_pairing_qr("BC1K-abc").unwrap(),
            ParsedPairingQr::OneKey { needs_pin: false, .. }
        ));
        assert!(matches!(
            parse_pairing_qr("BC1P-xyz").unwrap(),
            ParsedPairingQr::OneKey { needs_pin: true, .. }
        ));
    }

    #[tokio::test]
    async fn end_to_end_encrypt_redeem_decrypt_and_single_use_replay_protection() {
        let dir = std::env::temp_dir().join(format!(
            "bitchord-pair-e2e-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let stats = Arc::new(ListeningStatsStore::open_at(dir.clone()).expect("open stats"));
        let paired_events = Arc::new(Mutex::new(Vec::<PairedMobileRecord>::new()));
        let paired_cb = Arc::clone(&paired_events);

        let sync = MobileSyncService::with_callbacks(
            stats,
            Arc::new(|_| {}),
            Arc::new(move |rec| paired_cb.lock().push(rec)),
        );
        let status = sync.start(None).await.expect("start sync server");
        let port = status.port.expect("port");
        let mut payload = sample_payload();
        payload.lan_url = format!("http://127.0.0.1:{port}");
        payload.sync_pin = status.sync_pin.clone();

        let view = sync
            .pairing()
            .create_offer(&payload, "127.0.0.1", port, true)
            .expect("create offer");
        let ParsedPairingQr::DesktopPair {
            host,
            port,
            offer_id,
            key_b64,
            code,
        } = parse_pairing_qr(view.qr_uri.as_deref().unwrap()).expect("parse")
        else {
            panic!("expected DesktopPair");
        };

        let http = reqwest::Client::new();
        let redeemed = redeem_desktop_pairing(
            &http,
            &host,
            port,
            &offer_id,
            &key_b64,
            &code,
            "android-device-1",
            "Pixel 9 Pro",
            "android",
        )
        .await
        .expect("redeem ok");
        assert_eq!(redeemed, payload);

        let paired = paired_events.lock();
        assert_eq!(paired.len(), 1);
        assert_eq!(paired[0].device_name, "Pixel 9 Pro");
        assert_eq!(paired[0].platform, "android");
        drop(paired);

        // Single-use guarantee: second redeem must fail.
        let replay = redeem_desktop_pairing(
            &http,
            &host,
            port,
            &offer_id,
            &key_b64,
            &code,
            "android-device-2",
            "Attacker",
            "android",
        )
        .await;
        assert!(replay.is_err());

        // Health endpoint works with the transferred sync_pin.
        let health = check_desktop_health(&http, &redeemed.lan_url, &redeemed.sync_pin).await;
        assert!(health.online);

        sync.stop();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_code_rate_limits_and_locks_out() {
        let svc = MobilePairingService::new(Arc::new(|_| {}));
        let view = svc
            .create_offer(&sample_payload(), "192.168.1.10", 48221, false)
            .expect("create offer");
        let offer_id = view.offer_id.unwrap();

        for i in 0..(MAX_FAILED_ATTEMPTS - 1) {
            let err = svc
                .redeem_offer(RedeemRequest {
                    offer_id: offer_id.clone(),
                    code: "000000".into(),
                    device_id: "d1".into(),
                    device_name: "Phone".into(),
                    platform: "android".into(),
                })
                .unwrap_err();
            assert_eq!(err.0, StatusCode::UNAUTHORIZED, "attempt {i}");
        }

        let lockout = svc
            .redeem_offer(RedeemRequest {
                offer_id: offer_id.clone(),
                code: "000000".into(),
                device_id: "d1".into(),
                device_name: "Phone".into(),
                platform: "android".into(),
            })
            .unwrap_err();
        assert_eq!(lockout.0, StatusCode::TOO_MANY_REQUESTS);
        assert!(!svc.status().offer.active);
    }

    #[test]
    fn tampered_ciphertext_or_wrong_key_is_rejected() {
        let svc = MobilePairingService::new(Arc::new(|_| {}));
        let view = svc
            .create_offer(&sample_payload(), "192.168.1.10", 48221, false)
            .expect("offer");
        let offer_id = view.offer_id.unwrap();
        let code = view.code.unwrap();

        let resp = svc
            .redeem_offer(RedeemRequest {
                offer_id,
                code,
                device_id: "d1".into(),
                device_name: "Phone".into(),
                platform: "android".into(),
            })
            .expect("redeem");

        let wrong_key = [9u8; PAIRING_KEY_LEN];
        let nonce = URL_SAFE_NO_PAD.decode(resp.nonce.as_bytes()).unwrap();
        let ct = URL_SAFE_NO_PAD.decode(resp.ciphertext.as_bytes()).unwrap();
        let cipher = XChaCha20Poly1305::new((&wrong_key).into());
        assert!(cipher.decrypt(XNonce::from_slice(&nonce), ct.as_slice()).is_err());
    }
}
