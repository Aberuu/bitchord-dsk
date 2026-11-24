use crate::cast::probe::best_local_ip_for_peer;
use anyhow::Result;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use futures_util::stream;
use parking_lot::RwLock;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::fs::File;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

#[derive(Clone)]
pub struct ActiveRelayMedia {
    pub token: String,
    pub local_file: Option<PathBuf>,
    pub remote_stream_url: Option<String>,
    pub mime_type: String,
    pub artwork_url: Option<String>,
}

#[derive(Clone)]
struct RelayState {
    http: reqwest::Client,
    active: Arc<RwLock<Option<ActiveRelayMedia>>>,
    allow_loopback_upstream: bool,
}

pub struct CastMediaRelay {
    http: reqwest::Client,
    active: Arc<RwLock<Option<ActiveRelayMedia>>>,
    port: RwLock<Option<u16>>,
    allow_loopback_upstream: bool,
}

impl CastMediaRelay {
    pub fn new(http: reqwest::Client) -> Self {
        Self::new_with_options(http, false)
    }

    fn new_with_options(http: reqwest::Client, allow_loopback_upstream: bool) -> Self {
        Self {
            http,
            active: Arc::new(RwLock::new(None)),
            port: RwLock::new(None),
            allow_loopback_upstream,
        }
    }

    pub async fn ensure_started(&self) -> Result<u16> {
        if let Some(p) = *self.port.read() {
            return Ok(p);
        }
        let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], 0))).await?;
        let port = listener.local_addr()?.port();
        let state = RelayState {
            http: self.http.clone(),
            active: Arc::clone(&self.active),
            allow_loopback_upstream: self.allow_loopback_upstream,
        };
        let app = Router::new()
            .route(
                "/cast/{token}/{filename}",
                get(handle_media_get).head(handle_media_head),
            )
            .route("/cast/{token}/artwork", get(handle_artwork_get))
            .with_state(state);

        tokio::spawn(async move {
            if let Err(err) = axum::serve(listener, app).await {
                tracing::error!("Cast media relay stopped: {err}");
            }
        });

        *self.port.write() = Some(port);
        Ok(port)
    }

    pub async fn register_media(
        &self,
        peer_host: &str,
        local_file: Option<PathBuf>,
        remote_stream_url: Option<String>,
        mime_type: String,
        artwork_url: Option<String>,
    ) -> Result<(String, Option<String>)> {
        let port = self.ensure_started().await?;
        let local_ip = best_local_ip_for_peer(peer_host)
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let token = Uuid::new_v4().simple().to_string();
        let ext = extension_for_mime(&mime_type, local_file.as_deref());

        let has_art = artwork_url
            .as_deref()
            .map(|u| u.starts_with("http://") || u.starts_with("https://"))
            .unwrap_or(false);

        *self.active.write() = Some(ActiveRelayMedia {
            token: token.clone(),
            local_file,
            remote_stream_url,
            mime_type,
            artwork_url,
        });

        let base = format!("http://{local_ip}:{port}/cast/{token}");
        let media_url = format!("{base}/stream.{ext}");
        let art_url = if has_art {
            Some(format!("{base}/artwork"))
        } else {
            None
        };
        Ok((media_url, art_url))
    }

    pub fn clear(&self) {
        *self.active.write() = None;
    }
}

fn extension_for_mime(mime: &str, local_file: Option<&std::path::Path>) -> &'static str {
    if let Some(ext) = local_file
        .and_then(|p| p.extension())
        .and_then(|e| e.to_str())
    {
        match ext.to_ascii_lowercase().as_str() {
            "mp3" => return "mp3",
            "flac" => return "flac",
            "wav" => return "wav",
            "ogg" => return "ogg",
            "webm" | "opus" => return "webm",
            "m4a" | "mp4" => return "m4a",
            _ => {}
        }
    }
    let lower = mime.to_ascii_lowercase();
    if lower.contains("mp4") || lower.contains("aac") {
        "m4a"
    } else if lower.contains("mpeg") || lower.contains("mp3") {
        "mp3"
    } else if lower.contains("flac") {
        "flac"
    } else if lower.contains("wav") {
        "wav"
    } else if lower.contains("ogg") {
        "ogg"
    } else if lower.contains("webm") || lower.contains("opus") {
        "webm"
    } else {
        "bin"
    }
}

fn apply_dlna_headers(headers: &mut HeaderMap) {
    headers.insert(
        "transferMode.dlna.org",
        HeaderValue::from_static("Streaming"),
    );
    headers.insert(
        "contentFeatures.dlna.org",
        HeaderValue::from_static("DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000"),
    );
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert("access-control-expose-headers", HeaderValue::from_static("*"));
}

fn is_allowed_remote_host(target: &Url, allow_loopback: bool) -> bool {
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
    matches!(host, "music.youtube.com" | "www.youtube.com" | "youtube.com")
        || host.ends_with(".googlevideo.com")
        || host.ends_with(".ytimg.com")
        || host.ends_with(".ggpht.com")
        || host.ends_with(".googleusercontent.com")
}

fn parse_range_header(raw: &str, total: u64) -> Option<(u64, u64)> {
    let spec = raw.strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }
    if s.is_empty() {
        let suffix: u64 = e.parse().ok()?;
        Some((total.saturating_sub(suffix), total - 1))
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

async fn handle_media_head(
    State(state): State<RelayState>,
    Path((token, _filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_media(state, token, headers, Method::HEAD).await
}

async fn handle_media_get(
    State(state): State<RelayState>,
    Path((token, _filename)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    serve_media(state, token, headers, Method::GET).await
}

async fn serve_media(
    state: RelayState,
    token: String,
    req_headers: HeaderMap,
    method: Method,
) -> Response {
    let entry = state.active.read().clone();
    let Some(media) = entry.filter(|m| m.token == token) else {
        return StatusCode::FORBIDDEN.into_response();
    };

    if let Some(path) = media.local_file {
        return serve_local_file(path, media.mime_type, req_headers, method == Method::HEAD).await;
    }

    if let Some(raw_url) = media.remote_stream_url {
        let Ok(target) = Url::parse(&raw_url) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        if !is_allowed_remote_host(&target, state.allow_loopback_upstream) {
            return StatusCode::FORBIDDEN.into_response();
        }
        return proxy_remote_url(&state.http, &target, &req_headers, method).await;
    }

    StatusCode::NOT_FOUND.into_response()
}

async fn handle_artwork_get(
    State(state): State<RelayState>,
    Path(token): Path<String>,
) -> Response {
    let entry = state.active.read().clone();
    let Some(media) = entry.filter(|m| m.token == token) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let Some(raw) = media.artwork_url else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(target) = Url::parse(&raw) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !is_allowed_remote_host(&target, state.allow_loopback_upstream) {
        return StatusCode::FORBIDDEN.into_response();
    }
    proxy_remote_url(&state.http, &target, &HeaderMap::new(), Method::GET).await
}

async fn serve_local_file(
    path: PathBuf,
    mime_type: String,
    req_headers: HeaderMap,
    head_only: bool,
) -> Response {
    let Ok(mut file) = File::open(&path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(meta) = file.metadata().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let total = meta.len();

    let range = req_headers
        .get("range")
        .and_then(|v| v.to_str().ok())
        .and_then(|r| parse_range_header(r, total));
    let (start, end, partial) = match range {
        Some((s, e)) => (s, e, true),
        None => (0, total.saturating_sub(1), false),
    };

    if total > 0 && start >= total {
        return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
    }
    let len = if total == 0 { 0 } else { end - start + 1 };

    let mut headers = HeaderMap::new();
    let clean_mime = mime_type.split(';').next().unwrap_or("audio/mpeg").trim();
    if let Ok(ct) = HeaderValue::from_str(clean_mime) {
        headers.insert("content-type", ct);
    }
    headers.insert("accept-ranges", HeaderValue::from_static("bytes"));
    if let Ok(cl) = HeaderValue::from_str(&len.to_string()) {
        headers.insert("content-length", cl);
    }
    if partial {
        if let Ok(cr) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
            headers.insert("content-range", cr);
        }
    }
    apply_dlna_headers(&mut headers);

    if head_only {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        };
        *resp.headers_mut() = headers;
        return resp;
    }

    if file.seek(SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    // Stream in 64 KiB chunks so large FLAC files never buffer in full.
    let byte_stream = stream::unfold((file, len), |(mut f, rem)| async move {
        if rem == 0 {
            return None;
        }
        let to_read = (rem as usize).min(64 * 1024);
        let mut buf = vec![0u8; to_read];
        match f.read(&mut buf).await {
            Ok(0) => None,
            Ok(n) => {
                buf.truncate(n);
                Some((Ok::<Bytes, std::io::Error>(Bytes::from(buf)), (f, rem - n as u64)))
            }
            Err(e) => Some((Err(e), (f, 0))),
        }
    });

    let mut resp = Response::new(Body::from_stream(byte_stream));
    *resp.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    *resp.headers_mut() = headers;
    resp
}

async fn proxy_remote_url(
    http: &reqwest::Client,
    target: &Url,
    req_headers: &HeaderMap,
    method: Method,
) -> Response {
    let mut forward = reqwest::header::HeaderMap::new();
    if let Some(range) = req_headers.get("range") {
        if let Ok(v) = reqwest::header::HeaderValue::from_bytes(range.as_bytes()) {
            forward.insert("range", v);
        }
    }
    let host = target.host_str().unwrap_or("");
    if host == "googlevideo.com" || host.ends_with(".googlevideo.com") {
        let is_visionos = target
            .query_pairs()
            .any(|(k, v)| k == "c" && v.eq_ignore_ascii_case("VISIONOS"));
        if !is_visionos {
            forward.insert(
                "origin",
                reqwest::header::HeaderValue::from_static("https://www.youtube.com"),
            );
            forward.insert(
                "referer",
                reqwest::header::HeaderValue::from_static("https://www.youtube.com/"),
            );
        }
    }

    let req_method = if method == Method::HEAD {
        reqwest::Method::HEAD
    } else {
        reqwest::Method::GET
    };

    let Ok(upstream) = http.request(req_method, target.clone()).headers(forward).send().await else {
        return StatusCode::BAD_GATEWAY.into_response();
    };

    let status = StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut out_headers = HeaderMap::new();
    for (k, v) in upstream.headers() {
        let lower = k.as_str().to_ascii_lowercase();
        if matches!(
            lower.as_str(),
            "transfer-encoding" | "connection" | "content-encoding"
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
    apply_dlna_headers(&mut out_headers);

    if method == Method::HEAD {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = status;
        *resp.headers_mut() = out_headers;
        return resp;
    }

    let mut resp = Response::new(Body::from_stream(upstream.bytes_stream()));
    *resp.status_mut() = status;
    *resp.headers_mut() = out_headers;
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streams_local_file_with_range_and_dlna_headers_and_rejects_bad_token() {
        let dir = std::env::temp_dir().join(format!("bitchord-relay-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sample_path = dir.join("sample.m4a");
        std::fs::write(&sample_path, b"0123456789ABCDEF").unwrap();

        let client = reqwest::Client::new();
        let relay = CastMediaRelay::new_with_options(client.clone(), true);
        let (url, _) = relay
            .register_media(
                "127.0.0.1",
                Some(sample_path),
                None,
                "audio/mp4".to_string(),
                None,
            )
            .await
            .unwrap();

        let local_port = relay.port.read().unwrap();
        let parsed = Url::parse(&url).unwrap();
        let path_part = parsed.path();
        let direct_url = format!("http://127.0.0.1:{local_port}{path_part}");

        let ok_resp = client
            .get(&direct_url)
            .header("Range", "bytes=4-9")
            .send()
            .await
            .unwrap();
        assert_eq!(ok_resp.status(), reqwest::StatusCode::PARTIAL_CONTENT);
        assert_eq!(ok_resp.headers().get("transferMode.dlna.org").unwrap(), "Streaming");
        assert_eq!(ok_resp.text().await.unwrap(), "456789");

        let bad_url = format!("http://127.0.0.1:{local_port}/cast/wrongtoken/stream.m4a");
        let forbidden = client.get(&bad_url).send().await.unwrap();
        assert_eq!(forbidden.status(), reqwest::StatusCode::FORBIDDEN);

        relay.clear();
        let after_clear = client.get(&direct_url).send().await.unwrap();
        assert_eq!(after_clear.status(), reqwest::StatusCode::FORBIDDEN);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
