use crate::cast::types::{CastDevice, CastSessionState};
use anyhow::{anyhow, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

const UPNP_AVT_NS: &str = "urn:schemas-upnp-org:service:AVTransport:1";
const UPNP_RC_NS: &str = "urn:schemas-upnp-org:service:RenderingControl:1";

fn xml_escape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}

pub fn format_dlna_time(seconds: f64) -> String {
    let secs = seconds.max(0.0).round() as u64;
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    format!("{h:02}:{m:02}:{s:02}")
}

pub fn parse_dlna_time(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "NOT_IMPLEMENTED" {
        return 0.0;
    }
    let clean = trimmed.split('.').next().unwrap_or(trimmed);
    let parts: Vec<f64> = clean
        .split(':')
        .filter_map(|p| p.parse::<f64>().ok())
        .collect();
    match parts.as_slice() {
        [h, m, s] => h * 3600.0 + m * 60.0 + s,
        [m, s] => m * 60.0 + s,
        [s] => *s,
        _ => 0.0,
    }
}

pub fn build_didl_lite(
    title: &str,
    artist: &str,
    album: Option<&str>,
    artwork_url: Option<&str>,
    media_url: &str,
    mime_type: &str,
) -> String {
    let clean_mime = mime_type.split(';').next().unwrap_or("audio/mp4").trim();
    let album_tag = album
        .filter(|a| !a.trim().is_empty())
        .map(|a| format!("<upnp:album>{}</upnp:album>", xml_escape(a)))
        .unwrap_or_default();
    let art_tag = artwork_url
        .map(|u| format!("<upnp:albumArtURI>{}</upnp:albumArtURI>", xml_escape(u)))
        .unwrap_or_default();
    let proto = format!(
        "http-get:*:{}:DLNA.ORG_OP=01;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000",
        xml_escape(clean_mime)
    );

    format!(
        r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>{}</dc:title><upnp:artist>{}</upnp:artist>{}{}<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="{}">{}</res></item></DIDL-Lite>"#,
        xml_escape(title),
        xml_escape(artist),
        album_tag,
        art_tag,
        proto,
        xml_escape(media_url),
    )
}

async fn soap_call(
    http: &reqwest::Client,
    control_url: &str,
    service_ns: &str,
    action: &str,
    args_xml: &str,
) -> Result<String> {
    let envelope = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:{action} xmlns:u="{service_ns}">{args_xml}</u:{action}></s:Body></s:Envelope>"#
    );
    let resp = http
        .post(control_url)
        .timeout(Duration::from_secs(4))
        .header("content-type", "text/xml; charset=\"utf-8\"")
        .header("soapaction", format!("\"{service_ns}#{action}\""))
        .body(envelope)
        .send()
        .await?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("DLNA {action} failed ({status})"));
    }
    Ok(body)
}

fn read_xml_tag(xml: &str, target: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut inside = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                inside = e.name().as_ref().eq_ignore_ascii_case(target);
            }
            Ok(Event::End(_)) => inside = false,
            Ok(Event::Text(t)) if inside => {
                let raw = t.into_inner();
                return Some(
                    quick_xml::escape::unescape(&raw)
                        .map(|s| s.into_owned())
                        .unwrap_or_else(|_| raw.into_owned()),
                );
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    None
}

pub enum DlnaCmd {
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
pub struct DlnaMeta {
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

pub async fn start_dlna_session(
    http: reqwest::Client,
    device: CastDevice,
    initial_media: DlnaMeta,
    on_state: Arc<dyn Fn(CastSessionState) + Send + Sync>,
    on_track_ended: Arc<dyn Fn(String) + Send + Sync>,
) -> Result<mpsc::Sender<DlnaCmd>> {
    let av_url = device
        .av_transport_url
        .clone()
        .ok_or_else(|| anyhow!("Missing AVTransport control URL"))?;
    let rc_url = device.rendering_control_url.clone();

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<DlnaCmd>(32);

    tokio::spawn(async move {
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

        let load_on_tv = |http: reqwest::Client, av_url: String, meta: DlnaMeta| async move {
            let didl = build_didl_lite(
                &meta.title,
                &meta.artist,
                meta.album.as_deref(),
                meta.artwork_url.as_deref(),
                &meta.media_url,
                &meta.mime_type,
            );
            let args = format!(
                "<InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData>",
                xml_escape(&meta.media_url),
                xml_escape(&didl),
            );
            soap_call(&http, &av_url, UPNP_AVT_NS, "SetAVTransportURI", &args).await?;
            if meta.autoplay {
                soap_call(
                    &http,
                    &av_url,
                    UPNP_AVT_NS,
                    "Play",
                    "<InstanceID>0</InstanceID><Speed>1</Speed>",
                )
                .await?;
            }
            if meta.start_sec > 1.0 {
                let target = format_dlna_time(meta.start_sec);
                let _ = soap_call(
                    &http,
                    &av_url,
                    UPNP_AVT_NS,
                    "Seek",
                    &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{target}</Target>"),
                )
                .await;
            }
            Ok::<_, anyhow::Error>(())
        };

        let mut saw_playing = initial_media.autoplay;
        if let Err(err) = load_on_tv(http.clone(), av_url.clone(), initial_media).await {
            session.connected = false;
            session.connecting = false;
            session.status = "error".to_string();
            session.error = Some(err.to_string());
            on_state(session);
            return;
        }

        session.connecting = false;
        session.status = if saw_playing { "playing" } else { "paused" }.to_string();
        on_state(session.clone());

        let mut poll = tokio::time::interval(Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = poll.tick() => {
                    if let Ok(t_xml) = soap_call(&http, &av_url, UPNP_AVT_NS, "GetTransportInfo", "<InstanceID>0</InstanceID>").await {
                        let tstate = read_xml_tag(&t_xml, "CurrentTransportState").unwrap_or_default();
                        match tstate.as_str() {
                            "PLAYING" => {
                                saw_playing = true;
                                session.status = "playing".to_string();
                            }
                            "PAUSED_PLAYBACK" => session.status = "paused".to_string(),
                            "TRANSITIONING" => session.status = "buffering".to_string(),
                            "STOPPED" => {
                                session.status = "idle".to_string();
                                if saw_playing {
                                    saw_playing = false;
                                    on_state(session.clone());
                                    if let Some(finished_id) = session.track_id.clone() {
                                        on_track_ended(finished_id);
                                    }
                                    continue;
                                }
                            }
                            _ => {}
                        }
                    }
                    if let Ok(p_xml) = soap_call(&http, &av_url, UPNP_AVT_NS, "GetPositionInfo", "<InstanceID>0</InstanceID>").await {
                        if let Some(rel) = read_xml_tag(&p_xml, "RelTime") {
                            session.position_sec = parse_dlna_time(&rel);
                        }
                        if let Some(dur) = read_xml_tag(&p_xml, "TrackDuration") {
                            let parsed = parse_dlna_time(&dur);
                            if parsed > 0.0 {
                                session.duration_sec = parsed;
                            }
                        }
                    }
                    on_state(session.clone());
                }
                cmd = cmd_rx.recv() => {
                    let Some(cmd) = cmd else { break };
                    match cmd {
                        DlnaCmd::Load {
                            track_id, media_url, mime_type, title, artist, album, artwork_url,
                            duration_sec, start_sec, autoplay,
                        } => {
                            let meta = DlnaMeta {
                                track_id: track_id.clone(), media_url, mime_type, title, artist,
                                album, artwork_url, duration_sec, start_sec, autoplay,
                            };
                            saw_playing = false;
                            session.track_id = Some(track_id);
                            session.status = "loading".to_string();
                            session.position_sec = start_sec;
                            session.duration_sec = duration_sec;
                            on_state(session.clone());
                            if load_on_tv(http.clone(), av_url.clone(), meta).await.is_ok() {
                                saw_playing = autoplay;
                                session.status = if autoplay { "playing" } else { "paused" }.to_string();
                            } else {
                                session.status = "error".to_string();
                            }
                            on_state(session.clone());
                        }
                        DlnaCmd::Play => {
                            if soap_call(&http, &av_url, UPNP_AVT_NS, "Play", "<InstanceID>0</InstanceID><Speed>1</Speed>").await.is_ok() {
                                saw_playing = true;
                                session.status = "playing".to_string();
                                on_state(session.clone());
                            }
                        }
                        DlnaCmd::Pause => {
                            if soap_call(&http, &av_url, UPNP_AVT_NS, "Pause", "<InstanceID>0</InstanceID>").await.is_ok() {
                                session.status = "paused".to_string();
                                on_state(session.clone());
                            }
                        }
                        DlnaCmd::Seek(sec) => {
                            let target = format_dlna_time(sec);
                            if soap_call(&http, &av_url, UPNP_AVT_NS, "Seek", &format!("<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{target}</Target>")).await.is_ok() {
                                session.position_sec = sec.max(0.0);
                                on_state(session.clone());
                            }
                        }
                        DlnaCmd::SetVolume(vol) => {
                            let level = vol.clamp(0.0, 1.0);
                            session.volume = level;
                            on_state(session.clone());
                            if let Some(rc) = rc_url.as_deref() {
                                let pct = (level * 100.0).round() as u32;
                                let _ = soap_call(
                                    &http,
                                    rc,
                                    UPNP_RC_NS,
                                    "SetVolume",
                                    &format!("<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{pct}</DesiredVolume>"),
                                ).await;
                            }
                        }
                        DlnaCmd::Disconnect => {
                            let _ = soap_call(&http, &av_url, UPNP_AVT_NS, "Stop", "<InstanceID>0</InstanceID>").await;
                            break;
                        }
                    }
                }
            }
        }

        on_state(CastSessionState::default());
    });

    Ok(cmd_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_and_parses_dlna_timestamps() {
        assert_eq!(format_dlna_time(3723.0), "01:02:03");
        assert_eq!(parse_dlna_time("01:02:03"), 3723.0);
        assert_eq!(parse_dlna_time("03:45.5"), 225.0);
    }

    #[test]
    fn builds_escaped_didl_lite_metadata() {
        let xml = build_didl_lite(
            "Rock & Roll",
            "Artist <1>",
            Some("Album \"A\""),
            Some("http://192.168.1.5:8080/art?a=1&b=2"),
            "http://192.168.1.5:8080/stream.m4a",
            "audio/mp4; codecs=\"mp4a.40.2\"",
        );
        assert!(xml.contains("<dc:title>Rock &amp; Roll</dc:title>"));
        assert!(xml.contains("<upnp:artist>Artist &lt;1&gt;</upnp:artist>"));
        assert!(xml.contains("<upnp:album>Album &quot;A&quot;</upnp:album>"));
        assert!(xml.contains("http-get:*:audio/mp4:DLNA.ORG_OP=01"));
    }
}
