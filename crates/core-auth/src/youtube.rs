use crate::vault::SecretVault;
use anyhow::{anyhow, Result};
use base64::Engine;
use parking_lot::Mutex;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use url::Url;

pub const MUSIC_ORIGIN: &str = "https://music.youtube.com";
const SIGNING_COOKIES: &[&str] = &["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"];
const WEB_REMIX_VERSION: &str = "1.20251006.03.00";
const MAX_LOGINS: usize = 10;
const ACCOUNTS_TTL: Duration = Duration::from_secs(10 * 60);
const IDENTITY_HEADERS: &[&str] = &[
    "authorization",
    "cookie",
    "x-goog-authuser",
    "x-goog-pageid",
    "x-origin",
    "origin",
    "referer",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtChannel {
    pub id: String,
    pub name: String,
    pub handle: Option<String>,
    pub avatar_url: Option<String>,
    pub brand: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAccount {
    pub auth_user: String,
    pub name: String,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub channels: Vec<YtChannel>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveYtChannel {
    #[serde(flatten)]
    pub channel: YtChannel,
    pub auth_user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtAuthState {
    pub browser_signed_in: bool,
    pub connected: bool,
    pub signed_in: bool,
    pub accounts: Vec<YtAccount>,
    pub active: Option<ActiveYtChannel>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct YtFetchParams {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub body_encoding: Option<String>,
    pub auth: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponsePayload {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub body_encoding: String,
    pub url: String,
}

#[derive(Debug, Clone)]
struct StoredChannel {
    channel: YtChannel,
    auth_user: String,
    page_id: Option<String>,
    selected_on_web: bool,
}

#[derive(Debug, Clone)]
struct StoredAccount {
    auth_user: String,
    name: String,
    email: Option<String>,
    avatar_url: Option<String>,
    channels: Vec<StoredChannel>,
}

#[derive(Debug, Clone)]
struct CachedAccounts {
    list: Vec<StoredAccount>,
    web_index: Option<String>,
    problem: Option<String>,
    at: Instant,
}

#[derive(Debug, Clone)]
struct Identity {
    auth_user: String,
    page_id: Option<String>,
}

pub struct YouTubeAuthService {
    vault: Arc<SecretVault>,
    http: reqwest::Client,
    cache: Mutex<Option<CachedAccounts>>,
}

impl YouTubeAuthService {
    pub fn new(vault: Arc<SecretVault>, http: reqwest::Client) -> Self {
        Self {
            vault,
            http,
            cache: Mutex::new(None),
        }
    }

    pub fn invalidate_cache(&self) {
        *self.cache.lock() = None;
    }

    pub fn save_cookies(&self, cookie_header: Option<String>) -> Result<()> {
        self.vault.update(|data| {
            data.yt_cookie_header = cookie_header.filter(|c| !c.trim().is_empty());
            data.yt_connected = true;
        })?;
        self.invalidate_cache();
        Ok(())
    }

    pub fn sign_out(&self) -> Result<()> {
        self.vault.update(|data| {
            data.yt_cookie_header = None;
            data.yt_selected_channel_id = None;
        })?;
        self.invalidate_cache();
        Ok(())
    }

    pub async fn auth_state(&self, refresh: bool) -> YtAuthState {
        let snap = self.vault.snapshot();
        let has_secret = snap
            .yt_cookie_header
            .as_deref()
            .and_then(extract_signing_secret)
            .is_some();

        if !has_secret || !snap.yt_connected {
            return YtAuthState {
                browser_signed_in: has_secret,
                connected: snap.yt_connected,
                signed_in: false,
                accounts: Vec::new(),
                active: None,
                problem: None,
            };
        }

        let read = self.accounts(refresh).await;
        let active = choose_channel(&read, snap.yt_selected_channel_id.as_deref());
        YtAuthState {
            browser_signed_in: true,
            connected: true,
            signed_in: active.is_some(),
            problem: if active.is_some() { None } else { read.problem.clone() },
            accounts: read
                .list
                .iter()
                .map(|a| YtAccount {
                    auth_user: a.auth_user.clone(),
                    name: a.name.clone(),
                    email: a.email.clone(),
                    avatar_url: a.avatar_url.clone(),
                    channels: a.channels.iter().map(|c| c.channel.clone()).collect(),
                })
                .collect(),
            active: active.map(|c| ActiveYtChannel {
                channel: c.channel.clone(),
                auth_user: c.auth_user.clone(),
            }),
        }
    }

    pub async fn select_channel(&self, channel_id: &str) -> Result<YtAuthState> {
        let read = self.accounts(false).await;
        let exists = read
            .list
            .iter()
            .any(|a| a.channels.iter().any(|c| c.channel.id == channel_id));
        if !exists {
            return Err(anyhow!("No channel {channel_id} found for the signed-in session"));
        }
        self.vault.update(|data| {
            data.yt_selected_channel_id = Some(channel_id.to_string());
        })?;
        Ok(self.auth_state(false).await)
    }

    pub async fn set_connected(&self, connected: bool) -> Result<YtAuthState> {
        self.vault.update(|data| {
            data.yt_connected = connected;
        })?;
        Ok(self.auth_state(connected).await)
    }

    pub async fn yt_fetch(&self, params: YtFetchParams) -> Result<HttpResponsePayload> {
        if params.auth.unwrap_or(false) {
            return self.signed_yt_fetch(params).await;
        }
        let parsed = Url::parse(&params.url)?;
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("www.youtube.com")
            || !parsed.path().starts_with("/api/jnn/")
        {
            return Err(anyhow!(
                "forbidden: yt.fetch does not serve {}{}",
                parsed.origin().ascii_serialization(),
                parsed.path()
            ));
        }

        let mut headers = HeaderMap::new();
        if let Some(raw) = &params.headers {
            for (k, v) in raw {
                if let (Ok(name), Ok(val)) = (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(v),
                ) {
                    headers.insert(name, val);
                }
            }
        }
        headers.insert("origin", HeaderValue::from_static("https://www.youtube.com"));
        headers.insert("referer", HeaderValue::from_static("https://www.youtube.com/"));

        let method = reqwest::Method::from_bytes(
            params.method.as_deref().unwrap_or("GET").as_bytes(),
        )?;
        let mut req = self.http.request(method, &params.url).headers(headers);
        if let Some(body) = decode_request_body(params.body.as_deref(), params.body_encoding.as_deref())? {
            req = req.body(body);
        }
        let resp = req.send().await?;
        serialize_response(resp).await
    }

    async fn signed_yt_fetch(&self, params: YtFetchParams) -> Result<HttpResponsePayload> {
        let parsed = Url::parse(&params.url)?;
        let method_str = params.method.as_deref().unwrap_or("GET").to_uppercase();
        let host = parsed.host_str().unwrap_or("");
        let path = parsed.path();

        let is_stats = method_str == "GET"
            && matches!(host, "s.youtube.com" | "music.youtube.com" | "www.youtube.com")
            && (path == "/api/stats/playback"
                || path == "/api/stats/watchtime"
                || path == "/api/stats/atr");
        let is_innertube = matches!(host, "music.youtube.com" | "www.youtube.com")
            && path.starts_with("/youtubei/v1/");

        if !is_stats && !is_innertube {
            return Err(anyhow!(
                "forbidden: signed yt.fetch does not serve {}{}",
                parsed.origin().ascii_serialization(),
                path
            ));
        }

        let identity = self
            .active_identity()
            .await
            .ok_or_else(|| anyhow!("unauthenticated: Not signed in to YouTube Music."))?;

        let mut clean_headers = HashMap::new();
        if let Some(raw) = params.headers {
            for (k, v) in raw {
                if !IDENTITY_HEADERS.contains(&k.to_lowercase().as_str()) {
                    clean_headers.insert(k, v);
                }
            }
        }
        let body = decode_request_body(params.body.as_deref(), params.body_encoding.as_deref())?;
        let sign_as = if is_stats { Some(MUSIC_ORIGIN) } else { None };
        let resp = self
            .signed_fetch(&params.url, &method_str, clean_headers, body, &identity, sign_as)
            .await?;
        serialize_response(resp).await
    }

    async fn active_identity(&self) -> Option<Identity> {
        let snap = self.vault.snapshot();
        if !snap.yt_connected {
            return None;
        }
        snap.yt_cookie_header
            .as_deref()
            .and_then(extract_signing_secret)?;
        let read = self.accounts(false).await;
        choose_channel(&read, snap.yt_selected_channel_id.as_deref()).map(|c| Identity {
            auth_user: c.auth_user.clone(),
            page_id: c.page_id.clone(),
        })
    }

    async fn accounts(&self, refresh: bool) -> CachedAccounts {
        if !refresh {
            if let Some(cached) = self.cache.lock().clone() {
                if cached.at.elapsed() < ACCOUNTS_TTL {
                    return cached;
                }
            }
        }
        let fresh = self.read_accounts().await;
        *self.cache.lock() = Some(fresh.clone());
        fresh
    }

    async fn signed_fetch(
        &self,
        url: &str,
        method: &str,
        extra_headers: HashMap<String, String>,
        body: Option<Vec<u8>>,
        identity: &Identity,
        sign_as: Option<&str>,
    ) -> Result<reqwest::Response> {
        let snap = self.vault.snapshot();
        let cookie_header = snap
            .yt_cookie_header
            .ok_or_else(|| anyhow!("unauthenticated: No YouTube session cookies stored."))?;
        let secret = extract_signing_secret(&cookie_header)
            .ok_or_else(|| anyhow!("unauthenticated: SAPISID cookie missing."))?;

        let parsed = Url::parse(url)?;
        let origin = sign_as
            .map(str::to_string)
            .unwrap_or_else(|| parsed.origin().ascii_serialization());
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let auth_header = sapisid_hash(&secret, &origin, ts);

        let mut headers = HeaderMap::new();
        for (k, v) in extra_headers {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                headers.insert(name, val);
            }
        }
        headers.insert("authorization", HeaderValue::from_str(&auth_header)?);
        headers.insert("cookie", HeaderValue::from_str(&cookie_header)?);
        headers.insert("x-goog-authuser", HeaderValue::from_str(&identity.auth_user)?);
        headers.insert("x-origin", HeaderValue::from_str(&origin)?);
        headers.insert("origin", HeaderValue::from_str(&origin)?);
        headers.insert("referer", HeaderValue::from_str(&format!("{origin}/"))?);
        if let Some(page_id) = &identity.page_id {
            headers.insert("x-goog-pageid", HeaderValue::from_str(page_id)?);
        }

        let req_method = reqwest::Method::from_bytes(method.as_bytes())?;
        let mut req = self.http.request(req_method, url).headers(headers);
        if let Some(bytes) = body {
            req = req.body(bytes);
        }
        Ok(req.send().await?)
    }

    async fn music_api(&self, endpoint: &str, identity: &Identity) -> Result<Value> {
        let mut headers = HashMap::new();
        headers.insert("Content-Type".into(), "application/json".into());
        headers.insert("X-Youtube-Client-Name".into(), "67".into());
        headers.insert("X-Youtube-Client-Version".into(), WEB_REMIX_VERSION.into());
        let payload = json!({
            "context": {
                "client": {
                    "clientName": "WEB_REMIX",
                    "clientVersion": WEB_REMIX_VERSION,
                    "hl": "en",
                    "gl": "US"
                },
                "user": {}
            }
        });
        let resp = self
            .signed_fetch(
                &format!("{MUSIC_ORIGIN}/youtubei/v1/{endpoint}?prettyPrint=false"),
                "POST",
                headers,
                Some(serde_json::to_vec(&payload)?),
                identity,
                None,
            )
            .await?;
        let status = resp.status();
        if !status.is_success() {
            return Err(anyhow!("HTTP {}", status.as_u16()));
        }
        Ok(resp.json::<Value>().await?)
    }

    async fn read_login(&self, auth_user: String) -> (Option<StoredAccount>, Option<String>) {
        let identity = Identity {
            auth_user: auth_user.clone(),
            page_id: None,
        };
        let menu = match self.music_api("account/account_menu", &identity).await {
            Ok(v) => v,
            Err(err) => return (None, Some(format!("account_menu: {err}"))),
        };
        let mut headers_found = Vec::new();
        collect_renderers(&menu, "activeAccountHeaderRenderer", &mut headers_found);
        let Some(header) = headers_found.first() else {
            return (None, Some(describe_empty("account_menu", &menu)));
        };

        let name = renderer_text(header.get("accountName")).unwrap_or_else(|| "YouTube Music".into());
        let email = renderer_text(header.get("email"));
        let handle = renderer_text(header.get("channelHandle"));
        let avatar_url = renderer_photo(header);

        let mut channels = match self.music_api("account/accounts_list", &identity).await {
            Ok(list_json) => parse_channels(&list_json, &auth_user),
            Err(_) => Vec::new(),
        };
        if channels.is_empty() {
            channels.push(StoredChannel {
                channel: YtChannel {
                    id: channel_id(&auth_user, None),
                    name: name.clone(),
                    handle: handle.or_else(|| email.clone()),
                    avatar_url: avatar_url.clone(),
                    brand: false,
                },
                auth_user: auth_user.clone(),
                page_id: None,
                selected_on_web: true,
            });
        }
        (
            Some(StoredAccount {
                auth_user,
                name,
                email,
                avatar_url,
                channels,
            }),
            None,
        )
    }

    async fn web_session_index(&self) -> Option<String> {
        let mut headers = HashMap::new();
        headers.insert("Accept".into(), "text/html".into());
        let resp = self
            .signed_fetch(
                &format!("{MUSIC_ORIGIN}/"),
                "GET",
                headers,
                None,
                &Identity {
                    auth_user: "0".into(),
                    page_id: None,
                },
                None,
            )
            .await
            .ok()?;
        let html = resp.text().await.ok()?;
        let re = Regex::new(r#""SESSION_INDEX":"?(\d+)"#).ok()?;
        re.captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
    }

    async fn read_accounts(&self) -> CachedAccounts {
        let mut tasks = Vec::with_capacity(MAX_LOGINS);
        for i in 0..MAX_LOGINS {
            tasks.push(self.read_login(i.to_string()));
        }
        let (results, web_index) = tokio::join!(futures_util::future::join_all(tasks), self.web_session_index());

        let mut list = Vec::new();
        let mut seen = HashSet::new();
        for (account, _) in &results {
            let Some(acc) = account else { continue };
            let key = acc.email.clone().unwrap_or_else(|| {
                let ids: Vec<&str> = acc
                    .channels
                    .iter()
                    .map(|c| c.channel.id.split(':').nth(1).unwrap_or(""))
                    .collect();
                format!("{}|{}", acc.name, ids.join(","))
            });
            if seen.insert(key) {
                list.push(acc.clone());
            }
        }
        let problem = if list.is_empty() {
            let idx = web_index
                .as_deref()
                .and_then(|s| s.parse::<usize>().ok())
                .unwrap_or(0);
            results
                .get(idx)
                .and_then(|(_, why)| why.clone())
                .or_else(|| results.first().and_then(|(_, why)| why.clone()))
                .or_else(|| Some("No signed-in Google account found".into()))
        } else {
            None
        };

        CachedAccounts {
            list,
            web_index,
            problem,
            at: Instant::now(),
        }
    }
}

pub fn extract_signing_secret(cookie_header: &str) -> Option<String> {
    let mut map = HashMap::new();
    for pair in cookie_header.split(';') {
        if let Some((k, v)) = pair.trim().split_once('=') {
            map.insert(k.trim(), v.trim());
        }
    }
    for name in SIGNING_COOKIES {
        if let Some(val) = map.get(name) {
            if !val.is_empty() {
                return Some((*val).to_string());
            }
        }
    }
    None
}

pub fn sapisid_hash(secret: &str, origin: &str, timestamp: u64) -> String {
    let mut hasher = Sha1::new();
    hasher.update(format!("{timestamp} {secret} {origin}").as_bytes());
    let digest = hex::encode(hasher.finalize());
    format!("SAPISIDHASH {timestamp}_{digest}")
}

fn channel_id(auth_user: &str, page_id: Option<&str>) -> String {
    format!("{auth_user}:{}", page_id.unwrap_or("own"))
}

fn choose_channel<'a>(read: &'a CachedAccounts, selected_id: Option<&str>) -> Option<&'a StoredChannel> {
    if let Some(sel) = selected_id {
        for acc in &read.list {
            if let Some(ch) = acc.channels.iter().find(|c| c.channel.id == sel) {
                return Some(ch);
            }
        }
    }
    let web = read
        .web_index
        .as_deref()
        .and_then(|idx| read.list.iter().find(|a| a.auth_user == idx))
        .or_else(|| read.list.first())?;
    web.channels
        .iter()
        .find(|c| c.selected_on_web)
        .or_else(|| web.channels.first())
}

fn collect_renderers<'a>(root: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match root {
        Value::Array(items) => {
            for item in items {
                collect_renderers(item, key, out);
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                if k == key && v.is_object() {
                    out.push(v);
                } else {
                    collect_renderers(v, key, out);
                }
            }
        }
        _ => {}
    }
}

fn find_string(root: &Value, key: &str) -> Option<String> {
    match root {
        Value::Array(items) => items.iter().find_map(|item| find_string(item, key)),
        Value::Object(map) => {
            for (k, v) in map {
                if k == key {
                    if let Some(s) = v.as_str() {
                        if !s.is_empty() {
                            return Some(s.to_string());
                        }
                    }
                }
                if let Some(found) = find_string(v, key) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn renderer_text(node: Option<&Value>) -> Option<String> {
    let n = node?;
    if let Some(runs) = n.get("runs").and_then(Value::as_array) {
        let joined: String = runs
            .iter()
            .filter_map(|r| r.get("text").and_then(Value::as_str))
            .collect();
        if !joined.is_empty() {
            return Some(joined);
        }
    }
    n.get("simpleText")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn renderer_photo(item: &Value) -> Option<String> {
    item.get("accountPhoto")?
        .get("thumbnails")?
        .as_array()?
        .last()?
        .get("url")?
        .as_str()
        .map(str::to_string)
}

fn parse_channels(root: &Value, auth_user: &str) -> Vec<StoredChannel> {
    let mut items = Vec::new();
    collect_renderers(root, "accountItem", &mut items);
    let mut channels = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let Some(name) = renderer_text(item.get("accountName")) else {
            continue;
        };
        let page_id = find_string(item, "pageId");
        let id = channel_id(auth_user, page_id.as_deref());
        if !seen.insert(id.clone()) {
            continue;
        }
        let handle = renderer_text(item.get("channelHandle"))
            .or_else(|| renderer_text(item.get("accountByline")));
        channels.push(StoredChannel {
            channel: YtChannel {
                id,
                name,
                handle,
                avatar_url: renderer_photo(item),
                brand: page_id.is_some(),
            },
            auth_user: auth_user.to_string(),
            page_id,
            selected_on_web: item.get("isSelected").and_then(Value::as_bool) == Some(true),
        });
    }
    channels
}

fn describe_empty(endpoint: &str, body: &Value) -> String {
    if let Some(services) = body
        .get("responseContext")
        .and_then(|c| c.get("serviceTrackingParams"))
        .and_then(Value::as_array)
    {
        for service in services {
            if let Some(params) = service.get("params").and_then(Value::as_array) {
                for p in params {
                    if p.get("key").and_then(Value::as_str) == Some("logged_in")
                        && p.get("value").and_then(Value::as_str) == Some("0")
                    {
                        return format!(
                            "{endpoint}: YouTube answered as signed out (session was not accepted)"
                        );
                    }
                }
            }
        }
    }
    format!("{endpoint}: no account in the answer")
}

pub fn decode_request_body(body: Option<&str>, encoding: Option<&str>) -> Result<Option<Vec<u8>>> {
    let Some(raw) = body else { return Ok(None) };
    if encoding == Some("base64") {
        let bytes = base64::engine::general_purpose::STANDARD.decode(raw)?;
        Ok(Some(bytes))
    } else {
        Ok(Some(raw.as_bytes().to_vec()))
    }
}

pub async fn serialize_response(resp: reqwest::Response) -> Result<HttpResponsePayload> {
    let status = resp.status().as_u16();
    let url = resp.url().to_string();
    let mut headers = HashMap::new();
    for (k, v) in resp.headers() {
        if let Ok(val) = v.to_str() {
            headers.insert(k.as_str().to_lowercase(), val.to_string());
        }
    }
    let content_type = headers
        .get("content-type")
        .map(String::as_str)
        .unwrap_or("");
    let textual = content_type.contains("json")
        || content_type.contains("text")
        || content_type.contains("javascript")
        || content_type.contains("xml");
    let bytes = resp.bytes().await?;
    let (body_encoding, body) = if textual {
        ("text".to_string(), String::from_utf8_lossy(&bytes).into_owned())
    } else {
        (
            "base64".to_string(),
            base64::engine::general_purpose::STANDARD.encode(&bytes),
        )
    };
    Ok(HttpResponsePayload {
        status,
        headers,
        body,
        body_encoding,
        url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sapisid_hash_matches_known_sha1_vector() {
        let result = sapisid_hash("abc123", "https://music.youtube.com", 1_700_000_000);
        assert_eq!(
            result,
            "SAPISIDHASH 1700000000_597a8411c1c01f9c14cea84b6ec377b76d93be6e"
        );
    }

    #[test]
    fn extracts_preferred_signing_cookie() {
        let header = "SID=1; __Secure-3PAPISID=three; SAPISID=plain; SIDCC=rot";
        assert_eq!(extract_signing_secret(header).as_deref(), Some("plain"));
        let secure_only = "SID=1; __Secure-3PAPISID=three";
        assert_eq!(extract_signing_secret(secure_only).as_deref(), Some("three"));
    }
}
