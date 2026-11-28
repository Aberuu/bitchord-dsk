use crate::cast::probe::list_active_lan_adapters;
use anyhow::{anyhow, Result};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;
use uuid::Uuid;

const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const QUICK_LOGIN_TTL_MS: i64 = 5 * 60 * 1000;
const MAX_FAILED_SUBMITS: usize = 8;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLoginPayload {
    pub one_key: Option<String>,
    pub pin: Option<String>,
    pub yt_cookie_header: Option<String>,
    pub spotify_sp_dc: Option<String>,
}

pub type QuickLoginHandler = Arc<
    dyn Fn(QuickLoginPayload, bool) -> Pin<Box<dyn Future<Output = Result<String>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickLoginStatus {
    pub active: bool,
    pub code: Option<String>,
    pub pair_id: Option<String>,
    pub qr_url: Option<String>,
    pub lan_ip: Option<String>,
    pub port: Option<u16>,
    pub expires_at_ms: Option<i64>,
    pub keep_signed_in: bool,
}

impl Default for QuickLoginStatus {
    fn default() -> Self {
        Self {
            active: false,
            code: None,
            pair_id: None,
            qr_url: None,
            lan_ip: None,
            port: None,
            expires_at_ms: None,
            keep_signed_in: false,
        }
    }
}

struct ActivePairing {
    pair_id: String,
    code: String,
    qr_url: String,
    lan_ip: String,
    port: u16,
    expires_at_ms: i64,
    keep_signed_in: bool,
    failed_attempts: usize,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

impl ActivePairing {
    fn to_status(&self) -> QuickLoginStatus {
        QuickLoginStatus {
            active: true,
            code: Some(self.code.clone()),
            pair_id: Some(self.pair_id.clone()),
            qr_url: Some(self.qr_url.clone()),
            lan_ip: Some(self.lan_ip.clone()),
            port: Some(self.port),
            expires_at_ms: Some(self.expires_at_ms),
            keep_signed_in: self.keep_signed_in,
        }
    }
}

pub struct QuickLoginService {
    active: Arc<Mutex<Option<ActivePairing>>>,
    handler: QuickLoginHandler,
}

#[derive(Clone)]
struct ServerState {
    pair_id: String,
    active: Arc<Mutex<Option<ActivePairing>>>,
    handler: QuickLoginHandler,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubmitRequest {
    code: String,
    #[serde(default)]
    one_key: Option<String>,
    #[serde(default)]
    pin: Option<String>,
    #[serde(default)]
    yt_cookie_header: Option<String>,
    #[serde(default)]
    spotify_sp_dc: Option<String>,
}

impl QuickLoginService {
    pub fn new(handler: QuickLoginHandler) -> Self {
        Self {
            active: Arc::new(Mutex::new(None)),
            handler,
        }
    }

    pub async fn start(&self, keep_signed_in: bool) -> Result<QuickLoginStatus> {
        self.stop();

        let lan_ip = list_active_lan_adapters()
            .into_iter()
            .next()
            .map(|a| a.ip.to_string())
            .unwrap_or_else(|| "127.0.0.1".to_string());

        let listener = TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let pair_id = Uuid::new_v4().simple().to_string();
        let code = generate_pairing_code();
        let qr_url = format!("http://{lan_ip}:{port}/quick-login?code={code}");
        let expires_at_ms = now_ms() + QUICK_LOGIN_TTL_MS;
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

        let status = QuickLoginStatus {
            active: true,
            code: Some(code.clone()),
            pair_id: Some(pair_id.clone()),
            qr_url: Some(qr_url.clone()),
            lan_ip: Some(lan_ip.clone()),
            port: Some(port),
            expires_at_ms: Some(expires_at_ms),
            keep_signed_in,
        };

        {
            let mut guard = self.active.lock();
            *guard = Some(ActivePairing {
                pair_id: pair_id.clone(),
                code,
                qr_url,
                lan_ip,
                port,
                expires_at_ms,
                keep_signed_in,
                failed_attempts: 0,
                shutdown_tx: Some(shutdown_tx),
            });
        }

        let state = ServerState {
            pair_id: pair_id.clone(),
            active: Arc::clone(&self.active),
            handler: Arc::clone(&self.handler),
        };
        let router = Router::new()
            .route("/quick-login", get(serve_quick_login_page))
            .route("/api/quick-login/submit", post(handle_quick_login_submit))
            .with_state(state);

        let active_for_expiry = Arc::clone(&self.active);
        let pair_id_for_expiry = pair_id.clone();
        tokio::spawn(async move {
            tokio::select! {
                _ = axum::serve(listener, router).with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                }) => {}
                _ = tokio::time::sleep(Duration::from_millis(QUICK_LOGIN_TTL_MS as u64)) => {
                    let mut guard = active_for_expiry.lock();
                    if guard.as_ref().is_some_and(|a| a.pair_id == pair_id_for_expiry) {
                        if let Some(mut old) = guard.take() {
                            if let Some(tx) = old.shutdown_tx.take() {
                                let _ = tx.send(());
                            }
                        }
                    }
                }
            }
        });

        Ok(status)
    }

    pub fn set_keep_signed_in(&self, keep: bool) -> QuickLoginStatus {
        let mut guard = self.active.lock();
        if let Some(entry) = guard.as_mut() {
            entry.keep_signed_in = keep;
            return entry.to_status();
        }
        QuickLoginStatus {
            keep_signed_in: keep,
            ..Default::default()
        }
    }

    pub fn status(&self) -> QuickLoginStatus {
        let mut guard = self.active.lock();
        if let Some(entry) = guard.as_ref() {
            if now_ms() > entry.expires_at_ms {
                if let Some(mut expired) = guard.take() {
                    if let Some(tx) = expired.shutdown_tx.take() {
                        let _ = tx.send(());
                    }
                }
                return QuickLoginStatus::default();
            }
            return entry.to_status();
        }
        QuickLoginStatus::default()
    }

    pub fn stop(&self) -> QuickLoginStatus {
        let mut guard = self.active.lock();
        if let Some(mut entry) = guard.take() {
            if let Some(tx) = entry.shutdown_tx.take() {
                let _ = tx.send(());
            }
        }
        QuickLoginStatus::default()
    }
}

async fn serve_quick_login_page() -> Html<&'static str> {
    Html(QUICK_LOGIN_HTML)
}

async fn handle_quick_login_submit(
    State(state): State<ServerState>,
    Json(req): Json<SubmitRequest>,
) -> Response {
    let submitted = normalize_code(&req.code);
    if submitted.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Pairing code is required." })),
        )
            .into_response();
    }

    let keep_signed_in = {
        let mut guard = state.active.lock();
        let Some(entry) = guard.as_mut() else {
            return (
                StatusCode::GONE,
                Json(json!({ "error": "Quick Sign-In session expired or closed." })),
            )
                .into_response();
        };
        if entry.pair_id != state.pair_id || now_ms() > entry.expires_at_ms {
            if let Some(mut expired) = guard.take() {
                if let Some(tx) = expired.shutdown_tx.take() {
                    let _ = tx.send(());
                }
            }
            return (
                StatusCode::GONE,
                Json(json!({ "error": "Quick Sign-In code expired. Generate a new QR on desktop." })),
            )
                .into_response();
        }
        if entry.failed_attempts >= MAX_FAILED_SUBMITS {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({ "error": "Too many wrong attempts. Generate a new code on desktop." })),
            )
                .into_response();
        }
        let expected = normalize_code(&entry.code);
        if !ct_eq(expected.as_bytes(), submitted.as_bytes()) {
            entry.failed_attempts += 1;
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Incorrect pairing code." })),
            )
                .into_response();
        }
        entry.keep_signed_in
    };

    let payload = QuickLoginPayload {
        one_key: req.one_key.filter(|s| !s.trim().is_empty()),
        pin: req.pin.filter(|s| !s.trim().is_empty()),
        yt_cookie_header: req.yt_cookie_header.filter(|s| !s.trim().is_empty()),
        spotify_sp_dc: req.spotify_sp_dc.filter(|s| !s.trim().is_empty()),
    };

    if payload.one_key.is_none() && payload.yt_cookie_header.is_none() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Provide a 1-Key Session code or YouTube cookie header." })),
        )
            .into_response();
    }

    match (state.handler)(payload, keep_signed_in).await {
        Ok(account_name) => {
            let mut guard = state.active.lock();
            if guard.as_ref().is_some_and(|a| a.pair_id == state.pair_id) {
                if let Some(mut done) = guard.take() {
                    if let Some(tx) = done.shutdown_tx.take() {
                        tokio::spawn(async move {
                            tokio::time::sleep(Duration::from_millis(350)).await;
                            let _ = tx.send(());
                        });
                    }
                }
            }
            Json(json!({ "ok": true, "accountName": account_name })).into_response()
        }
        Err(err) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub async fn push_session_to_peer(
    http: &reqwest::Client,
    peer_url_or_host: &str,
    code: &str,
    one_key: &str,
) -> Result<String> {
    let trimmed = peer_url_or_host.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("Enter the other PC address or pairing URL"));
    }
    let raw_url = if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let parsed = Url::parse(&raw_url).map_err(|_| anyhow!("Invalid peer PC address"))?;
    let host = parsed
        .host_str()
        .ok_or_else(|| anyhow!("Peer address has no host"))?;
    let port = parsed
        .port()
        .ok_or_else(|| anyhow!("Include the port number shown on the other PC (for example 192.168.1.25:51234)"))?;

    let mut effective_code = code.trim().to_string();
    if effective_code.is_empty() {
        if let Some((_, val)) = parsed.query_pairs().find(|(k, _)| k == "code") {
            effective_code = val.to_string();
        }
    }
    if normalize_code(&effective_code).is_empty() {
        return Err(anyhow!("Enter the 6-character code shown on the other PC"));
    }

    let endpoint = format!("{}://{host}:{port}/api/quick-login/submit", parsed.scheme());
    let resp = http
        .post(&endpoint)
        .json(&json!({
            "code": effective_code,
            "oneKey": one_key,
        }))
        .send()
        .await?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("Target PC rejected pairing");
        return Err(anyhow!("{msg}"));
    }
    let name = body
        .get("accountName")
        .and_then(|v| v.as_str())
        .unwrap_or("YouTube Music")
        .to_string();
    Ok(name)
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

const QUICK_LOGIN_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>BitChord Quick Sign-In</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  :root {
    color-scheme: dark;
    --bg: #000000;
    --card: #141416;
    --card-border: rgba(255,255,255,0.12);
    --box-bg: #0a0a0c;
    --box-focus-bg: #1c1c20;
    --box-border: rgba(255,255,255,0.16);
    --box-focus: rgba(255,255,255,0.48);
    --text: #f5f5f7;
    --muted: #a1a1aa;
  }
  @media (prefers-color-scheme: light) {
    :root {
      color-scheme: light;
      --bg: #ffffff;
      --card: #f5f5f7;
      --card-border: rgba(0,0,0,0.12);
      --box-bg: #ffffff;
      --box-focus-bg: #f0f0f3;
      --box-border: rgba(0,0,0,0.16);
      --box-focus: rgba(0,0,0,0.45);
      --text: #111113;
      --muted: #636366;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 18px;
    background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .card {
    width: 100%; max-width: 420px; border-radius: 20px; padding: 24px;
    background: var(--card); border: 1px solid var(--card-border);
  }
  h1 { margin: 0 0 6px; font-size: 20px; font-weight: 700; }
  p { margin: 0 0 18px; font-size: 14px; color: var(--muted); line-height: 1.45; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input, textarea {
    width: 100%; border-radius: 12px; border: 1px solid var(--box-border);
    background: var(--box-bg); color: var(--text); padding: 12px; font-size: 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    outline: none;
  }
  input:focus, textarea:focus {
    border-color: var(--box-focus);
  }
  input { min-height: 44px; }
  .otp-row {
    display: flex; align-items: center; justify-content: center; gap: 6px;
  }
  .otp-box {
    width: clamp(34px, 11vw, 44px); height: 46px; min-height: 44px; padding: 0;
    border-radius: 10px; border: 1px solid var(--box-border);
    background: var(--box-bg); color: var(--text);
    text-align: center; font-size: 18px; font-weight: 700; text-transform: uppercase;
  }
  .otp-box:focus {
    border-color: var(--box-focus);
    background: var(--box-focus-bg);
  }
  .otp-dash {
    width: 12px; text-align: center; font-weight: 600; font-size: 16px;
    color: var(--muted); user-select: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  button {
    width: 100%; min-height: 46px; margin-top: 18px; border: 0; border-radius: 12px;
    background: #fa2d48; color: #ffffff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: not-allowed; }
  .msg { margin-top: 14px; font-size: 13px; line-height: 1.4; display: none; padding: 10px 12px; border-radius: 10px; }
  .msg.ok { display: block; background: rgba(16,185,129,0.14); color: #10b981; border: 1px solid rgba(16,185,129,0.35); }
  .msg.err { display: block; background: rgba(239,68,68,0.14); color: #ef4444; border: 1px solid rgba(239,68,68,0.35); }
  .hidden { display: none; }
</style>
</head>
<body>
  <main class="card">
    <h1>Sign in to BitChord Desktop</h1>
    <p>Confirm the pairing code shown on your PC and paste your 1-Key Session code (or YouTube Music cookie header).</p>
    <form id="f">
      <label for="otp-0">Pairing Code</label>
      <input id="code" type="hidden" required />
      <div class="otp-row" role="group" aria-label="6-character pairing code">
        <input id="otp-0" class="otp-box" data-otp-index="0" autocomplete="one-time-code" autocapitalize="characters" aria-label="Character 1 of 6" />
        <input class="otp-box" data-otp-index="1" autocomplete="off" autocapitalize="characters" aria-label="Character 2 of 6" />
        <input class="otp-box" data-otp-index="2" autocomplete="off" autocapitalize="characters" aria-label="Character 3 of 6" />
        <span class="otp-dash" aria-hidden="true">-</span>
        <input class="otp-box" data-otp-index="3" autocomplete="off" autocapitalize="characters" aria-label="Character 4 of 6" />
        <input class="otp-box" data-otp-index="4" autocomplete="off" autocapitalize="characters" aria-label="Character 5 of 6" />
        <input class="otp-box" data-otp-index="5" autocomplete="off" autocapitalize="characters" aria-label="Character 6 of 6" />
      </div>

      <label for="secret">1-Key Session (BC1K-... / BC1P-...) or Cookie Header</label>
      <textarea id="secret" rows="3" required placeholder="Paste BC1K-... or SAPISID=..."></textarea>

      <div id="pinWrap" class="hidden">
        <label for="pin">PIN Code</label>
        <input id="pin" autocomplete="off" placeholder="Enter PIN" />
      </div>

      <button id="btn" type="submit">Sign In on PC</button>
      <div id="msg" class="msg" role="status"></div>
    </form>
  </main>
  <script>
    const params = new URLSearchParams(location.search);
    const codeEl = document.getElementById('code');
    const otpBoxes = Array.from(document.querySelectorAll('.otp-box'));
    const secretEl = document.getElementById('secret');
    const pinWrap = document.getElementById('pinWrap');
    const pinEl = document.getElementById('pin');
    const btn = document.getElementById('btn');
    const msg = document.getElementById('msg');

    function sanitizeCode(raw) {
      const m = /[?&]code=([a-z0-9-]+)/i.exec(raw || '');
      const src = m ? m[1] : (raw || '');
      return src.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 6);
    }

    function syncHidden() {
      const compact = otpBoxes.map((el) => sanitizeCode(el.value).slice(0, 1)).join('');
      codeEl.value = compact.length > 3 ? compact.slice(0, 3) + '-' + compact.slice(3) : compact;
    }

    function fillBoxes(startIdx, raw) {
      const clean = sanitizeCode(raw);
      if (!clean) return;
      const start = clean.length >= 6 ? 0 : startIdx;
      for (let i = 0; i < clean.length && start + i < otpBoxes.length; i += 1) {
        otpBoxes[start + i].value = clean[i];
      }
      syncHidden();
      const nextIdx = Math.min(otpBoxes.length - 1, start + clean.length);
      otpBoxes[nextIdx].focus();
      otpBoxes[nextIdx].select();
    }

    if (params.get('code')) {
      const initial = sanitizeCode(params.get('code'));
      otpBoxes.forEach((box, idx) => { box.value = initial[idx] || ''; });
      syncHidden();
    }

    otpBoxes.forEach((box, idx) => {
      box.addEventListener('focus', () => box.select());
      box.addEventListener('input', () => {
        const clean = sanitizeCode(box.value);
        if (!clean) {
          box.value = '';
          syncHidden();
          return;
        }
        if (clean.length > 1) {
          fillBoxes(idx, clean);
          return;
        }
        box.value = clean;
        syncHidden();
        if (idx < otpBoxes.length - 1) {
          otpBoxes[idx + 1].focus();
          otpBoxes[idx + 1].select();
        }
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace') {
          e.preventDefault();
          if (box.value) {
            box.value = '';
            syncHidden();
          } else if (idx > 0) {
            otpBoxes[idx - 1].value = '';
            syncHidden();
            otpBoxes[idx - 1].focus();
          }
        } else if (e.key === 'ArrowLeft' && idx > 0) {
          e.preventDefault();
          otpBoxes[idx - 1].focus();
        } else if (e.key === 'ArrowRight' && idx < otpBoxes.length - 1) {
          e.preventDefault();
          otpBoxes[idx + 1].focus();
        }
      });
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData || window.clipboardData).getData('text');
        fillBoxes(idx, text);
      });
    });

    secretEl.addEventListener('input', () => {
      const v = secretEl.value.trim();
      pinWrap.classList.toggle('hidden', !v.startsWith('BC1P-'));
    });
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      syncHidden();
      if (sanitizeCode(codeEl.value).length < 6) {
        msg.textContent = 'Enter the 6-character pairing code shown on your PC.';
        msg.className = 'msg err';
        return;
      }
      btn.disabled = true;
      msg.className = 'msg';
      const val = secretEl.value.trim();
      const isOneKey = val.startsWith('BC1K-') || val.startsWith('BC1P-');
      try {
        const res = await fetch('/api/quick-login/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code: codeEl.value.trim(),
            oneKey: isOneKey ? val : null,
            pin: isOneKey && val.startsWith('BC1P-') ? pinEl.value.trim() : null,
            ytCookieHeader: isOneKey ? null : val,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        msg.textContent = 'Signed in on PC as ' + (data.accountName || 'YouTube Music') + '. You can close this page.';
        msg.className = 'msg ok';
      } catch (err) {
        msg.textContent = err.message || String(err);
        msg.className = 'msg err';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn quick_login_serves_html_validates_code_rate_limits_and_pushes_peer() {
        let seen = Arc::new(Mutex::new(None::<(QuickLoginPayload, bool)>));
        let seen_handler = Arc::clone(&seen);
        let svc = QuickLoginService::new(Arc::new(move |payload, keep| {
            let slot = Arc::clone(&seen_handler);
            Box::pin(async move {
                *slot.lock() = Some((payload, keep));
                Ok("Abel".to_string())
            })
        }));

        let status = svc.start(false).await.expect("start pairing server");
        assert!(status.active);
        let port = status.port.unwrap();
        let code = status.code.clone().unwrap();
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::new();

        let html = client
            .get(format!("{base}/quick-login?code={code}"))
            .send()
            .await
            .unwrap();
        assert_eq!(html.status(), reqwest::StatusCode::OK);
        assert!(html.text().await.unwrap().contains("Sign in to BitChord Desktop"));

        // Wrong code fails with 401 and eventually 429 on brute force.
        for i in 0..MAX_FAILED_SUBMITS {
            let bad = client
                .post(format!("{base}/api/quick-login/submit"))
                .json(&json!({ "code": "000-000", "oneKey": "BC1K-dummy" }))
                .send()
                .await
                .unwrap();
            assert_eq!(bad.status(), reqwest::StatusCode::UNAUTHORIZED, "attempt {i}");
        }
        let blocked = client
            .post(format!("{base}/api/quick-login/submit"))
            .json(&json!({ "code": &code, "oneKey": "BC1K-dummy" }))
            .send()
            .await
            .unwrap();
        assert_eq!(blocked.status(), reqwest::StatusCode::TOO_MANY_REQUESTS);

        // Restart cleanly with updated keep_signed_in toggle and approve via push_session_to_peer.
        let status2 = svc.start(false).await.expect("restart");
        let updated = svc.set_keep_signed_in(true);
        assert!(updated.keep_signed_in);
        let code2 = status2.code.unwrap();
        let peer_target = format!("127.0.0.1:{}", status2.port.unwrap());

        let name = push_session_to_peer(&client, &peer_target, &code2, "BC1K-sample-token")
            .await
            .expect("push session");
        assert_eq!(name, "Abel");

        let (captured, keep_flag) = seen.lock().clone().expect("handler called");
        assert_eq!(captured.one_key.as_deref(), Some("BC1K-sample-token"));
        assert!(keep_flag);
    }
}
