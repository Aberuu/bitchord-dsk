use anyhow::{anyhow, Result};
use core_auth::youtube::{decode_request_body, serialize_response, HttpResponsePayload};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use std::collections::HashMap;
use url::Url;

const LYRIC_HOSTS: &[&str] = &[
    "mobileservice.kugou.com",
    "lyrics.kugou.com",
    "apic.musixmatch.com",
    "www.musixmatch.com",
    "genius.com",
    "music.apple.com",
    "amp-api.music.apple.com",
    "api.paxsenix.org",
    "lyrics.paxsenix.org",
    "lyrics-api.boidu.dev",
    "unison.boidu.dev",
    "lrc.red",
    "lyrics-api.binimum.org",
    "lrclib.net",
    "lyricsplus.prjktla.my.id",
    "lyricsplus.binimum.org",
    "translate.googleapis.com",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestParams {
    pub url: String,
    pub method: Option<String>,
    pub headers: Option<HashMap<String, String>>,
    pub body: Option<String>,
    pub body_encoding: Option<String>,
}

pub struct LyricsProxy {
    http: reqwest::Client,
}

impl LyricsProxy {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    pub async fn fetch_lyrics(&self, params: HttpRequestParams) -> Result<HttpResponsePayload> {
        let parsed = Url::parse(&params.url)?;
        let host = parsed.host_str().unwrap_or("");
        if parsed.scheme() != "https" || !LYRIC_HOSTS.contains(&host) {
            return Err(anyhow!(
                "forbidden: lyrics.fetch does not serve {}",
                parsed.origin().ascii_serialization()
            ));
        }

        let mut headers = build_headers(params.headers.as_ref());
        // Match the browser extension's session rules for Apple Music and Musixmatch.
        if host == "amp-api.music.apple.com" || host == "music.apple.com" {
            headers.insert("origin", HeaderValue::from_static("https://music.apple.com"));
            headers.insert("referer", HeaderValue::from_static("https://music.apple.com/"));
        } else if host == "apic.musixmatch.com" || host == "www.musixmatch.com" {
            if !headers.contains_key("cookie") {
                headers.insert("cookie", HeaderValue::from_static("mxm_bab=AB"));
            }
        }

        self.send(params, headers).await
    }

    pub async fn fetch_addon(&self, params: HttpRequestParams) -> Result<HttpResponsePayload> {
        let parsed = Url::parse(&params.url)?;
        if parsed.scheme() != "https" && parsed.scheme() != "http" {
            return Err(anyhow!("forbidden: addon.fetch requires http or https"));
        }
        let headers = build_headers(params.headers.as_ref());
        self.send(params, headers).await
    }

    async fn send(
        &self,
        params: HttpRequestParams,
        headers: HeaderMap,
    ) -> Result<HttpResponsePayload> {
        let method = reqwest::Method::from_bytes(
            params.method.as_deref().unwrap_or("GET").as_bytes(),
        )?;
        let mut req = self.http.request(method, &params.url).headers(headers);
        if let Some(body) =
            decode_request_body(params.body.as_deref(), params.body_encoding.as_deref())?
        {
            req = req.body(body);
        }
        let resp = req.send().await?;
        serialize_response(resp).await
    }
}

fn build_headers(raw: Option<&HashMap<String, String>>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Some(map) = raw {
        for (k, v) in map {
            if let (Ok(name), Ok(val)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
    }
    headers
}
