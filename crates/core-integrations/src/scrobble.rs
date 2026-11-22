use anyhow::{anyhow, Result};
use core_auth::SecretVault;
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_LASTFM_ENDPOINT: &str = "https://ws.audioscrobbler.com/2.0/";
pub const LIBREFM_ENDPOINT: &str = "https://libre.fm/2.0/";
const LISTENBRAINZ_URL: &str = "https://api.listenbrainz.org/1/submit-listens";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleState {
    pub lastfm_configured: bool,
    pub lastfm_connected: bool,
    pub lastfm_username: Option<String>,
    pub lastfm_endpoint: String,
    pub listenbrainz_connected: bool,
    pub primary_artist_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleConfigUpdate {
    pub lastfm_endpoint: Option<String>,
    pub lastfm_api_key: Option<String>,
    pub lastfm_api_secret: Option<String>,
    pub listenbrainz_token: Option<String>,
    pub primary_artist_only: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrobbleTrack {
    pub title: String,
    pub artist: String,
    pub album: Option<String>,
    pub duration_ms: Option<u64>,
    pub position_ms: Option<u64>,
    pub started_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastFmTokenAuth {
    pub token: String,
    pub auth_url: String,
}

pub struct ScrobbleService {
    vault: Arc<SecretVault>,
    http: reqwest::Client,
}

impl ScrobbleService {
    pub fn new(vault: Arc<SecretVault>, http: reqwest::Client) -> Self {
        Self { vault, http }
    }

    pub fn state(&self) -> ScrobbleState {
        let snap = self.vault.snapshot();
        ScrobbleState {
            lastfm_configured: snap.lastfm_api_key.as_deref().is_some_and(|s| !s.is_empty())
                && snap.lastfm_api_secret.as_deref().is_some_and(|s| !s.is_empty()),
            lastfm_connected: snap.lastfm_session_key.is_some(),
            lastfm_username: snap.lastfm_username,
            lastfm_endpoint: snap
                .lastfm_endpoint
                .unwrap_or_else(|| DEFAULT_LASTFM_ENDPOINT.to_string()),
            listenbrainz_connected: snap
                .listenbrainz_token
                .as_deref()
                .is_some_and(|s| !s.is_empty()),
            primary_artist_only: snap.scrobble_primary_artist_only,
        }
    }

    pub fn update_config(&self, update: ScrobbleConfigUpdate) -> Result<ScrobbleState> {
        self.vault.update(|data| {
            if let Some(ep) = update.lastfm_endpoint {
                data.lastfm_endpoint = if ep.trim().is_empty() {
                    None
                } else {
                    Some(ep.trim().to_string())
                };
            }
            if let Some(key) = update.lastfm_api_key {
                data.lastfm_api_key = if key.trim().is_empty() {
                    None
                } else {
                    Some(key.trim().to_string())
                };
            }
            if let Some(secret) = update.lastfm_api_secret {
                data.lastfm_api_secret = if secret.trim().is_empty() {
                    None
                } else {
                    Some(secret.trim().to_string())
                };
            }
            if let Some(lb) = update.listenbrainz_token {
                data.listenbrainz_token = if lb.trim().is_empty() {
                    None
                } else {
                    Some(lb.trim().to_string())
                };
            }
            if let Some(primary) = update.primary_artist_only {
                data.scrobble_primary_artist_only = primary;
            }
        })?;
        Ok(self.state())
    }

    pub fn disconnect_lastfm(&self) -> Result<ScrobbleState> {
        self.vault.update(|data| {
            data.lastfm_session_key = None;
            data.lastfm_username = None;
        })?;
        Ok(self.state())
    }

    pub async fn lastfm_start_auth(&self) -> Result<LastFmTokenAuth> {
        let snap = self.vault.snapshot();
        let api_key = snap
            .lastfm_api_key
            .ok_or_else(|| anyhow!("Configure a Last.fm API key first"))?;
        let api_secret = snap
            .lastfm_api_secret
            .ok_or_else(|| anyhow!("Configure a Last.fm API secret first"))?;
        let endpoint = snap
            .lastfm_endpoint
            .unwrap_or_else(|| DEFAULT_LASTFM_ENDPOINT.to_string());

        let resp = self
            .lastfm_call(&endpoint, "auth.getToken", &api_key, &api_secret, None, BTreeMap::new())
            .await?;
        let token = resp
            .get("token")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Last.fm did not return an auth token"))?
            .to_string();
        let auth_base = if endpoint.contains("libre.fm") {
            "https://libre.fm/api/auth/"
        } else {
            "https://www.last.fm/api/auth/"
        };
        let auth_url = format!("{auth_base}?api_key={api_key}&token={token}");
        Ok(LastFmTokenAuth { token, auth_url })
    }

    pub async fn lastfm_finish_auth(&self, token: &str) -> Result<ScrobbleState> {
        let snap = self.vault.snapshot();
        let api_key = snap
            .lastfm_api_key
            .ok_or_else(|| anyhow!("Missing Last.fm API key"))?;
        let api_secret = snap
            .lastfm_api_secret
            .ok_or_else(|| anyhow!("Missing Last.fm API secret"))?;
        let endpoint = snap
            .lastfm_endpoint
            .unwrap_or_else(|| DEFAULT_LASTFM_ENDPOINT.to_string());

        let mut extra = BTreeMap::new();
        extra.insert("token".into(), token.to_string());
        let resp = self
            .lastfm_call(&endpoint, "auth.getSession", &api_key, &api_secret, None, extra)
            .await?;
        let session = resp
            .get("session")
            .ok_or_else(|| anyhow!("Last.fm authorization has not been completed yet"))?;
        let key = session
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("Missing Last.fm session key"))?
            .to_string();
        let name = session
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Last.fm")
            .to_string();
        self.vault.update(|data| {
            data.lastfm_session_key = Some(key);
            data.lastfm_username = Some(name);
        })?;
        Ok(self.state())
    }

    pub async fn update_now_playing(&self, track: ScrobbleTrack) {
        let snap = self.vault.snapshot();
        let artist = normalize_artist(&track.artist, snap.scrobble_primary_artist_only);

        if let (Some(api_key), Some(api_secret), Some(sk)) = (
            snap.lastfm_api_key.as_deref(),
            snap.lastfm_api_secret.as_deref(),
            snap.lastfm_session_key.as_deref(),
        ) {
            let endpoint = snap
                .lastfm_endpoint
                .as_deref()
                .unwrap_or(DEFAULT_LASTFM_ENDPOINT);
            let mut extra = BTreeMap::new();
            extra.insert("artist".into(), artist.clone());
            extra.insert("track".into(), track.title.clone());
            if let Some(album) = track.album.as_deref().filter(|a| !a.trim().is_empty()) {
                extra.insert("album".into(), album.to_string());
            }
            if let Some(dur) = track.duration_ms.filter(|d| *d > 0) {
                extra.insert("duration".into(), (dur / 1000).to_string());
            }
            let _ = self
                .lastfm_call(endpoint, "track.updateNowPlaying", api_key, api_secret, Some(sk), extra)
                .await;
        }

        if let Some(token) = snap.listenbrainz_token.as_deref().filter(|t| !t.is_empty()) {
            let payload = listenbrainz_playing_now_payload(&track, &artist);
            let _ = self
                .http
                .post(LISTENBRAINZ_URL)
                .header("Authorization", format!("Token {token}"))
                .json(&payload)
                .send()
                .await;
        }
    }

    pub async fn scrobble(&self, track: ScrobbleTrack) {
        let snap = self.vault.snapshot();
        let artist = normalize_artist(&track.artist, snap.scrobble_primary_artist_only);
        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let started_secs = track
            .started_at_ms
            .map(|ms| ms / 1000)
            .filter(|ts| *ts >= 1_033_430_400)
            .unwrap_or(now_secs);

        if let (Some(api_key), Some(api_secret), Some(sk)) = (
            snap.lastfm_api_key.as_deref(),
            snap.lastfm_api_secret.as_deref(),
            snap.lastfm_session_key.as_deref(),
        ) {
            let endpoint = snap
                .lastfm_endpoint
                .as_deref()
                .unwrap_or(DEFAULT_LASTFM_ENDPOINT);
            let mut extra = BTreeMap::new();
            extra.insert("artist".into(), artist.clone());
            extra.insert("track".into(), track.title.clone());
            extra.insert("timestamp".into(), started_secs.to_string());
            if let Some(album) = track.album.as_deref().filter(|a| !a.trim().is_empty()) {
                extra.insert("album".into(), album.to_string());
            }
            if let Some(dur) = track.duration_ms.filter(|d| *d > 0) {
                extra.insert("duration".into(), (dur / 1000).to_string());
            }
            let _ = self
                .lastfm_call(endpoint, "track.scrobble", api_key, api_secret, Some(sk), extra)
                .await;
        }

        if let Some(token) = snap.listenbrainz_token.as_deref().filter(|t| !t.is_empty()) {
            let payload = listenbrainz_single_payload(&track, &artist, started_secs);
            let _ = self
                .http
                .post(LISTENBRAINZ_URL)
                .header("Authorization", format!("Token {token}"))
                .json(&payload)
                .send()
                .await;
        }
    }

    async fn lastfm_call(
        &self,
        endpoint: &str,
        method: &str,
        api_key: &str,
        api_secret: &str,
        session_key: Option<&str>,
        extra: BTreeMap<String, String>,
    ) -> Result<Value> {
        let mut params = BTreeMap::new();
        params.insert("method".into(), method.to_string());
        params.insert("api_key".into(), api_key.to_string());
        if let Some(sk) = session_key {
            params.insert("sk".into(), sk.to_string());
        }
        for (k, v) in extra {
            params.insert(k, v);
        }
        let sig = lastfm_api_sig(&params, api_secret);
        let mut form: Vec<(String, String)> = params.into_iter().collect();
        form.push(("api_sig".into(), sig));
        form.push(("format".into(), "json".into()));

        let resp = self
            .http
            .post(endpoint)
            .header(
                "User-Agent",
                "BitChord (https://github.com/kushagrasinghx/BitChord)",
            )
            .form(&form)
            .send()
            .await?;
        let body = resp.json::<Value>().await?;
        if let Some(code) = body.get("error").and_then(Value::as_i64) {
            let msg = body
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Last.fm error");
            return Err(anyhow!("Last.fm error {code}: {msg}"));
        }
        Ok(body)
    }
}

pub fn lastfm_api_sig(params: &BTreeMap<String, String>, secret: &str) -> String {
    let mut joined = String::new();
    for (k, v) in params {
        joined.push_str(k);
        joined.push_str(v);
    }
    joined.push_str(secret);
    let mut hasher = Md5::new();
    hasher.update(joined.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn normalize_artist(artist: &str, primary_only: bool) -> String {
    if !primary_only {
        return artist.trim().to_string();
    }
    for sep in [", ", " & ", " feat. ", " ft. ", " x ", " / "] {
        if let Some((first, _)) = artist.split_once(sep) {
            let trimmed = first.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    artist.trim().to_string()
}

pub fn listenbrainz_playing_now_payload(track: &ScrobbleTrack, artist: &str) -> Value {
    let mut info = serde_json::Map::new();
    if let Some(dur) = track.duration_ms.filter(|d| *d > 0) {
        info.insert("duration_ms".into(), json!(dur));
    }
    info.insert(
        "position_ms".into(),
        json!(track.position_ms.unwrap_or(0)),
    );
    info.insert("submission_client".into(), json!("BitChord"));

    let mut meta = serde_json::Map::new();
    meta.insert("artist_name".into(), json!(artist));
    meta.insert("track_name".into(), json!(track.title));
    if let Some(album) = track.album.as_deref().filter(|a| !a.trim().is_empty()) {
        meta.insert("release_name".into(), json!(album));
    }
    meta.insert("additional_info".into(), Value::Object(info));

    json!({
        "listen_type": "playing_now",
        "payload": [{ "track_metadata": Value::Object(meta) }]
    })
}

pub fn listenbrainz_single_payload(
    track: &ScrobbleTrack,
    artist: &str,
    listened_at: u64,
) -> Value {
    let mut info = serde_json::Map::new();
    if let Some(dur) = track.duration_ms.filter(|d| *d > 0) {
        info.insert("duration_ms".into(), json!(dur));
    }
    info.insert("submission_client".into(), json!("BitChord"));

    let mut meta = serde_json::Map::new();
    meta.insert("artist_name".into(), json!(artist));
    meta.insert("track_name".into(), json!(track.title));
    if let Some(album) = track.album.as_deref().filter(|a| !a.trim().is_empty()) {
        meta.insert("release_name".into(), json!(album));
    }
    meta.insert("additional_info".into(), Value::Object(info));

    json!({
        "listen_type": "single",
        "payload": [{
            "listened_at": listened_at,
            "track_metadata": Value::Object(meta)
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lastfm_signature_sorts_keys_lexicographically() {
        let mut params = BTreeMap::new();
        params.insert("method".into(), "auth.getToken".into());
        params.insert("api_key".into(), "key123".into());
        let sig = lastfm_api_sig(&params, "sec456");
        let expected = format!(
            "{:x}",
            Md5::digest(b"api_keykey123methodauth.getTokensec456")
        );
        assert_eq!(sig, expected);
    }

    #[test]
    fn normalizes_primary_artist_when_enabled() {
        assert_eq!(normalize_artist("Daft Punk, Pharrell Williams", true), "Daft Punk");
        assert_eq!(
            normalize_artist("Daft Punk, Pharrell Williams", false),
            "Daft Punk, Pharrell Williams"
        );
    }
}
