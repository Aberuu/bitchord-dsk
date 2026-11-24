use anyhow::Result;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use parking_lot::RwLock;
use serde::Deserialize;
use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

pub type SmbRangeFuture = Pin<Box<dyn Future<Output = Result<(Vec<u8>, u64)>> + Send>>;
pub type SmbRangeReader = Arc<dyn Fn(String, u64, Option<u64>) -> SmbRangeFuture + Send + Sync>;

#[derive(Clone)]
pub struct RegisteredHttpTarget {
    pub url: String,
    pub headers: HashMap<String, String>,
    pub content_type_hint: Option<String>,
}

#[derive(Clone)]
pub struct RegisteredSmbTarget {
    pub rel_path: String,
    pub mime: &'static str,
}

#[derive(Clone)]
struct ProxyState {
    token: String,
    http: reqwest::Client,
    local_files: Arc<RwLock<HashMap<String, PathBuf>>>,
    http_targets: Arc<RwLock<HashMap<String, RegisteredHttpTarget>>>,
    smb_targets: Arc<RwLock<HashMap<String, RegisteredSmbTarget>>>,
    smb_reader: Arc<RwLock<Option<SmbRangeReader>>>,
    allow_loopback_upstream: bool,
}

#[derive(Deserialize)]
struct ProxyQuery {
    url: String,
}

pub struct LoopbackProxy {
    base_url: String,
    token: String,
    local_files: Arc<RwLock<HashMap<String, PathBuf>>>,
    http_targets: Arc<RwLock<HashMap<String, RegisteredHttpTarget>>>,
    smb_targets: Arc<RwLock<HashMap<String, RegisteredSmbTarget>>>,
    smb_reader: Arc<RwLock<Option<SmbRangeReader>>>,
}

impl LoopbackProxy {
    pub async fn start(http: reqwest::Client) -> Result<Self> {
        Self::start_with_options(http, false).await
    }

    async fn start_with_options(
        http: reqwest::Client,
        allow_loopback_upstream: bool,
    ) -> Result<Self> {
        let token = Uuid::new_v4().simple().to_string();
        let local_files = Arc::new(RwLock::new(HashMap::new()));
        let http_targets = Arc::new(RwLock::new(HashMap::new()));
        let smb_targets = Arc::new(RwLock::new(HashMap::new()));
        let smb_reader = Arc::new(RwLock::new(None));
        let state = ProxyState {
            token: token.clone(),
            http,
            local_files: Arc::clone(&local_files),
            http_targets: Arc::clone(&http_targets),
            smb_targets: Arc::clone(&smb_targets),
            smb_reader: Arc::clone(&smb_reader),
            allow_loopback_upstream,
        };
        let app = Router::new()
            .route("/{token}/proxy", any(handle_proxy))
            .route("/{token}/local/{id}", get(handle_local_file))
            .route("/{token}/remote/{id}", any(handle_remote_http))
            .route("/{token}/smb/{id}", any(handle_smb_file))
            .with_state(state);

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await?;
        let addr = listener.local_addr()?;
        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                tracing::error!("Loopback proxy stopped: {err}");
            }
        });

        Ok(Self {
            base_url: format!("http://127.0.0.1:{}/{token}", addr.port()),
            token,
            local_files,
            http_targets,
            smb_targets,
            smb_reader,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn register_local_file(&self, id: String, path: PathBuf) -> String {
        self.local_files.write().insert(id.clone(), path);
        format!("{}/local/{id}", self.base_url)
    }

    pub fn register_http_target(
        &self,
        id: String,
        url: String,
        headers: HashMap<String, String>,
        content_type_hint: Option<String>,
    ) -> String {
        self.http_targets.write().insert(
            id.clone(),
            RegisteredHttpTarget {
                url,
                headers,
                content_type_hint,
            },
        );
        format!("{}/remote/{id}", self.base_url)
    }

    pub fn get_http_target(&self, id: &str) -> Option<RegisteredHttpTarget> {
        self.http_targets.read().get(id).cloned()
    }

    pub fn register_smb_target(&self, id: String, rel_path: String) -> String {
        let mime = mime_for_path(std::path::Path::new(&rel_path));
        self.smb_targets
            .write()
            .insert(id.clone(), RegisteredSmbTarget { rel_path, mime });
        format!("{}/smb/{id}", self.base_url)
    }

    pub fn get_smb_target(&self, id: &str) -> Option<RegisteredSmbTarget> {
        self.smb_targets.read().get(id).cloned()
    }

    pub fn set_smb_reader(&self, reader: SmbRangeReader) {
        *self.smb_reader.write() = Some(reader);
    }
}

pub fn rewrite_request_headers(target: &Url, headers: &mut HeaderMap) {
    let host = target.host_str().unwrap_or("");
    let path = target.path();

    headers.remove("host");
    headers.remove("origin");
    headers.remove("referer");
    headers.remove("x-origin");
    headers.remove("sec-fetch-site");
    headers.remove("sec-fetch-mode");
    headers.remove("sec-fetch-dest");

    if host == "music.youtube.com" && path.starts_with("/youtubei/") {
        set_impersonation(headers, "https://music.youtube.com", true);
    } else if host == "www.youtube.com" && path.starts_with("/youtubei/") {
        set_impersonation(headers, "https://www.youtube.com", true);
    } else if host == "googlevideo.com" || host.ends_with(".googlevideo.com") {
        // VISIONOS direct media URLs return 403 mid-track if Origin or Referer are attached.
        let is_visionos = target
            .query_pairs()
            .any(|(k, v)| k == "c" && v.eq_ignore_ascii_case("VISIONOS"));
        if !is_visionos {
            set_impersonation(headers, "https://www.youtube.com", false);
        }
    } else if host == "music.apple.com" || host == "amp-api.music.apple.com" {
        set_impersonation(headers, "https://music.apple.com", false);
    }
}

fn set_impersonation(headers: &mut HeaderMap, origin: &'static str, with_x_origin: bool) {
    headers.insert("origin", HeaderValue::from_static(origin));
    if let Ok(referer) = HeaderValue::from_str(&format!("{origin}/")) {
        headers.insert("referer", referer);
    }
    if with_x_origin {
        headers.insert("x-origin", HeaderValue::from_static(origin));
    }
}

fn is_allowed_host(target: &Url, allow_loopback: bool) -> bool {
    let scheme = target.scheme();
    if scheme != "https" && !(allow_loopback && scheme == "http") {
        return false;
    }
    let Some(host) = target.host_str() else {
        return false;
    };
    if allow_loopback && (host == "127.0.0.1" || host == "localhost") {
        return true;
    }
    matches!(
        host,
        "music.youtube.com"
            | "www.youtube.com"
            | "youtube.com"
            | "music.apple.com"
            | "amp-api.music.apple.com"
            | "open.spotify.com"
    ) || host.ends_with(".googlevideo.com")
        || host.ends_with(".ytimg.com")
        || host.ends_with(".ggpht.com")
        || host.ends_with(".googleusercontent.com")
        || host.ends_with(".mzstatic.com")
        || host.ends_with(".apple.com")
        || host.ends_with(".scdn.co")
        || host.ends_with(".spotifycdn.com")
}

fn cors_headers(map: &mut HeaderMap) {
    map.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    map.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, HEAD, OPTIONS"),
    );
    map.insert("access-control-allow-headers", HeaderValue::from_static("*"));
    map.insert(
        "access-control-expose-headers",
        HeaderValue::from_static("*"),
    );
}

async fn handle_proxy(
    State(state): State<ProxyState>,
    Path(token): Path<String>,
    Query(query): Query<ProxyQuery>,
    method: Method,
    mut req_headers: HeaderMap,
    body: Body,
) -> Response {
    if token != state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    if method == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        cors_headers(resp.headers_mut());
        return resp;
    }

    let Ok(target) = Url::parse(&query.url) else {
        return (StatusCode::BAD_REQUEST, "Invalid target URL").into_response();
    };
    if !is_allowed_host(&target, state.allow_loopback_upstream) {
        return (StatusCode::FORBIDDEN, "Target host is not permitted").into_response();
    }

    rewrite_request_headers(&target, &mut req_headers);
    let body_bytes = match axum::body::to_bytes(body, 16 * 1024 * 1024).await {
        Ok(b) => b,
        Err(err) => return (StatusCode::BAD_REQUEST, err.to_string()).into_response(),
    };

    let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };

    let mut forward_headers = reqwest::header::HeaderMap::new();
    for (k, v) in &req_headers {
        let name_lower = k.as_str().to_lowercase();
        if matches!(
            name_lower.as_str(),
            "connection" | "keep-alive" | "transfer-encoding" | "accept-encoding" | "content-length"
        ) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            reqwest::header::HeaderName::from_bytes(k.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
        ) {
            forward_headers.insert(name, val);
        }
    }

    let mut req = state.http.request(req_method, target).headers(forward_headers);
    if !body_bytes.is_empty() {
        req = req.body(body_bytes);
    }

    let upstream = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            let mut resp = (StatusCode::BAD_GATEWAY, err.to_string()).into_response();
            cors_headers(resp.headers_mut());
            return resp;
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut out_headers = HeaderMap::new();
    for (k, v) in upstream.headers() {
        let lower = k.as_str().to_lowercase();
        if matches!(
            lower.as_str(),
            "transfer-encoding"
                | "connection"
                | "content-encoding"
                | "access-control-allow-origin"
                | "access-control-expose-headers"
                | "access-control-allow-credentials"
        ) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out_headers.insert(name, val);
        }
    }
    cors_headers(&mut out_headers);

    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

async fn handle_remote_http(
    State(state): State<ProxyState>,
    Path((token, id)): Path<(String, String)>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    if token != state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    if method == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        cors_headers(resp.headers_mut());
        return resp;
    }
    let Some(entry) = state.http_targets.read().get(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(target) = Url::parse(&entry.url) else {
        return (StatusCode::BAD_REQUEST, "Invalid remote URL").into_response();
    };
    let req_method = match reqwest::Method::from_bytes(method.as_str().as_bytes()) {
        Ok(m) => m,
        Err(_) => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };

    let mut forward_headers = reqwest::header::HeaderMap::new();
    for header_name in ["range", "if-range", "accept"] {
        if let Some(val) = req_headers.get(header_name) {
            if let (Ok(name), Ok(hval)) = (
                reqwest::header::HeaderName::from_bytes(header_name.as_bytes()),
                reqwest::header::HeaderValue::from_bytes(val.as_bytes()),
            ) {
                forward_headers.insert(name, hval);
            }
        }
    }
    for (k, v) in &entry.headers {
        if let (Ok(name), Ok(hval)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            forward_headers.insert(name, hval);
        }
    }

    let upstream = match state.http.request(req_method, target).headers(forward_headers).send().await {
        Ok(r) => r,
        Err(err) => {
            let mut resp = (StatusCode::BAD_GATEWAY, err.to_string()).into_response();
            cors_headers(resp.headers_mut());
            return resp;
        }
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut out_headers = HeaderMap::new();
    for (k, v) in upstream.headers() {
        let lower = k.as_str().to_lowercase();
        if matches!(
            lower.as_str(),
            "transfer-encoding"
                | "connection"
                | "content-encoding"
                | "access-control-allow-origin"
                | "access-control-expose-headers"
                | "access-control-allow-credentials"
        ) {
            continue;
        }
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out_headers.insert(name, val);
        }
    }
    if let Some(hint) = entry.content_type_hint {
        let replace_ct = out_headers
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_none_or(|ct| ct.eq_ignore_ascii_case("application/octet-stream"));
        if replace_ct {
            if let Ok(val) = HeaderValue::from_str(&hint) {
                out_headers.insert("content-type", val);
            }
        }
    }
    cors_headers(&mut out_headers);

    let stream = upstream.bytes_stream();
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

async fn handle_smb_file(
    State(state): State<ProxyState>,
    Path((token, id)): Path<(String, String)>,
    method: Method,
    req_headers: HeaderMap,
) -> Response {
    if token != state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    if method == Method::OPTIONS {
        let mut resp = StatusCode::NO_CONTENT.into_response();
        cors_headers(resp.headers_mut());
        return resp;
    }
    let Some(target) = state.smb_targets.read().get(&id).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(reader) = state.smb_reader.read().clone() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };

    const SMB_STREAM_CHUNK: u64 = 2 * 1024 * 1024;
    let range_raw = req_headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let (req_start, req_end_opt) = if let Some(ref raw) = range_raw {
        if let Some(spec) = raw.strip_prefix("bytes=") {
            if let Some((s, e)) = spec.split_once('-') {
                let start = s.parse::<u64>().unwrap_or(0);
                let end = if e.is_empty() {
                    Some(start + SMB_STREAM_CHUNK - 1)
                } else {
                    e.parse::<u64>().ok()
                };
                (start, end)
            } else {
                (0, Some(SMB_STREAM_CHUNK - 1))
            }
        } else {
            (0, Some(SMB_STREAM_CHUNK - 1))
        }
    } else {
        (0, None)
    };

    let (bytes, total) = match reader(target.rel_path, req_start, req_end_opt).await {
        Ok(res) => res,
        Err(err) => {
            let mut resp = (StatusCode::BAD_GATEWAY, err.to_string()).into_response();
            cors_headers(resp.headers_mut());
            return resp;
        }
    };

    if total > 0 && req_start >= total {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }

    let len = bytes.len() as u64;
    let partial = range_raw.is_some();
    let end = req_start + len.saturating_sub(1);

    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static(target.mime));
    headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if let Ok(cl) = HeaderValue::from_str(&len.to_string()) {
        headers.insert("content-length", cl);
    }
    if partial && total > 0 {
        if let Ok(cr) = HeaderValue::from_str(&format!("bytes {req_start}-{end}/{total}")) {
            headers.insert("content-range", cr);
        }
    }
    cors_headers(&mut headers);

    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    *resp.headers_mut() = headers;
    resp
}

async fn handle_local_file(
    State(state): State<ProxyState>,
    Path((token, id)): Path<(String, String)>,
    req_headers: HeaderMap,
) -> Response {
    if token != state.token {
        return StatusCode::FORBIDDEN.into_response();
    }
    let path = match state.local_files.read().get(&id).cloned() {
        Some(p) => p,
        None => return StatusCode::NOT_FOUND.into_response(),
    };
    let mut file = match File::open(&path).await {
        Ok(f) => f,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let total = match file.metadata().await {
        Ok(m) => m.len(),
        Err(_) => return StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    };
    let mime = mime_for_path(&path);

    let (start, end, partial) = match req_headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_range_header(r, total))
    {
        Some((s, e)) => (s, e, true),
        None => (0, total.saturating_sub(1), false),
    };

    if start >= total && total > 0 {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }

    let len = if total == 0 { 0 } else { end - start + 1 };
    let mut buf = vec![0u8; len as usize];
    if len > 0 {
        if file.seek(SeekFrom::Start(start)).await.is_err()
            || file.read_exact(&mut buf).await.is_err()
        {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    }

    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static(mime));
    headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if let Ok(cl) = HeaderValue::from_str(&len.to_string()) {
        headers.insert("content-length", cl);
    }
    if partial {
        if let Ok(cr) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
            headers.insert("content-range", cr);
        }
    }
    cors_headers(&mut headers);

    let mut resp = Response::new(Body::from(buf));
    *resp.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    *resp.headers_mut() = headers;
    resp
}

fn parse_range_header(raw: &str, total: u64) -> Option<(u64, u64)> {
    let spec = raw.strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    if s.is_empty() {
        let suffix: u64 = e.parse().ok()?;
        let start = total.saturating_sub(suffix);
        Some((start, total - 1))
    } else {
        let start: u64 = s.parse().ok()?;
        let end = if e.is_empty() {
            total - 1
        } else {
            e.parse::<u64>().ok()?.min(total - 1)
        };
        if start <= end {
            Some((start, end))
        } else {
            None
        }
    }
}

fn mime_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("webm") | Some("opus") => "audio/webm",
        Some("m4a") | Some("mp4") | Some("aac") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("mp3") => "audio/mpeg",
        Some("ogg") => "audio/ogg",
        Some("wav") => "audio/wav",
        Some("aif") | Some("aiff") => "audio/aiff",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::get;

    #[test]
    fn visionos_rule_strips_origin_and_referer() {
        let url = Url::parse("https://rr1---sn.googlevideo.com/videoplayback?itag=251&c=VISIONOS")
            .unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("origin", HeaderValue::from_static("http://localhost:5173"));
        headers.insert("referer", HeaderValue::from_static("http://localhost:5173/"));
        rewrite_request_headers(&url, &mut headers);
        assert!(headers.get("origin").is_none());
        assert!(headers.get("referer").is_none());
    }

    #[test]
    fn non_visionos_googlevideo_sets_youtube_origin() {
        let url = Url::parse("https://rr1---sn.googlevideo.com/videoplayback?itag=251&c=WEB_REMIX")
            .unwrap();
        let mut headers = HeaderMap::new();
        rewrite_request_headers(&url, &mut headers);
        assert_eq!(headers.get("origin").unwrap(), "https://www.youtube.com");
        assert_eq!(headers.get("referer").unwrap(), "https://www.youtube.com/");
    }

    #[tokio::test]
    async fn proxy_forwards_range_requests_with_cors_headers() {
        let mock = Router::new().route(
            "/chunk",
            get(|headers: HeaderMap| async move {
                let range = headers
                    .get("range")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                (
                    StatusCode::PARTIAL_CONTENT,
                    [("content-range", "bytes 0-3/10")],
                    format!("R:{range}"),
                )
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

        let client = reqwest::Client::new();
        let proxy = LoopbackProxy::start_with_options(client.clone(), true)
            .await
            .unwrap();
        let target = format!("http://127.0.0.1:{}/chunk", mock_addr.port());
        let encoded = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("url", &target)
            .finish();
        let resp = client
            .get(format!("{}/proxy?{encoded}", proxy.base_url()))
            .header("Range", "bytes=0-3")
            .send()
            .await
            .unwrap();

        assert_eq!(resp.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "*"
        );
        assert_eq!(resp.text().await.unwrap(), "R:bytes=0-3");
    }

    #[tokio::test]
    async fn remote_http_and_smb_targets_inject_auth_and_serve_ranges() {
        let mock = Router::new().route(
            "/dav/track.flac",
            get(|headers: HeaderMap| async move {
                if headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    != Some("Basic dXNlcjpwYXNz")
                {
                    return StatusCode::UNAUTHORIZED.into_response();
                }
                (StatusCode::OK, b"FLAC-OK".to_vec()).into_response()
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mock_addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });

        let client = reqwest::Client::new();
        let proxy = LoopbackProxy::start_with_options(client.clone(), true)
            .await
            .unwrap();
        let mut hdrs = HashMap::new();
        hdrs.insert("Authorization".to_string(), "Basic dXNlcjpwYXNz".to_string());
        let http_url = proxy.register_http_target(
            "dav-1".to_string(),
            format!("http://127.0.0.1:{}/dav/track.flac", mock_addr.port()),
            hdrs,
            Some("audio/flac".to_string()),
        );
        let resp = client.get(http_url).send().await.unwrap();
        assert_eq!(resp.status(), reqwest::StatusCode::OK);
        assert_eq!(resp.bytes().await.unwrap().as_ref(), b"FLAC-OK");

        proxy.set_smb_reader(Arc::new(|rel_path, start, end_opt| {
            Box::pin(async move {
                assert_eq!(rel_path, "Album/song.wav");
                let payload = b"0123456789".to_vec();
                let end = end_opt.unwrap_or(9).min(9) as usize;
                Ok((payload[start as usize..=end].to_vec(), 10))
            })
        }));
        let smb_url = proxy.register_smb_target("smb-1".to_string(), "Album/song.wav".to_string());
        let smb_resp = client
            .get(smb_url)
            .header("Range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(smb_resp.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            smb_resp.headers().get("content-range").unwrap(),
            "bytes 2-5/10"
        );
        assert_eq!(smb_resp.bytes().await.unwrap().as_ref(), b"2345");
    }
}
